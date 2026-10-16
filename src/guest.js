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

   1. 算术题人机验证（服务端签名）—— 挡掉最笨的脚本
   2. 按 IP 频控（R2 计数）—— 挡掉慢速真人刷
   3. 学院名白名单 —— 不信任前端传来的字符串
   4. 只看魔数不看后缀 —— 伪装成 .webp 的脚本骗不过这一关
   5. 拒收 SVG —— SVG 能带 <script onload>
   6. 文件名彻底消毒 —— 杜绝路径穿越（../../ 之类）
   7. 人工审核 —— 前面的万一都漏了，还有你一双眼睛

   ★ 任何一条校验不过都是「拒绝」，绝不「降级放过」。

   已知不足（诚实记录）：服务端**不重新编码图片**，只看魔数。构造出来的
   「魔数对、内容错」的畸形文件仍可能通过。要彻底消除得在 Worker 里跑
   图片解码重编码（引入 Wasm，吃 CPU 额度）。当前靠魔数 + 人工审核兜底。

   ---- 环境变量 ----
     BOT_TOKEN          小号的 token（⚠️ 保密，GitHub PAT 或 OAuth token）
     GITHUB_CLIENT_SECRET  也用作人机验证题目的签名密钥（复用，不新增变量）
     RATE_LIMIT         每个 IP 的间隔秒数（默认 1800 = 30 分钟一次）
   ============================================================================ */

// json 是 admin.js 里定义的共用工具
import { json } from './admin.js';

// GitHub API 的地址（review.js 写仓库时用）
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
  // 出题接口：前端每次要答题时来拿一道新的
  if (url.pathname === '/api/guest/challenge') {
    if (!env.SUBMIT_BUCKET) {
      return json({ ok: false, error: '服务端还没配好' }, 503);
    }
    return json(await issueChallenge(env));
  }
  if (url.pathname === '/api/guest/submit' && request.method === 'POST') {
    return handleGuestSubmit(request, env);
  }
  if (url.pathname === '/api/guest/status') {
    return handleGuestStatus(url, env);
  }
  return null;
}

function guestConfig(env) {
  // 不下发任何密钥 —— 只告诉前端「有没有配好」和用的哪套验证。
  // 能不能投稿只看存储在不在；小号有没有绑定是审核页的事，不影响游客投稿。
  return json({
    captcha: 'math',
    ready: Boolean(env.SUBMIT_BUCKET)
  });
}

/* ============================================================
   投稿

   期望的表单字段：
     college           学院目录名（必须在下拉名单里，见 COLLEGES）
     note              留言（可选）
     files[]           图片文件
     captchaAnswer     用户填的答案
     captchaChallenge  出题接口给的签名串
   ============================================================ */
