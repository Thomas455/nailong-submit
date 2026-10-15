/* ============================================================================
   投稿站服务端入口（Cloudflare Worker）

   这个 Worker 现在管三件事，全部在 src/ 下按职责分开：

     admin.js    管理员用 GitHub 账号登录（只读身份，不碰仓库）
     guest.js    游客投稿：图片进 R2 暂存区，不碰仓库
     review.js   管理员审核：审核通过后才用小号把内容写进仓库

   核心原则：**任何来自访客的数据都不会直接进仓库。**
   游客提交的东西必须先经过管理员审核 —— 这是这个设计的全部意义。

   ---- 绑定与环境变量（见 README）----
     SUBMIT_BUCKET   R2，存待审的图片和元数据
     RATE_BUCKET     R2，存频控计数（可省略，省略就退回用 SUBMIT_BUCKET）

     GITHUB_CLIENT_ID       OAuth App 的 Client ID
     GITHUB_CLIENT_SECRET   Client Secret（也用作会话签名密钥）
     ADMIN_LOGIN            允许进管理页的 GitHub 用户名

     BOT_TOKEN              小号的 token（唯一会写仓库的凭据）
     TURNSTILE_SITE_KEY     Turnstile 前端 site key（公开）
     TURNSTILE_SECRET       Turnstile 服务端密钥
     RATE_LIMIT             同 IP 提交间隔秒数（默认 1800）

   ============================================================================ */

import { adminRoutes, json } from './admin.js';
import { guestRoutes } from './guest.js';
import { reviewRoutes } from './review.js';

export default {
  async fetch(request, env) {
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

      // /api/guest/* —— 游客投稿
      const guest = await guestRoutes(url, request, env);
      if (guest) return withHeaders(guest);

      // /api/admin/* —— 管理员登录
      const admin = await adminRoutes(url, request, env);
      if (admin) return withHeaders(admin);

      // 旧接口保留：原来投稿页（登录投稿）用的
      if (url.pathname === '/api/config') {
        return withHeaders(json({
          clientId: env.GITHUB_CLIENT_ID || '',
          ready: Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET)
        }));
      }
      if (url.pathname === '/api/login' || url.pathname === '/api/callback') {
        return withHeaders(new Response(
          '这个接口已经不用了。请用 /api/admin/login。',
          { status: 410, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
        ));
      }

      // 兜底健康检查，方便确认 Worker 活着
      if (url.pathname === '/api/ping') {
        return withHeaders(json({
          ok: true,
          hasBot: Boolean(env.BOT_TOKEN),
          hasBucket: Boolean(env.SUBMIT_BUCKET),
          hasAdmin: Boolean(env.ADMIN_LOGIN)
        }));
      }

      // 其余交给静态资源
      if (env.ASSETS) return withHeaders(await env.ASSETS.fetch(request));

      return withHeaders(new Response('Not found', { status: 404 }));
    } catch (e) {
      // 抛错时不要把内部细节漏给访客，但日志要留
      console.error('Worker error:', e && e.stack ? e.stack : e);
      return withHeaders(json({
        ok: false,
        error: '服务端出错了，请稍后再试'
      }, 500));
    }
  }
};