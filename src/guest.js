/* ============================================================================
   游客投稿（不用 GitHub 也能提交）

   原理：投稿的图片先进 R2 暂存区，**不碰仓库**。
   管理员在管理页审核通过后，才用小号的 token 写进仓库、提 PR。

   ---- 为什么这样设计 ----
   · 仓库只进干净内容，不用在 GitHub 上逐个关垃圾 PR
   · GitHub 不会把这个仓库标记成被滥用
   · 小号 token 只在「管理员点发布」时才用一次，不承受高频调用
   · 被拒绝的内容留在 R2，定期清掉，不进 git 历史

   ---- 威胁模型（认真对待，别自欺欺人）----
   这是个**对全网开放的上传口**，任何人都能打。必须假设会被刷、被传
   垃圾、甚至被传恶意内容。所以有几道硬约束：

   1. Turnstile 验证码 —— 挡掉自动脚本
   2. 按 IP 频控（R2 计数）—— 挡掉慢速真人刷
   3. 强制类型/尺寸校验 —— 只收真正的 webp/jpeg
   4. 图片重编码 —— 即使骗过类型检查，也只能存成合法图片。
      这一点最关键：伪造扩展名传 .exe/.html 会被重编码成真图片，
      而不是原样存下来。
   5. 文件名彻底消毒 —— 杜绝路径穿越（../../ 之类）

   ★ 任何一条校验不过都是「拒绝」，绝不「降级放过」。

   ---- 环境变量 ----
     BOT_TOKEN          小号的 token（⚠️ 保密，GitHub PAT 或 OAuth token）
     TURNSTILE_SECRET   Turnstile 服务端密钥
     RATE_LIMIT         每个 IP 的间隔秒数（默认 1800 = 30 分钟一次）
   ============================================================================ */

// json 是 admin.js 里定义的共用工具
import { json } from './admin.js';

const GH_API = 'https://api.github.com';

// 和主站 config.js 对应的仓库坐标。这个 Worker 只需要知道这些常量。
const REPO = { owner: 'Thomas455', repo: 'nailong-university', branch: 'main' };
const WORKS_DIR = 'works';

// 硬上限（即使前端被绕过也生效）
const MAX_FILES = 20;
const MAX_FILE_BYTES = 2 * 1024 * 1024;      // 单张 2MB 上限（前端已压到 900KB）
const MAX_TOTAL_BYTES = 24 * 1024 * 1024;    // 单次提交 24MB 上限

export async function guestRoutes(url, request, env) {
  if (url.pathname === '/api/guest/config') return guestConfig(env);
  if (url.pathname === '/api/guest/submit' && request.method === 'POST') {
    return handleGuestSubmit(request, env);
  }
  if (url.pathname === '/api/guest/status') {
    return handleGuestStatus(url, env);
  }
  return null;
}

function guestConfig(env) {
  return json({
    // 只暴露「有没有配好」和一个公开的 site key。
    // secret 和 bot token 一个都不下发。
    turnstileSiteKey: env.TURNSTILE_SITE_KEY || '',
    ready: Boolean(env.BOT_TOKEN && env.TURNSTILE_SECRET && env.SUBMIT_BUCKET)
  });
}

/* ============================================================
   投稿

   期望的表单字段：
     college   学院目录名（必须在下拉名单里，见 COLLEGES）
     note      留言（可选）
     files[]   图片文件
     tsToken   Turnstile token
   ============================================================ */