async function handleGuestSubmit(request, env) {
  if (!env.SUBMIT_BUCKET) {
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

  // 3. 人机验证（自建的算术题，不用第三方服务）
  //
  // 为什么不用 Turnstile：国内访问 challenges.cloudflare.com 不稳，
  // 叠加各种拦截插件，真实用户过不了的概率不低；而这个站的定位就是
  // 给国内同学用的。而且后面还有人工审核兜底，验证码只是第一道粗筛。
  //
  // 为什么服务端要签名：否则用户可以直接伪造 /api/guest/challenge 的
  // 返回值、自己算出一个合法答案 —— 相当于没有验证。
  // 答案用 HMAC 签进 challenge 里，服务端提交时重新算一遍对答案。
  const answer = form.get('captchaAnswer');
  const challenge = String(form.get('captchaChallenge') || '');
  // ⚠️ 必须 await：verifyChallenge 是 async 的，忘了 await 的话
  //    check 是个 Promise，check.ok 恒为 undefined → 所有提交都被拒。
  const check = await verifyChallenge(challenge, answer, env);
  if (!check.ok) {
    return json({ ok: false, error: check.error, needNewChallenge: true }, 400);
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
   投稿状态查询（访客拿编号查自己那条的进展）

   状态流转：
     unknown  →  没这个编号
     pending  →  在队列里，等你审核
     approved →  你审核通过了，已写进小号的 fork（还没提到主仓库）
     rejected →  没通过
     pushed   →  已经以 PR 的形式提交到主仓库（给 PR 链接）
   ============================================================ */
async function handleGuestStatus(url, env) {
  if (!env.SUBMIT_BUCKET) return json({ ok: false, error: '未配置' }, 503);
  const id = String(url.searchParams.get('id') || '').trim();
  if (!/^[0-9A-Z]{6}$/.test(id)) return json({ ok: false, error: '编号格式不对' }, 400);

  // 被拒绝
  const rej = await env.SUBMIT_BUCKET.get(`${id}/_rejected.json`);
  if (rej) {
    const r = JSON.parse(await rej.text());
    return json({ ok: true, status: 'rejected', note: r.adminNote || null });
  }

  // 还在队列里？
  const meta = await env.SUBMIT_BUCKET.get(`${id}/_meta.json`);
  if (!meta) return json({ ok: true, status: 'unknown' });

  // 审核通过了吗？
  const ap = await env.SUBMIT_BUCKET.get(`${id}/_approved.json`);
  if (!ap) return json({ ok: true, status: 'pending' });

  const a = JSON.parse(await ap.text());

  // 已经推到主仓库了吗（找这条对应的 PR 记录）
  const pushed = await env.SUBMIT_BUCKET.get(`${id}/_pushed.json`);
  if (pushed) {
    const p = JSON.parse(await pushed.text());
    return json({
      ok: true, status: 'pushed',
      prUrl: p.prUrl || null, prNumber: p.prNumber || null
    });
  }

  return json({ ok: true, status: 'approved', branch: a.branch || null });
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
   人机验证：算术题

   设计要点：
   · 题面由服务端生成，**答案签进 challenge 里**（HMAC-SHA256）。
     没有签名的话，用户可以自己伪造一个合法答案，等于没验证。
   · challenge 自带过期时间戳，10 分钟内有效。
   · 签名密钥复用 GITHUB_CLIENT_SECRET，不新增环境变量。
     （万一它没配，用一个占位串 —— 此时 ADMIN_LOGIN 也没配的话
       isAdmin() 会全拒，所以不会因此产生绕过。）

   为什么不用现成的验证码服务：
   国内访问 challenges.cloudflare.com 不稳，叠加拦截插件，真实用户
   过不了的概率不低；而本站后面还有人工审核兜底，验证码只是粗筛。
   ============================================================ */
const CAPTCHA_TTL_MS = 10 * 60 * 1000;

const captchaKeyCache = new Map();

async function captchaKey(env) {
  const secret = env.GITHUB_CLIENT_SECRET || 'no-secret-configured';
  if (captchaKeyCache.has(secret)) return captchaKeyCache.get(secret);
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  captchaKeyCache.set(secret, key);
  return key;
}

async function captchaSign(msg, env) {
  const key = await captchaKey(env);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 生成一道题。只用加减乘，避免除法的零和负数问题。
function makeQuestion() {
  const kind = Math.floor(Math.random() * 3);
  let a, b, text;
  if (kind === 0) {
    a = 2 + Math.floor(Math.random() * 8);
    b = 1 + Math.floor(Math.random() * 8);
    text = a + ' + ' + b + ' = ?';
  } else if (kind === 1) {
    a = 6 + Math.floor(Math.random() * 13);
    b = 2 + Math.floor(Math.random() * 6);
    text = a + ' − ' + b + ' = ?';   // 用减号而不是负号结果，避免歧义
  } else {
    a = 2 + Math.floor(Math.random() * 5);
    b = 2 + Math.floor(Math.random() * 5);
    text = a + ' × ' + b + ' = ?';
  }
  return { text: text, answer: answerOf(kind, a, b) };
}

function answerOf(kind, a, b) {
  if (kind === 0) return a + b;
  if (kind === 1) return a - b;
  return a * b;
}

// 出题：把题面和签名一起发给前端，前端只拿得到题面
async function issueChallenge(env) {
  const q = makeQuestion();
  const nonce = crypto.randomUUID ? crypto.randomUUID() : String(Math.random());
  const ts = String(Date.now());
  // payload 里带答案 —— 签名保证它没被篡改
  const payload = [nonce, ts, q.text, q.answer].join('|');
  const sig = await captchaSign(payload, env);
  return {
    ok: true,
    question: q.text,
    // 前端提交时把 payload 原样带回来（challenge = payload + '.' + sig）
    challenge: payload + '.' + sig
  };
}

// 校验答案
async function verifyChallenge(challenge, answer, env) {
  if (!challenge) return { ok: false, error: '验证数据缺失，请刷新页面重试' };
  if (answer === undefined || answer === null || String(answer).trim() === '') {
    return { ok: false, error: '请先回答算术题' };
  }

  const raw = String(challenge);
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return { ok: false, error: '验证数据格式不对，请刷新页面' };

  const payload = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);

  // 先验签，防止伪造
  const want = await captchaSign(payload, env);
  if (want.length !== sig.length) return { ok: false, error: '验证数据无效，请刷新页面' };
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ sig.charCodeAt(i);
  if (diff !== 0) return { ok: false, error: '验证数据无效，请刷新页面' };

  const parts = payload.split('|');
  if (parts.length !== 4) return { ok: false, error: '验证数据格式不对' };
  const [nonce, ts, text, expected] = parts;

  // 过期检查（10 分钟）
  const n = Number(ts);
  if (!Number.isFinite(n) || Date.now() - n > CAPTCHA_TTL_MS || n - Date.now() > 60000) {
    return { ok: false, error: '验证已超时，请刷新页面重新回答' };
  }

  // 对答案（宽松一点：接受 01 / 1 这种写法）
  const got = String(answer).trim().replace(/[^\d-]/g, '');
  if (String(Number(got)) !== String(Number(expected))) {
    return { ok: false, error: '算术题答错了，再试一次', needNewQuestion: true };
  }

  return { ok: true };
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