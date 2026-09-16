import { copyFileSync, chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export const VERSION = "0.1.0";
export const DEFAULT_TTL_DAYS = 3;
const BOOL_FLAGS = new Set([
  "help",
  "h",
  "version",
  "raw",
  "pretty",
  "refresh",
  "force",
  "include-members",
  "include-comments",
  "allow-missing-dates",
]);

export type Deps = {
  env: Record<string, string | undefined>;
  homedir: string;
  now: () => number;
  readFile: (path: string) => string | null;
  writeFile: (path: string, data: string) => void;
  mkdirp: (path: string) => void;
  fetch: typeof fetch;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  chmod?: (path: string, mode: number) => void;
  compile?: (outfile: string) => Promise<void>;
  readImageFile?: (path: string) => { size: number; isFile: boolean; bytes: Uint8Array } | null;
  randomUUID?: () => string;
  delay?: (milliseconds: number) => Promise<void>;
};

export function defaultDeps(): Deps {
  return {
    env: process.env,
    homedir: homedir(),
    now: () => Date.now(),
    readFile: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return null;
      }
    },
    writeFile: (path, data) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, data);
    },
    mkdirp: (path) => mkdirSync(path, { recursive: true }),
    chmod: (path, mode) => chmodSync(path, mode),
    fetch: globalThis.fetch,
    stdout: (s) => process.stdout.write(s.endsWith("\n") ? s : `${s}\n`),
    stderr: (s) => process.stderr.write(s.endsWith("\n") ? s : `${s}\n`),
    compile: compileBinary,
    readImageFile: (path) => {
      try {
        const stat = statSync(path);
        return { size: stat.size, isFile: stat.isFile(), bytes: new Uint8Array(readFileSync(path)) };
      } catch {
        return null;
      }
    },
    randomUUID,
    delay: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  };
}

async function compileBinary(outfile: string): Promise<void> {
  const src = join(import.meta.dir, "cli.ts");
  if (existsSync(src)) {
    const proc = Bun.spawn(["bun", "build", src, "--compile", "--outfile", outfile], {
      stderr: "pipe",
      stdout: "pipe",
    });
    const code = await proc.exited;
    if (code !== 0) {
      const err = await new Response(proc.stderr).text();
      throw fail("INSTALL", err.slice(0, 500) || `bun build --compile failed with exit ${code}`);
    }
    return;
  }
  copyFileSync(process.execPath, outfile);
  chmodSync(outfile, 0o755);
}

export type ParsedArgs = {
  help: boolean;
  version: boolean;
  raw: boolean;
  pretty: boolean;
  refresh: boolean;
  force: boolean;
  home?: string;
  configPath?: string;
  resource?: string;
  action?: string;
  positionals: string[];
  flags: Record<string, string>;
};

export function parseArgv(argv: string[]): ParsedArgs {
  const flags: Record<string, string> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--") {
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (token.startsWith("--")) {
      const body = token.slice(2);
      const eq = body.indexOf("=");
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      if (BOOL_FLAGS.has(body) || argv[i + 1] === undefined || argv[i + 1].startsWith("-")) {
        flags[body] = "true";
        continue;
      }
      flags[body] = argv[++i];
      continue;
    }
    if (token === "-h") {
      flags.help = "true";
      continue;
    }
    rest.push(token);
  }
  return {
    help: flags.help === "true" || flags.h === "true",
    version: flags.version === "true",
    raw: flags.raw === "true",
    pretty: flags.pretty === "true",
    refresh: flags.refresh === "true",
    force: flags.force === "true",
    home: flags.home,
    configPath: flags.config,
    resource: rest[0],
    action: rest[1],
    positionals: rest.slice(2),
    flags,
  };
}

