# Plane CLI：理解、操作与验收

给使用者和验收人：按本文理解产物、完成安装配置、跑通命令，并用文末清单判定是否通过。

配对文件：

- 命令行实现：`plane-cli/`
- Agent 技能（何时用、先做什么）：[`../skills/plane-cli/SKILL.md`](../skills/plane-cli/SKILL.md)
- 英文操作摘要：[`README.md`](./README.md)

不要把 REST 路径教给 agent。调用面是 `plane-cli`；命令以 `plane-cli --help` 为准。

---

## 1. 理解

### 要解决什么

仓库里的 Plane MCP 对 AI agent 不够友好：工具面偏重、容易把 API 细节塞进技能描述。本产物把调用收成 **一条面向 agent 的 CLI**，技能文件只写策略和顺序，不写 HTTP。

最终两件东西一起交给 agent：

1. `plane-cli` 命令（Bun + TypeScript，可编译成二进制）
2. `skills/plane-cli/SKILL.md`（何时用、先 cache 后动作、少回传）

### 两个后端

| 后端 | 用途 | 何时启用 |
| --- | --- | --- |
| 标准 Plane API | 创建、更新、评论、列项目/模块/状态；默认读写路径 | 配置 `baseUrl` + `workspaceSlug` + `apiKey` |
| Pro Task API | 只读增强：按 key 读详情、搜索、上下文、个人摘要 | **同时** 打开 `enableProTaskApi`、配置 `proBaseUrl` **和** `proPersonalToken` |

Pro 默认关闭。只配 URL、不配 token，或只开开关、不配 URL/token，都不会走 Pro。标准 `apiKey` / `PLANE_API_KEY` **不会**回退发给 Pro 服务；Pro 必须有独立的 `proPersonalToken` / `PLANE_PRO_PERSONAL_TOKEN`。写操作始终走标准 API。

### 本地文件

默认目录 `~/.config/plane-cli/`（可用 `--home` 或 `PLANE_CLI_HOME` 覆盖）：

| 文件 | 作用 |
| --- | --- |
| `config.json` | URL、workspace、TTL、Pro 开关；token 只写这里 |
| `catalog.json` | 项目 / 模块 / 状态缓存，默认 TTL 3 天 |

`config init` 后目录权限 `0700`，`config.json` 权限 `0600`。`config set` / `config show` **不会**把 `apiKey` 或 `proPersonalToken` 打到 stdout，只报告 `apiKeyConfigured` / `proTokenConfigured`。

环境变量覆盖文件：`PLANE_API_KEY`、`PLANE_WORKSPACE_SLUG`、`PLANE_BASE_URL`、`PLANE_ENABLE_PRO_TASK_API`、`PLANE_PRO_BASE_URL`、`PLANE_PRO_PERSONAL_TOKEN`、`PLANE_CLI_HOME`、`PLANE_CLI_CATALOG_TTL_DAYS`。

### Agent 策略（技能里已写，验收时核对）

1. **先目录，后动作。** 创建或指派前跑 `plane-cli cache check --project IDENT`。
2. **过期再拉。** 默认 3 天；未过期复用，少打 API、少耗 token。TTL 写在 `catalogTtlDays`。
3. **对人说 key，对 CLI 说名字。** 沟通用 `SIL-12`、项目 identifier、模块名；CLI 把名字解析成 id。
4. **读宽、写准。** 模糊用 `search`；点名用 `issue get KEY`。创建必须 `--project`、`--title`、`--start-date YYYY-MM-DD` 和 `--target-date YYYY-MM-DD`。
5. **少回传。** 默认精简 JSON；转述只留 key、标题、状态、负责人、模块。
6. **写之前看一眼。** 更新或评论前先 `issue get`。

---

## 2. 操作

### 2.1 安装

