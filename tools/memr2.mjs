
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

export { MemR2 };