export function flagList(flags: Record<string, string>, name: string): string[] {
  const value = flags[name];
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export type FileConfig = {
  baseUrl?: string;
  workspaceSlug?: string;
  apiKey?: string;
  proBaseUrl?: string;
  proPersonalToken?: string;
  catalogTtlDays?: number;
  enableProTaskApi?: boolean;
};

const SECRET_KEYS = new Set(["apiKey", "proPersonalToken"]);

export type ConfigSource = "env" | "file" | "default";

export type Config = {
  home: string;
  configPath: string;
  catalogPath: string;
  baseUrl: string;
  workspaceSlug: string;
  apiKey: string;
  proBaseUrl: string;
  proToken: string;
  catalogTtlDays: number;
  enableProTaskApi: boolean;
  sources: { apiKey: ConfigSource; workspaceSlug: ConfigSource; baseUrl: ConfigSource };
  file: FileConfig;
};

// An env var silently overrides config.json, which makes a stale PLANE_API_KEY look like a
// server-side permission problem. Record where each credential actually came from.
function sourceOf(envValue: string | undefined, fileValue: unknown): ConfigSource {
  if (envValue) return "env";
  if (fileValue) return "file";
  return "default";
}

export function configHome(deps: Deps, parsed: ParsedArgs): string {
  return parsed.home || deps.env.PLANE_CLI_HOME || join(deps.homedir, ".config", "plane-cli");
}

export function loadConfig(deps: Deps, parsed: ParsedArgs): Config {
  const home = configHome(deps, parsed);
  const configPath = parsed.configPath || join(home, "config.json");
  const raw = deps.readFile(configPath);
  let file: FileConfig = {};
  if (raw) {
    try {
      file = JSON.parse(raw) as FileConfig;
    } catch {
      throw fail("CONFIG_INVALID", `Config is not valid JSON: ${configPath}`);
    }
  }
  const ttlFromEnv = deps.env.PLANE_CLI_CATALOG_TTL_DAYS;
  const catalogTtlDays = Number(ttlFromEnv || file.catalogTtlDays || DEFAULT_TTL_DAYS);
  if (!Number.isFinite(catalogTtlDays) || catalogTtlDays <= 0) {
    throw fail("CONFIG_INVALID", "catalogTtlDays must be a positive number");
  }
  return {
    home,
    configPath,
    catalogPath: join(home, "catalog.json"),
    baseUrl: deps.env.PLANE_BASE_URL || file.baseUrl || "https://api.plane.so",
    workspaceSlug: deps.env.PLANE_WORKSPACE_SLUG || file.workspaceSlug || "",
    apiKey: deps.env.PLANE_API_KEY || file.apiKey || "",
    proBaseUrl: deps.env.PLANE_PRO_BASE_URL || file.proBaseUrl || "",
    proToken: deps.env.PLANE_PRO_PERSONAL_TOKEN || file.proPersonalToken || "",
    catalogTtlDays,
    sources: {
      apiKey: sourceOf(deps.env.PLANE_API_KEY, file.apiKey),
      workspaceSlug: sourceOf(deps.env.PLANE_WORKSPACE_SLUG, file.workspaceSlug),
      baseUrl: sourceOf(deps.env.PLANE_BASE_URL, file.baseUrl),
    },
    enableProTaskApi: parseBool(
      deps.env.PLANE_ENABLE_PRO_TASK_API !== undefined && deps.env.PLANE_ENABLE_PRO_TASK_API !== ""
        ? deps.env.PLANE_ENABLE_PRO_TASK_API
        : file.enableProTaskApi,
      false,
    ),
    file,
  };
}

export function parseBool(value: unknown, fallback = false): boolean {
  if (value === true) return true;
  if (value === false) return false;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off", ""].includes(normalized)) return false;
  }
  return fallback;
}

export function proEnabled(cfg: Config): boolean {
  return Boolean(cfg.enableProTaskApi && cfg.proBaseUrl && cfg.proToken);
}

export function protectConfig(deps: Deps, cfg: Config): void {
  if (!deps.chmod) return;
  if (!deps.readFile(cfg.configPath)) return;
  try {
    deps.chmod(cfg.home, 0o700);
    deps.chmod(cfg.configPath, 0o600);
  } catch (error) {
    // Existing configs can be read from a sandboxed home where chmod is denied, and
    // --config can point outside a --home that does not exist yet (ENOENT). Either way
    // writeConfigFile still requests these permissions after every local write.
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
    if (!code || !["EPERM", "EACCES", "EROFS", "ENOENT"].includes(code)) throw error;
  }
}