需要 [Bun](https://bun.sh)。全局命令在编译前不存在。

```bash
cd plane-cli
bun run src/cli.ts install
```

产物：`~/.local/bin/plane-cli`。把 `~/.local/bin` 放进 `PATH` 后，以后可以不依赖 Bun。

覆盖安装目录：

```bash
bun run src/cli.ts install --prefix /usr/local/bin
```

源码直接跑（不装二进制）：

```bash
bun run src/cli.ts --help
```

### 2.2 配置

```bash
plane-cli config init
plane-cli config set baseUrl https://example.plane.host
plane-cli config set workspaceSlug your-workspace
plane-cli config set apiKey <your-plane-personal-token>
```

可选：改缓存天数。

```bash
plane-cli config set catalogTtlDays 3
```

要用 Pro 只读接口时，**三条都要有**：

```bash
plane-cli config set enableProTaskApi true
plane-cli config set proBaseUrl https://your-pro-host
plane-cli config set proPersonalToken <your-pro-personal-token>
```

检查配置（不应出现 token 明文）：

```bash
plane-cli config show
```

期望：`ok: true`，有 `apiKeyConfigured`；开了 Pro 且 URL+token 都配好时 `proTokenConfigured: true`。stdout 里没有 token 字符串。

### 2.3 目录缓存

```bash
plane-cli cache status
plane-cli cache check --project SIL
plane-cli cache refresh --project SIL
```

`check` 在缺缓存或过期时会刷新；指定 `--project` 时会补齐该项目的模块和状态。创建/指派任务前应先 `cache check`。

### 2.4 常用命令

stdout 一律 JSON。失败时仍打印 JSON（`ok: false`），进程退出码非 0。

```bash
plane-cli project list
plane-cli module list --project SIL
plane-cli state list --project SIL

plane-cli issue create --project SIL --title "标题" --start-date 2026-09-14 --target-date 2026-09-15 --module "模块名"
plane-cli issue get SIL-12
plane-cli issue update SIL-12 --state "In Progress"
plane-cli issue comment SIL-12 --body "进度说明"

plane-cli search "登录"
```

Pro 开启后：

```bash
plane-cli context
plane-cli digest --person 张三
plane-cli issue get SIL-12
plane-cli search "登录"
```

### 2.5 日期与富文本

创建任务必须显式传入 `--start-date YYYY-MM-DD` 和 `--target-date YYYY-MM-DD`。用户没给全时，先询问；可推荐操作者本地日历日的当天到次日，但不能静默采用。CLI 会在发起写请求前拒绝缺失、非法或倒置的日期。`--allow-missing-dates` 只服务于用户明确授权的例外流程，AI agent 不应自行使用。

`--description` 和评论的 `--body` 支持受限 Markdown，并转换成 Plane 所需的结构化 HTML：标题、无序/有序列表、强调、链接、行内代码和 fenced code block。原始 HTML 会被转义。创建或更新 Issue 后，CLI 会回读服务端；显式日期或所需富文本结构未落库时返回 `WRITE_VERIFY`。精简 Issue 输出稳定包含 `description_html_summary`。用户可见的完成仍不能只看 `ok: true`：应使用 `plane-cli issue get KEY --raw` 回读 `start_date`、`target_date` 和 `description_html`，评论则检查写入响应的 `comment.comment_html`，确认标题、列表、加粗已有真实 HTML 节点，且没有字面量 `##`、`**`。

```bash
plane-cli issue create --project SIL --title "设计评审" \
  --start-date 2026-09-14 --target-date 2026-09-15 \
  --description $'## 范围\n\n- 检查图示\n- 确认 **负责人**'
```

### 2.6 个人通知与正文图片

`notification list` 查询的是标准 `apiKey` 所属用户的个人通知，不依赖可选的 Pro Task API。使用返回的 `cursor` 续页时，必须保持第一次调用的 `--per-page` 值不变。

```bash
plane-cli notification list --per-page 20
plane-cli notification list --read false --per-page 20
plane-cli notification list --mentioned true --per-page 20 --cursor <next-cursor>
plane-cli notification mark-read <notification-id>
```

`notification mark-read` 在 Agent 已根据用户反馈处理某一条消息后，将**该条**消息标记为已读。它使用已配置的标准个人 `apiKey`，发送无请求体的 `POST`，并返回完整的更新后通知对象。重复调用安全：Plane 会保留首次已读时的 `read_at` 时间。该命令不支持标记未读，也不支持全部标记已读。

图片应随 Issue 或评论写入，推荐使用 `--image`，让 CLI 在一次工作流内上传、确认、写入安全引用并绑定到正确目标。参数是明确的本地文件路径；多张图片用逗号分隔。仅支持非空 JPEG、PNG、WebP、GIF。

```bash
plane-cli issue create --project SIL --title "设计评审" --start-date 2026-09-14 --target-date 2026-09-15 --description "最新示意图" --image ./diagram.png
plane-cli issue update SIL-12 --description "修订后的示意图" --image ./diagram.png
plane-cli issue comment SIL-12 --body "验证截图" --image ./result.png
plane-cli issue comment update SIL-12 <comment-id> --body "修订后的验证截图" --image ./result.png
```

图片写入顺序固定为：创建上传会话 -> 直传 -> 确认 -> 写入 Issue/评论 HTML -> 绑定。新建评论绑定创建响应的 `comment.id`；更新评论绑定传入的既有 `COMMENT_ID`，两者都不能绑定到父 Issue。输出和生成的 HTML 只会引用 Plane asset ID，绝不会输出上传 URL、上传字段、图片字节或 token。

正文图片依赖目标 Plane 服务已部署 `description-assets` API。这是增强补丁，不会回退到附件或旧 assets API。服务端尚未部署时，CLI 返回 `DESCRIPTION_ASSET_API_UNAVAILABLE`；不要用 base64、外部 URL 或 S3 URL 绕过。

全局旗标：`--home DIR`、`--refresh`、`--raw`、`--pretty`、`--help`、`--version`。

### 2.7 交给 AI agent

把 `skills/plane-cli/SKILL.md` 交给 agent（或链到其 skills 目录）。技能要求 `plane-cli` 在 `PATH` 上，并以 `plane-cli --help` 为命令真源。

---

## 3. 验收

按顺序做。A、B 不依赖真实 Plane；C 需要有效 token。任一项失败则本任务未通过。

### A. 仓库与文档（不跑 API）

- [ ] 存在 `plane-cli/src/cli.ts`、`plane-cli/src/lib.ts`、`skills/plane-cli/SKILL.md`
- [ ] 技能描述里 **没有** REST 路径，只有 `plane-cli ...` 命令
- [ ] 技能里打开 Pro 的命令带 `plane-cli` 前缀：`plane-cli config set enableProTaskApi true`
- [ ] 技能和 README 写明：Pro 除 `proBaseUrl` 外 **还必须** 配 `proPersonalToken` / `PLANE_PRO_PERSONAL_TOKEN`
- [ ] Pro 缺少独立 token 时，即使有 `PLANE_API_KEY` 也不会请求 Pro；`search` 仍走标准 API，`context`/`digest` 失败且不发标准 key
- [ ] 默认 TTL 为 3 天，可经 `catalogTtlDays` 或 `PLANE_CLI_CATALOG_TTL_DAYS` 修改

### B. 单测（本机有 Bun 即可）

```bash
cd plane-cli
bun test
```

期望：全部通过。至少覆盖：

- [ ] `config set apiKey` 把 token 写入文件，**stdout 不含**该 token
- [ ] `config set proPersonalToken` 把 token 写入文件，**stdout 不含**该 token
- [ ] `config show` 只出现 `apiKeyConfigured` / `proTokenConfigured`，没有密钥字段
- [ ] 缓存未过期时 `module list` 不再打项目 API
- [ ] 过期缓存上 `issue create` 会先刷新再创建，并能按模块名挂模块
- [ ] `cache check --project` 会补齐尚未加载模块的项目
- [ ] Pro 未显式打开时 `search` 走标准 API；打开后走 Pro
- [ ] `notification list --read false --mentioned true --per-page 20 --cursor <cursor>` 原样传递筛选与分页参数
- [ ] `notification mark-read <notification-id>` 用标准 `apiKey` 发起无 body 的 `POST`，成功时返回更新后通知，失败时不输出已读通知
- [ ] `issue comment KEY --body TEXT --image ./image.png` 按上传、确认、写评论、绑定顺序执行，且绑定目标为返回的评论 ID
- [ ] `description-assets` 路由为 404 时返回 `DESCRIPTION_ASSET_API_UNAVAILABLE`，不回退到附件或旧 assets API
- [ ] Markdown 标题、列表、强调会写成 `<hN>`、`<ul>/<ol><li>`、`<strong>` 等结构化 HTML；原始 HTML 不会直通
- [ ] `issue create` 缺日期会返回 `MISSING_DATES` 且不发请求；有效日期会写入 `start_date` / `target_date`

本心跳已在有 Bun 的环境跑过 `bun test`；把命令输出贴到任务评论作为证据。

### C. 安装与配置烟测

```bash
cd plane-cli
bun run src/cli.ts install
export PATH="$HOME/.local/bin:$PATH"
plane-cli --help
plane-cli config init --force --home /tmp/plane-cli-accept
plane-cli config set --home /tmp/plane-cli-accept apiKey dummy-secret-do-not-leak
plane-cli config set --home /tmp/plane-cli-accept proPersonalToken dummy-pro-secret-do-not-leak
plane-cli config show --home /tmp/plane-cli-accept
stat -f '%Lp %N' /tmp/plane-cli-accept /tmp/plane-cli-accept/config.json
```

期望：

- [ ] `--help` 打出命令列表
- [ ] `config show` 的 JSON **不含** `dummy-secret-do-not-leak` 和 `dummy-pro-secret-do-not-leak`
- [ ] 目录权限 `700`，`config.json` 权限 `600`

### D. 真实 Plane（有凭证时）

不要把真实 token 贴进聊天、任务评论或文档。用 `config set` 写入本地文件。

```bash
plane-cli cache check --project <你的项目 identifier>
plane-cli project list
plane-cli issue create --project <IDENT> --title "plane-cli 验收" --start-date 2026-09-14 --target-date 2026-09-15 --module <模块名>
plane-cli issue comment <KEY> --body "验收评论"
```

期望：返回精简 JSON，含 `ok: true` 和 `SIL-n` 这种 key；对话里看不到 UUID 和 token。

### 已知边界

- 当前环境以前可能没装 Bun；验收 B 必须在已安装 Bun 的机器上跑。
- Pro 是只读增强，不是默认行为。
- `context` / `digest` 在 Pro 关闭时会失败，这是预期。
- 本指南不替代 `plane-cli --help`。命令增补以 help 为准。

---

## 4. 验收结论怎么填

通过：A–C 全勾；若有 Plane 凭证则 D 也勾。

不通过：把失败的命令、stdout（已确认无 token）、以及期望/实际差异记在任务评论里。