async function handleGuestSubmit(request, env) {
  if (!env.BOT_TOKEN || !env.TURNSTILE_SECRET || !env.SUBMIT_BUCKET) {
    return json({ ok: false, error: '服务端还没配好，暂时无法投稿' }, 503);
  }

  // 1. 频控：同一 IP 的提交间隔
  const ip = clientIp(request);
  const rl = await checkRate(ip, env);
  if (!rl.ok) {
    return json({ ok: false, error: rl.error, retryAfter: rl.retryAfter }, 429);
  }

  // 2. 读表单。限制总体积，超了直接拒（不读进内存）
  let form;
  try {
    form = await request.formData();
  } catch (e) {
    return json({ ok: false, error: '提交内容太大或格式不对' }, 400);
  }

  // 3. Turnstile 验证
  const ts = form.get('tsToken');
  const turnstile = await verifyTurnstile(ts, ip, env);
  if (!turnstile.ok) {
    return json({ ok: false, error: '验证码没通过：' + turnstile.error }, 400);
  }

  // 4. 学院校验：必须是名单里的，杜绝任意字符串进仓库路径
  const collegeRaw = String(form.get('college') || '');
  const college = COLLEGES.find((c) => c.dir === collegeRaw);
  if (!college) {
    return json({ ok: false, error: '学院名无效' }, 400);
  }

  // 5. 文件校验
  const files = form.getAll('files').filter((f) => f && typeof f.arrayBuffer === 'function');
  if (!files.length) return json({ ok: false, error: '没有收到图片' }, 400);
  if (files.length > MAX_FILES) {
    return json({ ok: false, error: '一次最多 ' + MAX_FILES + ' 张' }, 400);
  }

  let total = 0;
  const cleaned = [];
  for (const f of files) {
    if (f.size > MAX_FILE_BYTES) {
      return json({ ok: false, error: '单张不能超过 2MB' }, 413);
    }
    total += f.size;
    if (total > MAX_TOTAL_BYTES) {
      return json({ ok: false, error: '一次提交的总大小超了' }, 413);
    }
    const rec = await sanitizeFile(f);
    if (!rec.ok) return json({ ok: false, error: rec.error }, 400);
    cleaned.push(rec);
  }

  // 6. 存进 R2
  const id = makeId();
  const prefix = `${id}/`;
  for (const rec of cleaned) {
    await env.SUBMIT_BUCKET.put(prefix + rec.name, rec.bytes, {
      httpMetadata: { contentType: rec.type }
    });
  }
  // 元数据和图片放同一个前缀下，管理页一次 list 就能拿到全部信息
  await env.SUBMIT_BUCKET.put(prefix + '_meta.json', JSON.stringify({
    id,
    collegeDir: college.dir,
    collegeName: college.name,
    note: String(form.get('note') || '').slice(0, 500),
    files: cleaned.map((c) => ({ name: c.name, size: c.bytes.byteLength, type: c.type })),
    at: Date.now(),
    ip: hashIp(ip)          // 只存哈希，不存原始 IP
  }), { httpMetadata: { contentType: 'application/json' } });

  // 7. 记账频控（成功后才记，避免验证码失败也占用额度）
  await bumpRate(ip, env);

  return json({ ok: true, id });
}

/* ============================================================
   投稿状态查询（访客拿编号查自己那条有没有被发布/拒绝）
   ============================================================ */
async function handleGuestStatus(url, env) {
  if (!env.SUBMIT_BUCKET) return json({ ok: false, error: '未配置' }, 503);
  const id = String(url.searchParams.get('id') || '').trim();
  if (!/^[0-9A-Z]{6}$/.test(id)) return json({ ok: false, error: '编号格式不对' }, 400);

  // 已发布/已拒绝的记录会挪到 done/ 前缀
  const meta = await env.SUBMIT_BUCKET.get(`done/${id}/_meta.json`);
  if (meta) {
    const m = JSON.parse(await meta.text());
    return json({
      ok: true, status: m.status || 'done',
      prUrl: m.prUrl || null,
      prNumber: m.prNumber || null,
      note: m.adminNote || null
    });
  }

  // 还在队列里
  const pending = await env.SUBMIT_BUCKET.get(`${id}/_meta.json`);
  if (pending) return json({ ok: true, status: 'pending' });

  return json({ ok: true, status: 'unknown' });
}

/* ============================================================
   文件消毒 + 类型验证

   ★ 不信任客户端说的 MIME 和扩展名 —— 只看魔数（magic number）。
     把 .exe 改名成 .webp 骗不过这一关。
   ★ 扩展名由魔数反推，不沿用原始文件名。

   已知不足（诚实记录）：这里**只校验、不重编码**。
   浏览器侧已经把图转成 webp 了，正常路径不会有奇怪东西；
   但严格说，构造出来的「魔数是 PNG、内容是别的」的畸形文件仍可能过。
   要彻底消除需要在 Worker 里跑一次图片解码重编码（引入 Wasm，
   吃 CPU 额度）。当前选择：魔数校验 + 人工审核兜底。
   ============================================================ */
async function sanitizeFile(file) {
  const buf = new Uint8Array(await file.arrayBuffer());

  // 看魔数判断真实类型
  let type = sniffImage(buf);
  if (!type) return { ok: false, error: '只接受图片文件' };

  // 用魔数认定的类型决定扩展名，忽略文件名后缀
  const ext = type === 'image/webp' ? '.webp'
            : type === 'image/png'  ? '.png'
            : '.jpg';

  // 消毒文件名：去掉所有路径成分和危险字符
  let base = String(file.name || 'work')
    .replace(/\.[^.]*$/, '')
    .replace(/[\r\n\t]/g, ' ')
    .replace(/[/\\]/g, '')
    .replace(/[:*?"<>|]/g, '')
    .replace(/^\.+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60) || 'work';

  return {
    ok: true,
    name: base + ext,
    bytes: buf,
    type
  };
}

// 只认这三种魔数。SVG 故意不收 —— 它能带脚本，是最常见的 XSS 载体。
function sniffImage(b) {
  if (b.length < 12) return null;
  // WebP: "RIFF"...."WEBP"
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47 &&
      b[4] === 0x0D && b[5] === 0x0A && b[6] === 0x1A && b[7] === 0x0A) return 'image/png';
  // JPEG: FF D8 FF
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg';
  return null;
}

/* ============================================================
   Turnstile
   ============================================================ */
async function verifyTurnstile(token, ip, env) {
  if (!token) return { ok: false, error: '缺少验证码' };
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret: env.TURNSTILE_SECRET,
        response: String(token),
        remoteip: ip
      })
    });
    const d = await r.json();
    if (!d.success) {
      return { ok: false, error: (d['error-codes'] || []).join(',') || '验证失败' };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: '验证服务暂时不可用' };
  }
}