export function writeConfigFile(deps: Deps, cfg: Config, file: FileConfig): void {
  deps.mkdirp(cfg.home);
  deps.writeFile(cfg.configPath, `${JSON.stringify(file, null, 2)}\n`);
  protectConfig(deps, cfg);
}

export function redactFileConfig(file: FileConfig): Record<string, unknown> {
  const { apiKey, proPersonalToken, ...rest } = file;
  return {
    ...rest,
    apiKeyConfigured: Boolean(apiKey),
    proTokenConfigured: Boolean(proPersonalToken),
  };
}

export function isSecretConfigKey(key: string): boolean {
  return SECRET_KEYS.has(key);
}

export function publicConfig(cfg: Config): Record<string, unknown> {
  return {
    home: cfg.home,
    configPath: cfg.configPath,
    catalogPath: cfg.catalogPath,
    baseUrl: cfg.baseUrl,
    workspaceSlug: cfg.workspaceSlug,
    proBaseUrl: cfg.proBaseUrl || null,
    catalogTtlDays: cfg.catalogTtlDays,
    enableProTaskApi: cfg.enableProTaskApi,
    apiKeyConfigured: Boolean(cfg.apiKey),
    proTokenConfigured: Boolean(cfg.proToken && cfg.proBaseUrl),
    sources: cfg.sources,
  };
}

export type CachedProject = { id: string; name: string; identifier: string };
export type CachedModule = { id: string; name: string };
export type CachedState = { id: string; name: string; group?: string };
export type CachedLabel = { id: string; name: string };
export type CachedMember = { id: string; display_name?: string; email?: string };

export type Catalog = {
  fetchedAt: string;
  workspace: string;
  projects: CachedProject[];
  modulesByProjectId: Record<string, CachedModule[]>;
  statesByProjectId: Record<string, CachedState[]>;
  labelsByProjectId: Record<string, CachedLabel[]>;
  membersByProjectId: Record<string, CachedMember[]>;
};

export function emptyCatalog(workspace: string, fetchedAt: string): Catalog {
  return {
    fetchedAt,
    workspace,
    projects: [],
    modulesByProjectId: {},
    statesByProjectId: {},
    labelsByProjectId: {},
    membersByProjectId: {},
  };
}

export function loadCatalog(deps: Deps, cfg: Config): Catalog | null {
  const raw = deps.readFile(cfg.catalogPath);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Catalog;
    if (!parsed.fetchedAt || !Array.isArray(parsed.projects)) return null;
    parsed.modulesByProjectId ??= {};
    parsed.statesByProjectId ??= {};
    parsed.labelsByProjectId ??= {};
    parsed.membersByProjectId ??= {};
    return parsed;
  } catch {
    return null;
  }
}

