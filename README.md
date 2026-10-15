# 投稿站 · submit.宇宙奶龙大学.com

给 [宇宙奶龙大学.com](https://xn--psszg58cydsdq780c.com/) 展览馆投稿的页面。

**访客用 GitHub 登录 → 选学院 → 拖入图片 → 提交**，就会自动在
[主站仓库](https://github.com/Thomas455/nailong-university) 创建一个 Pull Request。
作者是投稿者本人（用的是他自己的 token），不是机器人，所以有据可查。

---

## 它解决什么问题

以前投稿要会 git：fork、建分支、放文件、改 `list.txt`、提 PR ——
对不写代码的人是硬门槛。

现在投稿者只要有个 GitHub 账号，剩下的全自动。

---

## 工作流程

```
投稿者浏览 submit.宇宙奶龙大学.com
        ↓ 点「用 GitHub 登录」（OAuth 弹窗）
        ↓ 选学院、拖入图片
        ↓ 浏览器本地：转 webp + 压缩 + 抹掉 EXIF
        ↓ 用他自己的 token：
           建 fork → 同步最新 → 建分支
           → 传图 → 更新 list.txt → 提 PR
        ↓
维护者在 GitHub 上收到 PR
        ↓ 看「作品明细」表（尺寸/体积/压缩率）和「打开」链接
        ↓ 合并
        ↓
Cloudflare 自动部署 → 作品出现在展览馆
```

---

## 目录结构

```
public/                     部署出去的静态文件
  index.html                投稿页（叫 index.html 是为了根路径能直接打开）
  assets/
    config.js               仓库坐标 + 学院名单 ← 改这里就能换个仓库
    style.css               样式（跟着主站的深色主题）
    image.js                图片处理：转 webp / 缩放 / 压缩 / 抹 EXIF
    github.js               GitHub API：fork / 分支 / 上传 / PR
    app.js                  页面逻辑：登录 / 选学院 / 选图 / 提交
src/
  worker.js                 OAuth 代理（唯一需要服务端的部分）
wrangler.jsonc              Cloudflare Workers 配置
```

---

## 部署

### 1. 建 GitHub OAuth App

GitHub → Settings → Developer settings → **OAuth Apps** → New OAuth App

| 字段 | 填什么 |
| --- | --- |
| Application name | `宇宙奶龙大学 投稿`（随便，授权页会显示） |
| Homepage URL | `https://submit.xn--psszg58cydsdq780c.com` |
| **Authorization callback URL** | `https://submit.xn--psszg58cydsdq780c.com/api/callback` |

创建后会拿到 **Client ID** 和 **Client Secret**。

> ⚠️ callback URL 必须**完全一致**（含协议、子域名、路径），差一个字符 GitHub 就会拒绝。
> 本地开发时再加一个 `http://127.0.0.1:8788/api/callback` 也可以。
>
> **OAuth App 页面上的两个勾选项建议都别勾：**
> · `Allow wildcard matching` —— 勾了会让任意子域名都能接收 token，没必要扩大攻击面
> · `Expire user access tokens` —— 勾了 GitHub 只发 8 小时有效的 token 并给一个
>   `refresh_token`，而本站**没有实现刷新逻辑**。8 小时后用户会遇到「token 失效」。

### 2. 配 Client ID 和 Secret

**Client ID** 是公开值（会出现在授权链接里），已经写进 `wrangler.jsonc` 的 `vars`，
每次部署自动带上：

```jsonc
"vars": {
  "GITHUB_CLIENT_ID": "Ov23lixg2nDUNSnqhIwn"
}
```

**Client Secret** 绝对不能写进代码 —— 写进去就等于公开，别人能拿它冒充这个应用。
用命令配，存进 Cloudflare 的加密存储：

```powershell
npx wrangler secret put GITHUB_CLIENT_SECRET
```

（或者在 Dashboard → Worker → Settings → Variables and Secrets 里加一条，
**类型必须选 Secret** 而不是 Text。）

### 3. 部署

推代码到 GitHub 就会自动部署（Cloudflare 的 Git 集成）。想在本地手动部署：

```powershell
npx wrangler deploy
```

`wrangler.jsonc` 里已经配好了 `submit.xn--psszg58cydsdq780c.com` 这个
custom domain，Cloudflare 会自动建 DNS 记录和证书，不用手工加 CNAME。

> 前提：`xn--psszg58cydsdq780c.com` 已经是 Cloudflare 上的一个 zone
> （主站迁 NS 时已经满足）。

### 4. 本地开发

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