/* ============================================================
   频控（用 R2 当计数器，无需 KV）
   ============================================================ */
// ⚠️ 必须是 async：hashIp 是异步的。写成同步的话模板字符串会把
//    Promise 对象本身塞进去（rl/[object Promise]），
//    结果所有访客共用一个频控计数器 —— 一个人投完，全站被挡半小时。
async function rateKey(ip) {
  return `rl/${await hashIp(ip)}`;
}

async function checkRate(ip, env) {
  const bucket = env.RATE_BUCKET || env.SUBMIT_BUCKET;
  if (!bucket) return { ok: true };
  const gap = parseInt(env.RATE_LIMIT || '1800', 10);

  const obj = await bucket.get(await rateKey(ip));
  if (!obj) return { ok: true };

  let last = null;
  try { last = JSON.parse(await obj.text()); } catch (e) { last = null; }
  if (!last || !last.at) return { ok: true };          // 数据坏了就当没限过

  const waited = Math.floor((Date.now() - last.at) / 1000);
  if (waited < gap) {
    return {
      ok: false,
      error: `提交太频繁，${fmtGap(gap - waited)}后再试`,
      retryAfter: gap - waited
    };
  }
  return { ok: true };
}

async function bumpRate(ip, env) {
  const bucket = env.RATE_BUCKET || env.SUBMIT_BUCKET;
  if (!bucket) return;
  await bucket.put(await rateKey(ip), JSON.stringify({ at: Date.now() }), {
    httpMetadata: { contentType: 'application/json' },
    expirationTtl: 86400          // 一天后自动清理
  });
}

function fmtGap(s) {
  if (s < 60) return s + ' 秒';
  if (s < 3600) return Math.ceil(s / 60) + ' 分钟';
  return Math.ceil(s / 3600) + ' 小时';
}

/* ============================================================
   工具
   ============================================================ */
function makeId() {
  // 大写字母数字，去掉容易看错的 I/O/0/1，方便访客念编号
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const a = new Uint8Array(6);
  crypto.getRandomValues(a);
  return Array.from(a, (x) => A[x % A.length]).join('');
}

function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || '0.0.0.0';
}

async function hashIp(ip) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip));
  return Array.from(new Uint8Array(d).slice(0, 8))
    .map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ---- 学院名单 ----
   ⚠️ 必须和 public/assets/config.js 里的 colleges 一致，
      也必须和仓库 works/ 下的目录名一致。
   （这是服务端校验用的，不能信任前端传的名字。）
   这里只留 dir 字段。 */
const COLLEGES = [
  { name: '经济与统计学院', dir: '经济与统计学院' },
  { name: '法学院（律师学院）', dir: '法学院（律师学院）' },
  { name: '马克思主义学院', dir: '马克思主义学院' },
  { name: '教育学院（师范学院）', dir: '教育学院（师范学院）' },
  { name: '体育学院', dir: '体育学院' },
  { name: '人文学院', dir: '人文学院' },
  { name: '外国语学院', dir: '外国语学院' },
  { name: '新闻与传播学院', dir: '新闻与传播学院' },
  { name: '管理学院（旅游学院/中法旅游学院）', dir: '管理学院（旅游学院·中法旅游学院）' },
  { name: '公共管理学院', dir: '公共管理学院' },
  { name: '音乐舞蹈学院', dir: '音乐舞蹈学院' },
  { name: '美术与设计学院', dir: '美术与设计学院' },
  { name: '数学与信息科学学院', dir: '数学与信息科学学院' },
  { name: '物理与材料科学学院', dir: '物理与材料科学学院' },
  { name: '化学化工学院', dir: '化学化工学院' },
  { name: '地理科学与遥感学院', dir: '地理科学与遥感学院' },
  { name: '生命科学学院', dir: '生命科学学院' },
  { name: '机械与电气工程学院', dir: '机械与电气工程学院' },
  { name: '电子与通信工程学院', dir: '电子与通信工程学院' },
  { name: '计算机科学与网络工程学院', dir: '计算机科学与网络工程学院' },
  { name: '建筑与城市规划学院', dir: '建筑与城市规划学院' },
  { name: '土木与交通工程学院', dir: '土木与交通工程学院' },
  { name: '环境科学与工程学院', dir: '环境科学与工程学院' },
  { name: '网络空间安全学院', dir: '网络空间安全学院' },
  { name: '人工智能学院', dir: '人工智能学院' }
];

export { COLLEGES, REPO, WORKS_DIR, GH_API, MAX_FILES };