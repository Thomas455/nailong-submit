import crypto from "node:crypto";

// ============================================================================
// 极简 R2 内存实现（只为跑测试）
// 语义对齐真实 Cloudflare R2：get 不存在返回 null，put/get/delete/list 都可用。
// 不依赖 miniflare —— 那个版本在本机的内部状态有问题。
// ============================================================================
class MemR2 {
  constructor() {
    this.map = new Map();     // key -> { data: Buffer, meta: object, expiresAt }
  }
  #key(k) { return String(k); }
  async put(key, value, opts = {}) {
    let data;
    if (value instanceof ArrayBuffer) data = Buffer.from(value);
    else if (ArrayBuffer.isView(value)) data = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    else if (typeof value === "string") data = Buffer.from(value, "utf8");
    else data = Buffer.from(await value.arrayBuffer());
    this.map.set(this.#key(key), {
      data,
      meta: (opts && opts.httpMetadata) || {},
      expiresAt: (opts && opts.expirationTtl)
        ? Date.now() + opts.expirationTtl * 1000 : null
    });
  }
  async get(key) {
    const e = this.map.get(this.#key(key));
    if (!e) return null;
    if (e.expiresAt && Date.now() > e.expiresAt) { this.map.delete(this.#key(key)); return null; }
    const buf = e.data;
    return {
      key: this.#key(key),
      size: buf.length,
      httpMetadata: e.meta,
      body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(buf)); c.close(); } }),
      async arrayBuffer() { return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length); },
      async text() { return buf.toString("utf8"); },
      writeHttpMetadata() {}
    };
  }
  async delete(key) { this.map.delete(this.#key(key)); }
  async list(opts = {}) {
    const prefix = opts.prefix || "";
    const delim = opts.delimiter || "";
    const keys = [...this.map.keys()].filter(k => k.startsWith(prefix)).sort();
    const objects = [];
    const prefixes = new Set();
    for (const k of keys) {
      if (delim) {
        const rest = k.slice(prefix.length);
        const i = rest.indexOf(delim);
        if (i >= 0) { prefixes.add(prefix + rest.slice(0, i) + delim); continue; }
      }
      const e = this.map.get(k);
      objects.push({ key: k, size: e.data.length, uploaded: new Date() });
    }
    return {
      objects,
      prefixes: [...prefixes],
      truncated: false,
      cursor: undefined,
      isTruncated: false,
      [Symbol.asyncIterator]: async function* () {
        for (const o of objects) yield o;
      }
    };
  }
}

// ============================================================================
// 让 Node 的 crypto.subtle 支持 Workers 里的同步 HMAC（admin.js 在用）
// ============================================================================
const RAWKEYS = new WeakMap();
const _origImportKey = crypto.subtle.importKey.bind(crypto.subtle);
crypto.subtle.importKey = async function (alg, keyData, algs, ext, usages) {
  const k = await _origImportKey(alg, keyData, algs, ext, usages);
  RAWKEYS.set(k, Buffer.from(keyData));
  return k;
};
crypto.subtle.importKeySync = function (alg, keyData) {
  const k = { __raw: Buffer.from(keyData), __alg: alg };
  RAWKEYS.set(k, k.__raw);
  return k;
};
crypto.subtle.signSync = function (alg, key, data) {
  const raw = key.__raw || RAWKEYS.get(key);
  if (!raw) throw new Error("signSync: no raw key");
  const mac = crypto.createHmac("sha256", Buffer.from(raw))
    .update(Buffer.from(data)).digest();
  return new Uint8Array(mac).buffer;
};

export { MemR2 };