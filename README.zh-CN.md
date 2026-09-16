# plane-cli

[English](./README.md) | [完整使用与验收指南](./GUIDE.zh-CN.md)

`plane-cli` 是供 AI agent 与工程团队使用的命令行工具，面向 Silicon Alchemists 定制部署的 Plane 服务。

> 兼容性边界：这个二进制文件是为本仓库配套的定制 Plane API 行为构建的，**不适用于开源发行版 Plane，也不是其官方 CLI**。开源 Plane 实例即使接受了配置，也可能缺少本工具需要的端点或返回字段。

## Homebrew 安装

Homebrew 7 需要显式 tap URL（本仓库不叫 `homebrew-plane-cli`），并且要对第三方 Formula 执行 `brew trust`：

```bash
brew tap RenderCoder/plane-cli https://github.com/RenderCoder/plane-cli
brew trust --tap rendercoder/plane-cli
brew install --formula rendercoder/plane-cli/plane-cli
```

Homebrew 提供的是独立二进制文件，运行时不需要 Bun。验证安装：

```bash
plane-cli --version
plane-cli --help
```

从源码构建（需要 [Bun](https://bun.sh)）：

```bash
bun test
bun run build
./dist/plane-cli --version
```

## 配置

配置文件位于 `~/.config/plane-cli/config.json`。目录权限为 `0700`，配置文件权限为 `0600`。

```bash
plane-cli config init
plane-cli config set baseUrl https://plane.example.internal
plane-cli config set workspaceSlug your-workspace
plane-cli config set apiKey <your-plane-personal-token>
```

不要把 token 提交到仓库、粘贴到终端历史以外的共享位置或输出到日志。`config set` 不回显密钥，`config show` 只显示密钥是否已经配置。

标准 Plane API 与可选的 Pro Task API 使用不同的凭据。默认只使用标准 API；只有在定制部署明确提供 Pro 后端和独立 token 时才可启用 Pro：

```bash
plane-cli config set enableProTaskApi true
plane-cli config set proBaseUrl https://plane-pro.example.internal
plane-cli config set proPersonalToken <your-pro-personal-token>
```

也支持通过环境变量覆盖文件配置：`PLANE_API_KEY`、`PLANE_WORKSPACE_SLUG`、`PLANE_BASE_URL`、`PLANE_ENABLE_PRO_TASK_API`、`PLANE_PRO_BASE_URL`、`PLANE_PRO_PERSONAL_TOKEN`、`PLANE_CLI_HOME`、`PLANE_CLI_CATALOG_TTL_DAYS`。标准 API token 不会被发送到 Pro API。

## 发布维护者说明

版本 tag 格式为 `plane-cli-vX.Y.Z`，并且必须与根目录的 `package.json` 版本一致。GitHub Actions 会在 Linux、Intel macOS 和 Apple Silicon macOS 上运行测试，构建独立二进制，并发布带 SHA-256 校验文件的归档包。

发布后，使用各归档包 `.sha256` 的实际值替换 [`Formula/plane-cli.rb.template`](Formula/plane-cli.rb.template) 中的占位符，再将完成的 Formula 作为本仓库的 `Formula/plane-cli.rb` 提交。