export function saveCatalog(deps: Deps, cfg: Config, catalog: Catalog): void {
  deps.mkdirp(cfg.home);
  deps.writeFile(cfg.catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
}

export function isStale(fetchedAt: string, ttlDays: number, now: number): boolean {
  const fetched = Date.parse(fetchedAt);
  if (!Number.isFinite(fetched)) return true;
  return now - fetched > ttlDays * 24 * 60 * 60 * 1000;
}

export function catalogStatus(catalog: Catalog | null, cfg: Config, now: number) {
  if (!catalog) {
    return {
      present: false,
      stale: true,
      ageMs: null,
      ttlDays: cfg.catalogTtlDays,
      fetchedAt: null,
      projectsWithModules: 0,
    };
  }
  const fetched = Date.parse(catalog.fetchedAt);
  const ageMs = Number.isFinite(fetched) ? now - fetched : null;
  return {
    present: true,
    stale: isStale(catalog.fetchedAt, cfg.catalogTtlDays, now),
    ageMs,
    ttlDays: cfg.catalogTtlDays,
    fetchedAt: catalog.fetchedAt,
    workspace: catalog.workspace,
    projectCount: catalog.projects.length,
    projectsWithModules: catalog.projects.filter((project) => catalog.modulesByProjectId[project.id] != null).length,
  };
}

function norm(value: string): string {
  return value.trim().toLowerCase();
}

export function resolveProject(catalog: Catalog, query: string): CachedProject {
  const hits = catalog.projects.filter(
    (project) => project.id === query || norm(project.identifier) === norm(query) || norm(project.name) === norm(query),
  );
  return uniqueHit(hits, "project", query);
}

export function resolveModule(catalog: Catalog, projectId: string, query: string): CachedModule {
  const hits = (catalog.modulesByProjectId[projectId] || []).filter(
    (mod) => mod.id === query || norm(mod.name) === norm(query),
  );
  return uniqueHit(hits, "module", query);
}

export function resolveState(catalog: Catalog, projectId: string, query: string): CachedState {
  const hits = (catalog.statesByProjectId[projectId] || []).filter(
    (state) => state.id === query || norm(state.name) === norm(query) || norm(state.group || "") === norm(query),
  );
  return uniqueHit(hits, "state", query);
}

export function resolveLabel(catalog: Catalog, projectId: string, query: string): CachedLabel {
  const hits = (catalog.labelsByProjectId[projectId] || []).filter(
    (label) => label.id === query || norm(label.name) === norm(query),
  );
  return uniqueHit(hits, "label", query);
}

export function resolveMember(catalog: Catalog, projectId: string, query: string): CachedMember {
  const n = norm(query);
  const hits = (catalog.membersByProjectId[projectId] || []).filter((member) => {
    if (member.id === query) return true;
    if (member.email && norm(member.email) === n) return true;
    if (member.display_name && norm(member.display_name) === n) return true;
    if (member.email && norm(member.email).split("@")[0] === n) return true;
    return false;
  });
  return uniqueHit(hits, "member", query);
}

function uniqueHit<T>(hits: T[], kind: string, query: string): T {
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) throw fail("AMBIGUOUS", `Multiple ${kind}s match ${query}`);
  throw fail("NOT_FOUND", `${kind} not found: ${query}`);
}

export class CliError extends Error {
  code: string;
  status?: number;
  constructor(code: string, message: string, status?: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function fail(code: string, message: string, status?: number): CliError {
  return new CliError(code, message, status);
}

export function httpStatus(error: unknown): number | undefined {
  return error instanceof CliError ? error.status : undefined;
}

export function asList(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  if (data && typeof data === "object" && Array.isArray((data as { results?: unknown }).results)) {
    return (data as { results: Record<string, unknown>[] }).results;
  }
  return [];
}

export function apiRoot(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/api/v1") ? trimmed : `${trimmed}/api/v1`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;");
}

function safeLink(url: string): string | null {
  const normalized = url.trim();
  return /^(https?:|mailto:|\/|#)/i.test(normalized) ? normalized : null;
}

function inlineMarkdown(text: string, allowLinks = true): string {
  const tokens: string[] = [];
  const token = (html: string): string => {
    const marker = `\u0000PLANECLI${tokens.length}\u0000`;
    tokens.push(html);
    return marker;
  };
  let source = text;
  if (allowLinks) {
    // Parse the label in its own token scope so its inline code cannot leak an outer marker.
    source = source.replace(/\[([^\]]+)\]\(([^\s)]+)\)/g, (_, label: string, url: string) => {
      const safeUrl = safeLink(url);
      return safeUrl ? token(`<a href="${escapeHtml(safeUrl)}">${inlineMarkdown(label, false)}</a>`) : label;
    });
  }
  source = source.replace(/`([^`]+)`/g, (_, value: string) => token(`<code>${escapeHtml(value)}</code>`));
  let html = escapeHtml(source);
  html = html.replace(/(\*\*|__)(.+?)\1/g, "<strong>$2</strong>");
  html = html.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)|(?<!_)_([^_\n]+)_(?!_)/g, "<em>$1$2</em>");
  return html.replace(/\u0000PLANECLI(\d+)\u0000/g, (_, index: string) => tokens[Number(index)]!);
}

function isBlockStart(line: string): boolean {
  return /^(#{1,6}\s+|[-+*]\s+|\d+[.)]\s+|```)/.test(line);
}

