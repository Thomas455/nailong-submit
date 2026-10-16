/* ============================================================================
   投稿站服务端入口（Cloudflare Worker）

   这个 Worker 现在管四件事，全部在 src/ 下按职责分开：

     admin.js    管理员用 GitHub 账号登录（只读身份，不碰仓库）
     bot.js      小号绑定：OAuth 换 token → 加密存 R2（替代原来的 PAT）
     guest.js    游客投稿：图片进 R2 暂存区，不碰仓库
     review.js   管理员审核：审核通过后才用小号把内容写进仓库

   核心原则：**任何来自访客的数据都不会直接进仓库。**
   游客提交的东西必须先经过管理员审核 —— 这是这个设计的全部意义。

   ---- 绑定与环境变量（见 README）----
     SUBMIT_BUCKET   R2，存待审的图片和元数据
     RATE_BUCKET     R2，存频控计数（可省略，省略就退回用 SUBMIT_BUCKET）

     GITHUB_CLIENT_ID       OAuth App 的 Client ID
     GITHUB_CLIENT_SECRET   Client Secret
                              同时用作：会话签名密钥 + 小号 token 的加密密钥
     ADMIN_LOGIN            允许进管理页的 GitHub 用户名
     RATE_LIMIT             同 IP 提交间隔秒数（默认 1800）

   写仓库的小号 token **不在环境变量里** —— 它由管理页「绑定小号」
   走 OAuth 换到，加密后存进 R2。这样不用再配一个 secret，
   也避开了 fine-grained PAT 那个「只能选自己仓库」的限制。

   ============================================================================ */

import { adminRoutes, json } from './admin.js';
import { guestRoutes } from './guest.js';
import { reviewRoutes } from './review.js';
import { botRoutes } from './bot.js';
import { notifyRoute } from './notify.js';

export default {
  // ⚠️ 第三个参数 ctx 是**必须**的。
  // 游客投稿的推送是 fire-and-forget（不等它返回，怕拖慢投稿响应），
  // 但 Workers 里「handler 返回后未登记的 promise 会被直接取消」——
  // 推送可能在真正发出去之前就被杀掉，而且连日志都不会留下。
  // 用 ctx.waitUntil() 登记后，运行时保证这段 I/O 跑完。
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 基础安全响应头。所有页面都带上。
    const withHeaders = (res) => {
      const h = new Headers(res.headers);
      h.set('X-Content-Type-Options', 'nosniff');
      h.set('Referrer-Policy', 'strict-origin-when-cross-origin');
      h.set('X-Frame-Options', 'SAMEORIGIN');
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
    };

    try {
      // CORS 预检：游客提交是同源表单，其实不需要 CORS。
      // 但同源判断失败时给出明确信息，比浏览器报个 CORS 错好。
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204 });
      }

      // /api/review/* —— 审核（每个接口内部自己查管理员身份）
      const review = await reviewRoutes(url, request, env);
      if (review) return withHeaders(review);

      // /api/bot/* —— 小号绑定（OAuth 换 token，加密存 R2）
      const bot = await botRoutes(url, request, env);
      if (bot) return withHeaders(bot);

      // /api/notify/* —— Server酱 推送（浏览器那边要靠它代发，密钥不能在前端）
      const note = await notifyRoute(url, request, env);
      if (note) return withHeaders(note);

      // /api/guest/* —— 游客投稿（ctx 透传进去，给推送用 waitUntil）
      const guest = await guestRoutes(url, request, env, ctx);
      if (guest) return withHeaders(guest);

      // /api/admin/* —— 管理员登录
      const admin = await adminRoutes(url, request, env);
      if (admin) return withHeaders(admin);

      // 投稿页（GitHub 登录投稿那条路）用这两个
      if (url.pathname === '/api/config') {
        return withHeaders(json({
          clientId: env.GITHUB_CLIENT_ID || '',
          ready: Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET)
        }));
      }
      // /api/login 和 /api/callback 在 adminRoutes 里处理（上面就 return 了），
      // 走到这里说明路由漏了 —— 明说比静默 404 好排查。
      if (url.pathname === '/api/login' || url.pathname === '/api/callback') {
        return withHeaders(new Response(
          '这个接口的路由没接上（admin.js 里可能少了对应分支）。',
          { status: 500, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
        ));
      }

      // 兜底健康检查，方便确认 Worker 活着
      if (url.pathname === '/api/ping') {
        // 小号绑定状态要真的查一下 R2 —— 原来检查的是已废弃的
        // env.BOT_TOKEN（小号早改成 OAuth 绑定，那个变量不存在了），
        // 所以 hasBot 永远是 false，排查时反而误导人。
        let botBound = false;
        try {
          if (env.SUBMIT_BUCKET) {
            botBound = Boolean(await env.SUBMIT_BUCKET.get('bot/meta.json'));
          }
        } catch (e) { /* 查不到就当没绑 */ }

        return withHeaders(json({
          ok: true,
          botBound,                       // 小号有没有绑定（真的查了 R2）
          hasBucket: Boolean(env.SUBMIT_BUCKET),
          hasAdmin: Boolean(env.ADMIN_LOGIN),
          hasSendkey: Boolean(env.SCT_SENDKEY)
        }));
      }

      // 其余交给静态资源
      if (env.ASSETS) return withHeaders(await env.ASSETS.fetch(request));

      return withHeaders(new Response('Not found', { status: 404 }));
    } catch (e) {
      // 日志里留完整堆栈
      console.error('Worker error:', e && e.stack ? e.stack : e);

      // 管理接口（你自己在用）→ 把真实错误带回去，否则永远只能看到
      // 「服务端出错了」这种废话，排查全靠猜。游客接口仍然只给笼统提示。
      const isAdminApi = url.pathname.startsWith('/api/review/') ||
                         url.pathname.startsWith('/api/admin/');
      const detail = e && e.message ? String(e.message) : String(e);
      return withHeaders(json({
        ok: false,
        error: isAdminApi
          ? '服务端出错了：' + detail
          : '服务端出错了，请稍后再试',
        detail: isAdminApi ? detail : undefined
      }, 500));
    }
  }
};