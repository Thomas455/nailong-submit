/* ============================================================================
   全站共用常量

   放在单独一个文件里，而不是塞进 guest.js ——
   guest.js 是「游客投稿」，它**全程不碰 GitHub**，
   但主仓库坐标却是写仓库那部分（review.js）要用的。
   之前那三个常量住在 guest.js 里，靠 export 借出去，
   看代码的人会误以为游客投稿依赖 GitHub token。拆出来就没这误会了。
   ============================================================================ */

// GitHub API
export const GH_API = 'https://api.github.com';

// 主仓库坐标。⚠️ 必须和 public/assets/config.js 保持一致。
export const REPO = { owner: 'Thomas455', repo: 'nailong-university', branch: 'main' };

// 作品在仓库里的位置
export const WORKS_DIR = 'works';