/** Converts the supported Markdown subset to safe, structured Plane HTML. */
export function toHtml(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: string[] = [];

  for (let index = 0; index < lines.length; ) {
    const line = lines[index]!;
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const fence = line.match(/^```([A-Za-z0-9_-]+)?\s*$/);
    if (fence) {
      const language = fence[1] ? ` class="language-${escapeHtml(fence[1])}"` : "";
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index]!)) code.push(lines[index++]!);
      if (index < lines.length) index += 1;
      blocks.push(`<pre><code${language}>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/);
    if (heading) {
      const level = heading[1]!.length;
      blocks.push(`<h${level}>${inlineMarkdown(heading[2]!)}</h${level}>`);
      index += 1;
      continue;
    }
    const unordered = line.match(/^[-+*]\s+(.+)$/);
    const ordered = line.match(/^\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      const pattern = unordered ? /^[-+*]\s+(.+)$/ : /^\d+[.)]\s+(.+)$/;
      const items: string[] = [];
      while (index < lines.length) {
        const item = lines[index]!.match(pattern);
        if (!item) break;
        items.push(`<li>${inlineMarkdown(item[1]!)}</li>`);
        index += 1;
      }
      const tag = unordered ? "ul" : "ol";
      blocks.push(`<${tag}>${items.join("")}</${tag}>`);
      continue;
    }
    const paragraph: string[] = [line];
    index += 1;
    while (index < lines.length && lines[index]!.trim() && !isBlockStart(lines[index]!)) paragraph.push(lines[index++]!);
    blocks.push(`<p>${paragraph.map((part) => inlineMarkdown(part)).join("<br/>")}</p>`);
  }
  return blocks.join("") || "<p></p>";
}

// The self-hosted /api/v1 serializer has no `*_detail` or `*_ids` fields: `state` is a
// UUID (an object when `expand=state` is sent) and `assignees`/`labels` are UUID arrays.
// The `*_detail` reads below are kept as fallbacks for Plane Cloud's richer payloads.
function stateName(value: unknown, states?: CachedState[]): string | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const name = (value as { name?: unknown }).name;
    return typeof name === "string" ? name : null;
  }
  if (typeof value !== "string") return null;
  return states?.find((state) => state.id === value)?.name ?? value;
}

function idList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.map((item) =>
    item && typeof item === "object" ? String((item as { id?: unknown }).id ?? "") : String(item),
  );
}

export function compactIssue(
  raw: Record<string, unknown>,
  projectIdentifier?: string,
  states?: CachedState[],
) {
  const sequence = raw.sequence_id;
  const project = (raw.project_detail as { identifier?: string } | undefined)?.identifier || projectIdentifier;
  const key = project && sequence != null ? `${project}-${sequence}` : undefined;
  return {
    key,
    id: raw.id,
    name: raw.name,
    priority: raw.priority ?? null,
    state: stateName(raw.state_detail ?? raw.state, states),
    project: project ?? raw.project ?? null,
    assignees: idList(raw.assignee_ids ?? raw.assignees),
    labels: idList(raw.label_ids ?? raw.labels),
    start_date: raw.start_date ?? null,
    target_date: raw.target_date ?? null,
    description_html_summary: richTextSummary(raw.description_html),
  };
}

export function richTextSummary(value: unknown): {
  has_headings: boolean;
  has_unordered_list: boolean;
  has_ordered_list: boolean;
  has_strong: boolean;
  has_code: boolean;
} {
  const html = typeof value === "string" ? value : "";
  return {
    has_headings: /<h[1-6]\b/i.test(html),
    has_unordered_list: /<ul\b/i.test(html),
    has_ordered_list: /<ol\b/i.test(html),
    has_strong: /<strong\b|<b\b/i.test(html),
    has_code: /<code\b/i.test(html),
  };
}

export function compactProject(raw: Record<string, unknown>): CachedProject {
  return {
    id: String(raw.id),
    name: String(raw.name ?? ""),
    identifier: String(raw.identifier ?? ""),
  };
}

export function compactModule(raw: Record<string, unknown>): CachedModule {
  return { id: String(raw.id), name: String(raw.name ?? "") };
}

