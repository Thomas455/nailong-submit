# 投稿站 · submit.宇宙奶龙大学.com

给 [宇宙奶龙大学.com](https://xn--psszg58cydsdq780c.com/) 展览馆投稿的页面。

有**两条投稿路径**，选哪条都行：

| | GitHub 登录 | 游客投稿 |
| --- | --- | --- |
| 要账号吗 | 要 | **不要** |
| 国内能用吗 | 需要能连上 GitHub | **能** |
| 作者是谁 | 投稿者本人 | 小号（经你审核后发布） |
| 到展览馆要多久 | 你合并 PR 后 | 你审核发布后 |
| 有审核吗 | 你在 GitHub 上看 PR | 投稿站的管理页 |

两条路最后都会把作品写进 `works/学院名/`，效果一样。

---

## 它解决什么问题

投稿门槛原来有两道：

1. **要会 git** —— fork、建分支、改 `list.txt`、提 PR
2. **要能连上 GitHub** —— 授权页在 `github.com`，国内时好时坏

现在两条都没了：

- 会 git 的走 GitHub 登录，一键提 PR，作者是自己的账号
- 不会 git / 连不上 GitHub 的走游客投稿，填个表上传就行，
  内容先进审核队列，**你看过之后才用小号发进仓库**

---

## 工作流程

### 路径一：GitHub 登录

```
投稿者在投稿页登录 GitHub
        ↓ 选学院、拖入图片
        ↓ 浏览器本地：转 webp + 压缩 + 抹掉 EXIF
        ↓ 用他自己的 token：建 fork → 同步 → 建分支
           → 传图 → 更新 list.txt → 提 PR
        ↓ 你在 GitHub 上合并
        ↓ Cloudflare 自动部署
```

### 路径二：游客投稿

```
投稿者选学院、拖入图片、填个留言、回答一道算术题
        ↓ 浏览器本地：转 webp + 压缩 + 抹掉 EXIF
        ↓ 提交到 Worker
        ↓ ★ 图片存进 R2 暂存区，不碰仓库 ★
        ↓ 拿到一个六位投稿编号（记下来可查状态）
        ↓
你打开 submit.宇宙奶龙大学.com/admin.html 用 GitHub 登录
        ↓ 看到待审列表，预览每张图
        ↓
   ┌─ 【审核通过】─────────────────────────────────────┐
   │  Worker 用小号 token 把作品写进**小号自己的 fork**：│
   │    建分支 → 从 R2 取图写进 works/ → 更新 list.txt │
   │  不动主仓库，也不建 PR                             │
   └──────────────────────────────────────────────────┘
        ↓ 给你一个分支链接（小号 fork 上的 guest/… 分支）
        ↓
   你可以随意手动调整：改名、删图、调 list.txt 里的顺序…
        ↓
   ┌─ 【推送】─────────────────────────────────────────┐
   │  把 fork 上攒好的**所有**改动，合并成一个 PR 提给主仓库 │
   └──────────────────────────────────────────────────┘
        ↓
你合并 PR → Cloudflare 部署 → 作品上线
```

**为什么要绕这一圈？**

因为游客投稿是**对全网开放的上传口**。如果直接提 PR：

- 仓库会被垃圾内容灌满，你得在 GitHub 上逐个关掉
- GitHub 会把仓库标记为被滥用
- 所有人共用一个小号，API 限额挤在一起，而且**查不出是谁投的**

加了审核队列，仓库里只进干净内容；被拒的留在 R2，定期清掉即可。

---

## 目录结构

```
public/                     部署出去的静态文件
  index.html                投稿页（叫 index.html 是为了根路径能直接打开）
  admin.html                管理页：审核队列、发布、拒绝
  assets/
    config.js               仓库坐标 + 学院名单 ← 改这里就能换个仓库
    style.css               样式（跟着主站的深色主题）
    image.js                图片处理：转 webp / 缩放 / 压缩 / 抹 EXIF
    github.js               GitHub API（登录投稿那条路用）
    app.js                  投稿页逻辑：选模式 / 选学院 / 选图 / 提交
    admin.js                管理页逻辑：登录 / 队列 / 发布
    admin.css               管理页样式
src/                        Worker 服务端
  worker.js                 入口：把请求分给下面三个模块
  admin.js                  管理员登录（最小权限 OAuth + 签名会话 cookie）
  guest.js                  游客投稿：校验 + 存 R2（不碰仓库）
  review.js                 审核：列表 / 详情 / 发布 / 拒绝
wrangler.jsonc              Cloudflare Workers 配置（含 R2 绑定）
tools/
  test_worker.mjs           服务端测试：58 项，跑的是真实 Worker 源码
```

---

## 部署

### 1. 建 GitHub OAuth App

GitHub → Settings → Developer settings → **OAuth Apps** → New OAuth App

| 字段 | 填什么 |
| --- | --- |
| Application name | `宇宙奶龙大学 投稿`（随便，授权页会显示） |
| Homepage URL | `https://submit.xn--psszg58cydsdq780c.com` |
| **Authorization callback URL** | `https://submit.xn--psszg58cydsdq780c.com/api/admin/callback` |

> ⚠️ 回调地址是 `/api/admin/callback`（不是 `/api/callback`）。GitHub 一个 App 只能填一个回调地址，
> 这里统一用管理员那套 —— 投稿那条路现在不再需要 OAuth 了。
>
> 授权页上勾选项建议都别勾：
> · `Allow wildcard matching` —— 勾了会让任意子域名能收 token
> · `Expire user access tokens` —— 勾了只发 8 小时有效的 token，本站没实现刷新逻辑

> ⚠️ callback URL 必须**完全一致**（含协议、子域名、路径），差一个字符 GitHub 就会拒绝。
> 本地开发时再加一个 `http://127.0.0.1:8788/api/admin/callback` 也可以。

### 为什么审核流程是「先 fork 再 PR」

小号不是主仓库的成员（对它 `push = false`），而 GitHub 明确规定：

> Using fine-grained personal access token to contribute to public repos
> where the user is not a member.

也就是说 **token 没法直接往主仓库写**。但它对**自己拥有的 fork** 有完整写权限 ——
这就是绕开该限制的办法，也是为什么审核分成了两步：

| 步骤 | 写到哪 | 效果 |
| --- | --- | --- |
| 审核通过 | 小号的 fork | 你可以自由手动调整 |
| 推送 | 主仓库（建 PR） | 一次提交多批作品 |

好处是攒批次：审核通过五条，去 GitHub 上改改，攒够了再一次性推一个 PR，
比每条投稿开一个 PR 省事得多。

> 如果你把仓库改成私有并把小号加成 collaborator，就不用绕这一圈了 ——
> 但公开仓库 + fork 更简单，也更安全（小号权限更小）。
### 2. 配小号（只有游客投稿需要）

游客投稿是用一个**小号**把内容发进主仓库的。配置分三步：

1. **注册一个独立的小号**
   不要用主账号 —— 主账号有仓库所有权，能改设置、能删仓库，万一 token 泄露后果太大。

2. **把主仓库加成它的 collaborator**

   主仓库 → **Settings** → **Collaborators** → **Add people** → 填小号用户名 → 邀请
   → ⚠️ **用小号登录，打开邮箱点确认链接**（这一步最容易漏）

3. **在管理页点「绑定小号」，用小号登录一次**

   token 会被 **AES-GCM 加密**（密钥由 `GITHUB_CLIENT_SECRET` 派生）存进 R2，
   之后「审核通过」和「推送」都由服务器用它代提交。

> ⚠️ 第 3 步不是可选项：管理页会检查小号对主仓库有没有 `push` 权限，
> 没有就绑定失败，并明确告诉你去加 collaborator。

> **为什么不用 fine-grained personal access token？**
> PAT 的「Only select repositories」**只能选 token 拥有者自己的仓库**——
> 小号只有它自己的 fork，选不到主仓库，于是对主仓库的写操作全是 403。
> 这是 PAT 的产品限制，改设置也绕不开。
>
> OAuth 的 `public_repo` 按「仓库类型」授权，没这个限制：
> 小号只要是 collaborator，拿到的 token 就能写主仓库。

> 为什么不用主账号？主账号权限太大，泄露后果严重。
> 小号只是个 collaborator，就算泄露别人也只能改作品文件。

### 3. 配环境变量

**Client ID** 是公开值，已经写进 `wrangler.jsonc` 的 `vars`，每次部署自动带上。

其余两个是**秘密**，用命令配（存进 Cloudflare 加密存储，不进 git）：

```powershell
npx wrangler secret put GITHUB_CLIENT_SECRET   # OAuth App 的 Client Secret
```

（也可以在 Dashboard → Worker → Settings → Variables and Secrets 里逐条添加，
**类型必须选 Secret** 而不是 Text。）

> `GITHUB_CLIENT_SECRET` 一个密钥干三件事：换 OAuth token、给管理页会话
> cookie 签名、给人机验证的题目签名。所以它必须配好，否则三个功能一起挂。

### 4. 建 R2 存储桶

游客投稿的图片先进这里，不直接进仓库：

```bash
npx wrangler r2 bucket create nailong-submissions
npx wrangler r2 bucket create nailong-rate
```

（第二个是频控计数器，可以省略 —— 省略后会自动退回用第一个桶。）

### 5. 人机验证：不需要配置

用的是**自建的算术题**（`3 + 4 = ?`），不依赖任何第三方服务：

- 题目由服务端生成，**答案用 HMAC 签进 challenge 里**，前端伪造不了
- 签名密钥复用 `GITHUB_CLIENT_SECRET`，不用新增环境变量
- 10 分钟过期，一道题只能用一次

所以这一节跳过即可。以前配的 `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET`
可以从 Cloudflare 里删掉了。

### 6. 部署

推代码到 GitHub 就会自动部署（Cloudflare 的 Git 集成）。想在本地手动部署：

```powershell
npx wrangler deploy
```

`wrangler.jsonc` 里已经配好了 `submit.xn--psszg58cydsdq780c.com` 这个
custom domain，Cloudflare 会自动建 DNS 记录和证书，不用手工加 CNAME。

> 前提：`xn--psszg58cydsdq780c.com` 已经是 Cloudflare 上的一个 zone
> （主站迁 NS 时已经满足）。

### 7. 本地开发

```powershell
npx wrangler dev
```

打开 <http://127.0.0.1:8788>。OAuth 回调得在 GitHub 那个 App 里也加上
`http://127.0.0.1:8788/api/callback`，否则登录会失败。

---

## 常改的地方

| 想改什么 | 改哪里 |
| --- | --- |
| 投稿到哪个仓库 | `public/assets/config.js` 的 `owner` / `repo` |
| 作品放哪个目录 | `config.js` 的 `worksDir`（默认 `works`） |
| 学院名单 | `config.js` 的 `colleges` |
| 图片最大边长 / 画质 | `config.js` 的 `image.maxEdge` / `quality` |
| 一次最多投几张 | `config.js` 的 `maxFiles` |
| PR 描述长什么样 | `public/assets/github.js` 的 `buildPRBody()` |

> ⚠️ **学院名单必须和主站一致**：
> 要和主站 `show.html` 的 `COLLEGES`、以及仓库 `works/` 下的目录名对得上，
> 否则作品会进错目录、或者建出一个新目录。
>
> 名单里两项要分开看：`name` 是显示名，`dir` 是仓库目录名。
> 只有「管理学院」不一样 —— 它原名里带斜杠（`旅游学院/中法旅游学院`），
> 而斜杠不能做目录名，所以目录那边用 `·`。

---

## 几个设计决定（以及为什么）

### 为什么游客投稿要绕审核队列

游客投稿是**对全网开放的上传口**。如果小号直接提 PR：

- 仓库会被垃圾内容灌满，你得在 GitHub 上逐个关掉
- GitHub 会把仓库标记为被滥用
- 所有人共用一个小号，API 限额挤在一起，而且**查不出是谁投的**
- 一旦 Worker 出了什么漏洞把 token 泄露出去，别人能用它往你**所有公开仓库**写东西

加了审核队列之后：仓库里只进你看过的东西；小号 token 只在你点「审核通过」/「推送」时才用。

### 安全上做了什么（游客投稿是全网开放的，值得写清楚）

游客投稿是**对全网开放的上传口**。任何人都能打，所以必须假设会被刷、被传垃圾。
有几道硬约束：

1. **算术题人机验证（服务端签名）** —— 挡掉最笨的脚本。答案 HMAC 签名，前端伪造不了
2. **按 IP 频控** —— 挡掉慢速真人刷（默认 30 分钟一次）
3. **学院名白名单** —— 不信任前端传来的字符串，必须在名单里（挡住路径穿越）
4. **只看魔数不看后缀** —— 把 `.exe` 改名成 `.webp` 骗不过这一关；扩展名由魔数反推
5. **SVG 一律拒收** —— SVG 能带 `<script onload>`，是最常见的 XSS 载体
6. **文件名彻底消毒** —— 去掉路径成分和 Windows 保留字符
7. **人工审核兜底** —— 上面任何一条漏了，队列里还有你一双眼睛
8. **失败即拒绝** —— 任何校验不过都是「拒绝」，绝不「降级放过」

管理员侧：

- **服务端鉴权** —— 前端只是「没登录就显示登录按钮」，真正的拦截在每个接口里
- **签名 HttpOnly cookie** —— 用 Client Secret 做 HMAC，无状态、不用数据库
- **ADMIN_LOGIN 白名单** —— **没配就谁都进不来**（失败即拒绝，不是「没配就放行」）
- **会话 12 小时过期**，且每次请求都重新查白名单（你删掉某人后他的 cookie 立刻失效）

> ⚠️ **已知不足（诚实记录）**：服务端只做魔数校验，**不重新编码图片**。
> 构造出来的「魔数是 PNG、内容是别的」的畸形文件仍可能通过。
> 要彻底消除得在 Worker 里跑一次图片解码重编码（引入 Wasm，吃 CPU 额度）。
> 当前靠魔数校验 + 人工审核兜底。

### 为什么图片在浏览器里处理，而不是在 Worker 里

1. **Worker 没有现成的图片库**。要在 Worker 里转 webp 得塞一个 Wasm 库（比如 sharp 的
   移植版），吃 CPU 时间额度，还得处理内存限制。
2. **浏览器有 Canvas**，免费、快、而且天然抹掉元数据。

副作用是**原始文件根本不上传** —— 只传处理后的 webp，省流量也少一次隐私暴露。

### 抹 EXIF 是必须的，不是优化

手机拍的照片带 **GPS 坐标**。有人在家拍张画传上来，不处理就等于把自家位置公开了。

Canvas 重绘天然丢弃所有元数据（EXIF / GPS / 设备型号），所以走这条路自动就安全了。

### 为什么 token 不存 localStorage

存了能少一次登录，但页面一旦有 XSS，token 就被偷走（`public_repo` 权限不小）。
投稿不是高频操作，刷新重登的成本可以接受，换来 token 只活在当前页面内存里。

### token 怎么从回调页回到投稿页

用 **BroadcastChannel** 作主通道，`window.opener.postMessage` 作后备。

原因：GitHub 授权页如果带了 `Cross-Origin-Opener-Policy`，浏览器会**切断 opener 引用**，
`postMessage` 就发不出去了 —— 用户会卡在「授权成功但页面没反应」。
BroadcastChannel 是同源窗口之间通信，不依赖 opener，所以更可靠。

两条通道都只发给同源页面，并且带一个 **nonce**：
投稿页开登录窗口时生成随机串，授权绕一圈带回来，对上了才收 token。
这不是安全边界（token 本来就回同源页面），是为了避免多标签页同时登录时串台。

### 为什么必须 fork

投稿者对主站仓库没有写权限，不改 fork 就没法提 PR —— 这是 GitHub 的模型决定的。

fork 有两个坑，代码里都处理了：

- **异步**：`POST /forks` 返回后 fork 不一定可用 → 轮询等它就绪（最多约 30 秒）
- **会陈旧**：fork 是快照，第二次投稿时可能落后很多 → 每次提交前先 `merge-upstream`
  同步（失败不致命，顶多 PR 里多几个无关差异）

### 为什么 PR 描述里不放内嵌缩略图

试过用 `<img src="相对路径">`，但 **GitHub 对 PR 描述里相对路径图片的解析行为不稳定**
（我在这台机器上连不上 GitHub，没法实测确认）。解析错了会显示一排裂图，比没有预览更难看。

现在的做法是表格里给一个「打开」链接，指向**投稿者 fork 的那个分支**上的原图 ——
无论 GitHub 怎么解析都不会裂，点开就是原图。

### 为什么 `list.txt` 用追加而不是重写

主站的规则是「`list.txt` 里写在**下面**的显示在**上面**（当最新的）」，
所以新作品追加到末尾就自动排在最前面。同时会去掉同名旧条目，避免重复。

---

## 已知限制

**① `public_repo` 权限会劝退一些人**

要 fork + 提 PR，OAuth scope 最低就是 `public_repo` —— 授权页会写
「可读写你所有公开仓库」。这不是过度申请，是 GitHub 的粒度下限
（想更细只能用 GitHub App + installation token，配置复杂好几倍）。

**② 国内访问 GitHub 的稳定性**

OAuth 授权页在 `github.com` 上，打不开就整个流程走不通。
这和「有没有账号」是两件事。

**③ `list.txt` 并发冲突**

两个人同时投同一个学院，两个 PR 都会改同一个文件，后合并的会冲突。
不过就一行内容，手动解一下不难。

**④ 没做服务端限流**

目前只在前端限制「一次最多 20 张」。理论上有人可以反复调 API 刷 PR。
真被刷了再说 —— 加一个基于 KV 的限流不难，但现在没必要。

---

## 相关文档

- 主站仓库：<https://github.com/Thomas455/nailong-university>
- 投稿指南（写给投稿者的）：主站仓库 `works/投稿指南.md`
- 主站说明：主站仓库 `README.md`
