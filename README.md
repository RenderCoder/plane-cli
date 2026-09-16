# plane-cli

[简体中文](./README.zh-CN.md) | [Chinese operation and acceptance guide](./GUIDE.zh-CN.md)

AI-agent-friendly command line for Silicon Alchemists' customized Plane deployment.

> Compatibility boundary: this binary is built for the customized Plane API behavior that accompanies this repository. It is **not compatible with the open-source Plane distribution** and is not an official Plane CLI. An open-source Plane instance can accept configuration but still lack required endpoints or response fields.

## Homebrew installation

Homebrew 7 requires an explicit tap URL (this repository is not named `homebrew-plane-cli`) and `brew trust` for third-party formulae:

```bash
brew tap RenderCoder/plane-cli https://github.com/RenderCoder/plane-cli
brew trust --tap rendercoder/plane-cli
brew install --formula rendercoder/plane-cli/plane-cli
```

The Homebrew package does not need Bun at runtime. Verify it with:

```bash
plane-cli --version
plane-cli --help
```

Release maintainers tag versions as `plane-cli-vX.Y.Z`, matching the root `package.json` version. The GitHub Actions workflow runs tests and builds standalone archives for Linux, Intel macOS, and Apple Silicon macOS. After the GitHub release is created, copy each published SHA-256 value into [`Formula/plane-cli.rb.template`](Formula/plane-cli.rb.template) and publish the completed Formula as `Formula/plane-cli.rb` in this repository.

Run `plane-cli --help` for commands and flags.

## Build from source

Requires [Bun](https://bun.sh). The global command does not exist until you compile it from this directory:

```bash
bun run src/cli.ts install
```

That compiles a native binary to `~/.local/bin/plane-cli` (`0700` config dir / `0600` `config.json` after `config init`). Put `~/.local/bin` on `PATH`, then `plane-cli` works without Bun on later invocations.

Override the destination:

```bash
bun run src/cli.ts install --prefix /usr/local/bin
```

Source form (no binary):

```bash
bun run src/cli.ts --help
```

## Config

Local file: `~/.config/plane-cli/config.json`

```json
{
  "baseUrl": "https://api.plane.so",
  "workspaceSlug": "your-workspace",
  "proBaseUrl": "",
  "catalogTtlDays": 3,
  "enableProTaskApi": false
}
```

Write it with:

```bash
plane-cli config init
plane-cli config set baseUrl https://example.plane.host
plane-cli config set workspaceSlug your-workspace
plane-cli config set apiKey <your-plane-personal-token>
```

`config set` writes secrets to the file and does not echo them. The config directory is `0700`; `config.json` is `0600`.

Pro Task API stays off until all three are set: `plane-cli config set enableProTaskApi true` (or `PLANE_ENABLE_PRO_TASK_API=true`), `proBaseUrl` / `PLANE_PRO_BASE_URL`, and `proPersonalToken` / `PLANE_PRO_PERSONAL_TOKEN`. Pro needs a token in addition to the URL. The standard `apiKey` / `PLANE_API_KEY` is never sent to Pro. Environment variables override the file when set: `PLANE_API_KEY`, `PLANE_WORKSPACE_SLUG`, `PLANE_BASE_URL`, `PLANE_ENABLE_PRO_TASK_API`, `PLANE_PRO_BASE_URL`, `PLANE_PRO_PERSONAL_TOKEN`, `PLANE_CLI_HOME`, `PLANE_CLI_CATALOG_TTL_DAYS`.

`plane-cli config show` never prints tokens; it only reports `apiKeyConfigured` / `proTokenConfigured`.

Catalog cache: `~/.config/plane-cli/catalog.json`

## Dates and rich text

Creating an Issue requires `--start-date YYYY-MM-DD` and `--target-date YYYY-MM-DD`. When the requester has not supplied both dates, ask before creating it; recommend the operator's local calendar day through the following day, but do not silently apply that recommendation. The CLI rejects missing, malformed, or reversed ranges before making a write. `--allow-missing-dates` is an explicit exception for a requester-authorized workflow, not an AI-agent default.

`--description` and comment `--body` accept a safe Markdown subset and produce structured Plane HTML: headings, ordered and unordered lists, emphasis, links, inline code, and fenced code blocks. Raw HTML is escaped. After an Issue create/update, the CLI reads the persisted Issue back and fails with `WRITE_VERIFY` when explicit dates or expected rich-text structure did not persist. Compact Issue output includes a stable `description_html_summary`; for a user-visible completion, use `issue get KEY --raw` to inspect `start_date`, `target_date`, and `description_html`, and verify a comment's `comment.comment_html` in the write response.

```bash
plane-cli issue create --project SIL --title "Design review" \
  --start-date 2026-09-14 --target-date 2026-09-15 \
  --description $'## Scope\n\n- Review the diagram\n- Confirm **ownership**'
```

## Personal notifications and inline images

`notification list` reads notifications for the person represented by the standard `apiKey`; it is a standard Plane API capability and does not need the optional Pro Task API. Keep the same `--per-page` value when continuing with a returned cursor.

```bash
plane-cli notification list --per-page 20
plane-cli notification list --read false --per-page 20
plane-cli notification list --mentioned true --per-page 20 --cursor <next-cursor>
plane-cli notification mark-read <notification-id>
```

`notification mark-read` marks exactly one notification as read after the agent has acted on user feedback. It uses the configured standard personal `apiKey`, sends an empty-body `POST`, and returns the complete updated notification. It is safe to retry: Plane preserves the original `read_at` timestamp for an already-read notification. It does not support marking a notification unread or marking all notifications read.

Use `--image` on an issue write so the CLI can upload, confirm, insert the safe image reference, and bind it to the exact target in one operation. This is the recommended way to put an image in an Issue description or comment. Supply a single explicit local path, or a comma-separated list. Supported files are non-empty JPEG, PNG, WebP, and GIF images.

```bash
plane-cli issue create --project SIL --title "Design review" --start-date 2026-09-14 --target-date 2026-09-15 --description "Latest diagram" --image ./diagram.png
plane-cli issue update SIL-12 --description "Revised diagram" --image ./diagram.png
plane-cli issue comment SIL-12 --body "Screenshot from verification" --image ./result.png
plane-cli issue comment update SIL-12 <comment-id> --body "Revised screenshot" --image ./result.png
```

For an image write, the CLI performs `create upload session -> direct upload -> confirm -> write Issue/comment HTML -> bind`. A new comment is bound to its returned comment ID; a comment update is bound to the supplied existing comment ID, never the parent Issue ID. The output and generated HTML contain only Plane asset IDs; they never contain the upload URL, upload fields, file bytes, or token.

Inline images require the target Plane server to have deployed the `description-assets` API. This is an enhanced server patch, not a fallback to attachments or legacy assets APIs. When unavailable, the CLI exits with `DESCRIPTION_ASSET_API_UNAVAILABLE`; do not retry by putting a base64 string or an external/S3 URL in the description or comment.

## Tests

```bash
bun test
```