export function compactState(raw: Record<string, unknown>): CachedState {
  return { id: String(raw.id), name: String(raw.name ?? ""), group: raw.group ? String(raw.group) : undefined };
}

export function compactLabel(raw: Record<string, unknown>): CachedLabel {
  return { id: String(raw.id), name: String(raw.name ?? "") };
}

export function compactMember(raw: Record<string, unknown>): CachedMember | null {
  const nested = raw.member;
  if (nested && typeof nested === "object") {
    const member = nested as Record<string, unknown>;
    const id = member.id ?? raw.member_id ?? raw.id;
    if (!id) return null;
    return {
      id: String(id),
      display_name: member.display_name ? String(member.display_name) : undefined,
      email: member.email ? String(member.email) : undefined,
    };
  }
  const id = raw.member_id ?? raw.id;
  if (!id) return null;
  return {
    id: String(id),
    display_name: raw.display_name ? String(raw.display_name) : undefined,
    email: raw.email ? String(raw.email) : undefined,
  };
}

export async function planeRequest(
  deps: Deps,
  cfg: Config,
  method: string,
  path: string,
  body?: unknown,
  query?: Record<string, string | number | boolean | undefined>,
  extraHeaders?: Record<string, string>,
): Promise<unknown> {
  if (!cfg.apiKey) throw fail("CONFIG", "PLANE_API_KEY is not configured");
  if (!cfg.workspaceSlug) throw fail("CONFIG", "PLANE_WORKSPACE_SLUG is not configured");
  const keyHint = cfg.sources.apiKey === "env" ? "PLANE_API_KEY env var" : cfg.configPath;
  const url = new URL(`${apiRoot(cfg.baseUrl)}${path}`);
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  const headers: Record<string, string> = {
    Accept: "application/json",
    "X-Api-Key": cfg.apiKey,
    "User-Agent": `plane-cli/${VERSION}`,
    ...extraHeaders,
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await deps.fetch(url.toString(), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return readResponse(response, `Plane API ${method} ${path}`, keyHint);
}

export async function proRequest(
  deps: Deps,
  cfg: Config,
  path: string,
  query?: Record<string, string | number | boolean | undefined>,
): Promise<unknown> {
  if (!cfg.proBaseUrl) throw fail("CONFIG", "PLANE_PRO_BASE_URL is not configured");
  if (!cfg.proToken) throw fail("CONFIG", "PLANE_PRO_PERSONAL_TOKEN is not configured");
  const url = new URL(`${cfg.proBaseUrl.replace(/\/+$/, "")}${path}`);
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  const response = await deps.fetch(url.toString(), {
    method: "GET",
    headers: {
      Accept: "application/json",
      "X-Api-Key": cfg.proToken,
      "User-Agent": `plane-cli/${VERSION}`,
    },
  });
  return readResponse(response, `Pro Task API GET ${path}`);
}

async function readResponse(response: Response, label: string, keyHint?: string): Promise<unknown> {
  const text = await response.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  if (!response.ok) {
    const detail = extractDetail(json) || text.slice(0, 200);
    if (response.status === 429) {
      const reset = response.headers.get("x-ratelimit-reset");
      throw fail(
        "RATE_LIMIT",
        `${label} was rate limited (HTTP 429)${reset ? `; retry after ${new Date(Number(reset) * 1000).toISOString()}` : ""}`,
        429,
      );
    }
    // A rejected token and a missing membership both surface as 403 here, so name the
    // credential's origin — a stale env var shadowing config.json is the usual cause.
    const hint =
      response.status === 403 && keyHint && /token/i.test(detail) ? ` (credential from ${keyHint})` : "";
    throw fail(
      "HTTP",
      `${label} returned HTTP ${response.status}${detail ? `: ${detail}` : ""}${hint}`,
      response.status,
    );
  }
  return json;
}

function extractDetail(json: unknown): string | null {
  if (!json || typeof json !== "object") return null;
  const obj = json as Record<string, unknown>;
  const detail = obj.detail || obj.error || obj.message;
  if (typeof detail === "string") return detail;
  return null;
}

export async function mapLimit<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

export async function listAll(
  page: (cursor?: string) => Promise<unknown>,
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 50; i++) {
    const data = await page(cursor);
    const rows = asList(data);
    out.push(...rows);
    if (!data || typeof data !== "object" || Array.isArray(data)) break;
    // next_cursor is non-empty even on the last page, so next_page_results is the only
    // reliable end-of-data signal.
    const pageInfo = data as { next_cursor?: string; next_page_results?: boolean };
    const next = pageInfo.next_cursor;
    if (pageInfo.next_page_results !== true || !next || next === cursor || rows.length === 0) break;
    cursor = next;
  }
  return out;
}

export const HELP = `plane-cli — Plane CLI for AI agents

Usage:
  plane-cli <command> [flags]

Stdout is JSON. On failure the same JSON object is printed with ok=false and a non-zero exit.

Catalog:
  Projects, modules, and states are cached in $home/catalog.json.
  Default TTL is 3 days (config catalogTtlDays / PLANE_CLI_CATALOG_TTL_DAYS).
  Create/assign commands refresh the cache when it is missing or stale.

Commands:
  config show
  config init [--force]
  config set <key> <value>

  install [--prefix DIR]

  cache status
  cache refresh [--project IDENT]   Without --project this warms every reachable
                                    project and reports any it had to skip.
  cache check [--project IDENT]

  project list
  module list --project IDENT
  state list --project IDENT
  label list --project IDENT
  member list --project IDENT
  notification list [--read true|false] [--mentioned true|false] [--per-page N] [--cursor CURSOR]
  notification mark-read NOTIFICATION_ID

  issue get KEY
  issue list --project IDENT [--state NAME] [--limit N]
               --state is applied locally: the API has no work-item filters.
  issue create --project IDENT --title TEXT --start-date YYYY-MM-DD --target-date YYYY-MM-DD [--description TEXT] [--image PATH[,PATH]]
               [--module NAME] [--state NAME] [--priority P]
               [--assignee NAME] [--label NAME]
               --priority is one of urgent, high, medium, low, none. Dates are required unless an explicitly authorized
               --allow-missing-dates exception is passed.
  issue update KEY [--title TEXT] [--description TEXT] [--image PATH[,PATH]] [--start-date YYYY-MM-DD] [--target-date YYYY-MM-DD] [--state NAME] [--priority P] [--assignee NAME] [--module NAME]
  issue comment KEY --body TEXT [--image PATH[,PATH]]
  issue comment update KEY COMMENT_ID --body TEXT [--image PATH[,PATH]]

  search QUERY [--limit N]
  context [--include-members]
  digest --person NAME [--window-days N]

Global flags:
  --home DIR     Config/cache directory (default ~/.config/plane-cli)
  --refresh      Force catalog refresh before the command
  --raw          Return full API payloads
  --pretty       Pretty-print JSON
  --help
  --version

Install compiles a native binary to ~/.local/bin/plane-cli (override with --prefix).

First install from source:
  cd plane-cli && bun run src/cli.ts install

Config keys for \`config set\`:
  baseUrl, workspaceSlug, proBaseUrl, catalogTtlDays, enableProTaskApi,
  apiKey, proPersonalToken

config set never prints secret values. Config dir is 0700, config.json is 0600.

Rich text: --description and --body accept a safe Markdown subset (headings, lists, emphasis, links, and fenced code blocks)
and convert it to structured HTML. Raw HTML is escaped rather than passed through. Use a shell-safe multiline argument for
multi-paragraph content, then issue get --raw to verify description_html and dates; inspect comment.comment_html in the
comment write response.

Pro Task API is off unless enableProTaskApi / PLANE_ENABLE_PRO_TASK_API is true,
plus proBaseUrl and proPersonalToken (URL alone is not enough; apiKey is never sent to Pro).

Environment:
  PLANE_API_KEY, PLANE_WORKSPACE_SLUG, PLANE_BASE_URL
  PLANE_ENABLE_PRO_TASK_API, PLANE_PRO_BASE_URL, PLANE_PRO_PERSONAL_TOKEN
  PLANE_CLI_HOME, PLANE_CLI_CATALOG_TTL_DAYS
`;
