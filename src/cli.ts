#!/usr/bin/env bun
import {
  type Catalog,
  type Config,
  type Deps,
  type ParsedArgs,
  HELP,
  VERSION,
  compactIssue,
  compactLabel,
  compactMember,
  compactModule,
  compactProject,
  compactState,
  catalogStatus,
  defaultDeps,
  emptyCatalog,
  fail,
  flagList,
  loadCatalog,
  isSecretConfigKey,
  loadConfig,
  listAll,
  mapLimit,
  parseArgv,
  parseBool,
  planeRequest,
  proEnabled,
  proRequest,
  protectConfig,
  publicConfig,
  redactFileConfig,
  richTextSummary,
  httpStatus,
  resolveLabel,
  resolveMember,
  resolveModule,
  resolveProject,
  resolveState,
  saveCatalog,
  toHtml,
  writeConfigFile,
  CliError,
} from "./lib.ts";
import { randomUUID } from "node:crypto";
import { basename, extname } from "node:path";

type Result = Record<string, unknown>;

const PRIORITIES = ["urgent", "high", "medium", "low", "none"];

function requirePriority(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!PRIORITIES.includes(normalized)) {
    throw fail("USAGE", `--priority must be one of ${PRIORITIES.join(", ")}`);
  }
  return normalized;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function localDate(timestamp: number): string {
  const date = new Date(timestamp);
  date.setHours(12, 0, 0, 0);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function nextLocalDate(timestamp: number): string {
  const date = new Date(timestamp);
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function requireDate(value: string, flag: string): string {
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!ISO_DATE.test(value) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw fail("INVALID_DATE", `${flag} must be a valid YYYY-MM-DD date`);
  }
  return value;
}

function validateDateRange(startDate: string, targetDate: string): void {
  if (startDate > targetDate) throw fail("INVALID_DATE_RANGE", "--start-date must be on or before --target-date");
}

function requiredCreateDates(parsed: ParsedArgs, deps: Deps): { startDate?: string; targetDate?: string } {
  const startDate = parsed.flags["start-date"];
  const targetDate = parsed.flags["target-date"];
  if (!startDate || !targetDate) {
    if (parsed.flags["allow-missing-dates"]) {
      return {
        startDate: startDate ? requireDate(startDate, "--start-date") : undefined,
        targetDate: targetDate ? requireDate(targetDate, "--target-date") : undefined,
      };
    }
    const recommendedStart = localDate(deps.now());
    const recommendedTarget = nextLocalDate(deps.now());
    throw fail(
      "MISSING_DATES",
      `issue create requires --start-date and --target-date. Confirm dates first; recommended: --start-date ${recommendedStart} --target-date ${recommendedTarget}`,
    );
  }
  const dates = { startDate: requireDate(startDate, "--start-date"), targetDate: requireDate(targetDate, "--target-date") };
  validateDateRange(dates.startDate, dates.targetDate);
  return dates;
}

type WriteVerification = { startDate?: string; targetDate?: string; descriptionHtml?: string };

function verifyRichText(expectedHtml: string, actualHtml: unknown): void {
  const expected = richTextSummary(expectedHtml);
  const actual = richTextSummary(actualHtml);
  const missing = Object.entries(expected)
    .filter(([key, expectedValue]) => expectedValue && !actual[key as keyof typeof actual])
    .map(([key]) => key.replace("has_", ""));
  if (missing.length) throw fail("WRITE_VERIFY", `Plane did not persist expected rich-text structure: ${missing.join(", ")}`);
}

async function verifyIssueWrite(
  cfg: Config,
  deps: Deps,
  projectId: string,
  issueId: string,
  expected: WriteVerification,
): Promise<Record<string, unknown>> {
  const persisted = (await planeRequest(
    deps,
    cfg,
    "GET",
    `/workspaces/${cfg.workspaceSlug}/projects/${projectId}/work-items/${issueId}/`,
  )) as Record<string, unknown>;
  if (expected.startDate && persisted.start_date !== expected.startDate) {
    throw fail("WRITE_VERIFY", `Plane did not persist start_date ${expected.startDate}`);
  }
  if (expected.targetDate && persisted.target_date !== expected.targetDate) {
    throw fail("WRITE_VERIFY", `Plane did not persist target_date ${expected.targetDate}`);
  }
  if (expected.descriptionHtml) verifyRichText(expected.descriptionHtml, persisted.description_html);
  return persisted;
}

export async function run(argv: string[], deps: Deps = defaultDeps()): Promise<number> {
  const parsed = parseArgv(argv);
  try {
    if (parsed.version && !parsed.resource) {
      print(deps, parsed, { ok: true, version: VERSION });
      return 0;
    }
    if (parsed.help || !parsed.resource || parsed.resource === "help") {
      deps.stdout(HELP);
      return 0;
    }
    const cfg = loadConfig(deps, parsed);
    protectConfig(deps, cfg);
    const data = await dispatch(parsed, cfg, deps);
    print(deps, parsed, { ok: true, ...data });
    return 0;
  } catch (error) {
    const code = error instanceof CliError ? error.code : "ERROR";
    const message = error instanceof Error ? error.message : String(error);
    print(deps, parsed, { ok: false, error: message, code });
    return 1;
  }
}

function print(deps: Deps, parsed: ParsedArgs, payload: Result): void {
  deps.stdout(JSON.stringify(payload, null, parsed.pretty ? 2 : 0));
}

async function dispatch(parsed: ParsedArgs, cfg: Config, deps: Deps): Promise<Result> {
  const resource = parsed.resource!;
  const action = parsed.action;
  switch (resource) {
    case "config":
      return configCommand(action, parsed, cfg, deps);
    case "cache":
      return cacheCommand(action, parsed, cfg, deps);
    case "project":
      return projectCommand(action, parsed, cfg, deps);
    case "module":
      return moduleCommand(action, parsed, cfg, deps);
    case "state":
      return namedListCommand("state", action, parsed, cfg, deps);
    case "label":
      return namedListCommand("label", action, parsed, cfg, deps);
    case "member":
      return namedListCommand("member", action, parsed, cfg, deps);
    case "notification":
      return notificationCommand(action, parsed, cfg, deps);
    case "issue":
      return issueCommand(action, parsed, cfg, deps);
    case "search":
      return searchCommand(parsed, cfg, deps);
    case "context":
      return contextCommand(parsed, cfg, deps);
    case "digest":
      return digestCommand(parsed, cfg, deps);
    case "install":
      return installCommand(parsed, cfg, deps);
    default:
      throw fail("USAGE", `Unknown command: ${resource}. See plane-cli --help`);
  }
}

async function notificationCommand(
  action: string | undefined,
  parsed: ParsedArgs,
  cfg: Config,
  deps: Deps,
): Promise<Result> {
  if (action === "mark-read") {
    const notificationId = parsed.positionals[0];
    if (!notificationId) throw fail("USAGE", "Usage: plane-cli notification mark-read <notification-id>");
    const notification = await planeRequest(
      deps,
      cfg,
      "POST",
      `/workspaces/${encodeURIComponent(cfg.workspaceSlug)}/notifications/${encodeURIComponent(notificationId)}/read/`,
    );
    return { notification };
  }
  if (action && action !== "list") {
    throw fail("USAGE", "Usage: plane-cli notification list [--read true|false] [--mentioned true] [--per-page 20] [--cursor CURSOR] | notification mark-read <notification-id>");
  }
  const read = optionalBoolean(parsed.flags.read, "--read");
  const mentioned = optionalBoolean(parsed.flags.mentioned, "--mentioned");
  const perPage = Number(parsed.flags["per-page"] || 20);
  if (!Number.isInteger(perPage) || perPage < 1 || perPage > 100) {
    throw fail("USAGE", "--per-page must be an integer from 1 to 100");
  }
  const notifications = await planeRequest(
    deps,
    cfg,
    "GET",
    `/workspaces/${cfg.workspaceSlug}/notifications/`,
    undefined,
    { read, mentioned, per_page: perPage, cursor: parsed.flags.cursor },
  );
  return { notifications };
}

function optionalBoolean(value: string | undefined, flag: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw fail("USAGE", `${flag} must be true or false`);
}

function configCommand(action: string | undefined, parsed: ParsedArgs, cfg: Config, deps: Deps): Result {
  if (action === "show" || !action) return { config: publicConfig(cfg) };
  if (action === "init") {
    if (deps.readFile(cfg.configPath) && !parsed.force) {
      throw fail("EXISTS", `Config already exists: ${cfg.configPath} (pass --force to overwrite)`);
    }
    const template = {
      baseUrl: cfg.file.baseUrl || "https://api.plane.so",
      workspaceSlug: cfg.file.workspaceSlug || "",
      proBaseUrl: cfg.file.proBaseUrl || "",
      catalogTtlDays: cfg.file.catalogTtlDays || 3,
      enableProTaskApi: cfg.file.enableProTaskApi || false,
    };
    writeConfigFile(deps, cfg, template);
    return { wrote: cfg.configPath, config: redactFileConfig(template) };
  }
  if (action === "set") {
    const key = parsed.positionals[0];
    const value = parsed.positionals[1];
    if (!key || value === undefined) throw fail("USAGE", "Usage: plane-cli config set <key> <value>");
    const allowed = new Set([
      "baseUrl",
      "workspaceSlug",
      "proBaseUrl",
      "catalogTtlDays",
      "enableProTaskApi",
      "apiKey",
      "proPersonalToken",
    ]);
    if (!allowed.has(key)) throw fail("USAGE", `Unknown config key: ${key}`);
    const next = { ...cfg.file };
    if (key === "catalogTtlDays") {
      const days = Number(value);
      if (!Number.isFinite(days) || days <= 0) throw fail("CONFIG_INVALID", "catalogTtlDays must be a positive number");
      next.catalogTtlDays = days;
    } else if (key === "enableProTaskApi") {
      next.enableProTaskApi = parseBool(value, false);
    } else {
      (next as Record<string, string>)[key] = value;
    }
    writeConfigFile(deps, cfg, next);
    if (isSecretConfigKey(key)) return { wrote: cfg.configPath, key, saved: true };
    return { wrote: cfg.configPath, config: redactFileConfig(next) };
  }
  throw fail("USAGE", "Usage: plane-cli config show|init|set");
}

async function cacheCommand(action: string | undefined, parsed: ParsedArgs, cfg: Config, deps: Deps): Promise<Result> {
  if (action === "status" || !action) {
    const catalog = loadCatalog(deps, cfg);
    return { cache: catalogStatus(catalog, cfg, deps.now()), path: cfg.catalogPath };
  }
  if (action === "refresh") {
    const skipped: WarmSkip[] = [];
    const catalog = await refreshCatalog(parsed, cfg, deps, { warmAll: !parsed.flags.project, skipped });
    return { cache: catalogStatus(catalog, cfg, deps.now()), skipped, path: cfg.catalogPath };
  }
  if (action === "check") {
    const projectQuery = parsed.flags.project;
    const catalog = await ensureCatalog(parsed, cfg, deps, {
      needModules: Boolean(projectQuery),
      project: projectQuery,
    });
    return {
      cache: catalogStatus(catalog, cfg, deps.now()),
      project: projectQuery ? projectCatalogInfo(catalog, projectQuery) : null,
      path: cfg.catalogPath,
    };
  }
  throw fail("USAGE", "Usage: plane-cli cache status|refresh|check");
}

async function projectCommand(action: string | undefined, parsed: ParsedArgs, cfg: Config, deps: Deps): Promise<Result> {
  if (action && action !== "list") throw fail("USAGE", "Usage: plane-cli project list");
  const catalog = await ensureCatalog(parsed, cfg, deps);
  return { projects: catalog.projects };
}

async function moduleCommand(action: string | undefined, parsed: ParsedArgs, cfg: Config, deps: Deps): Promise<Result> {
  if (action && action !== "list") throw fail("USAGE", "Usage: plane-cli module list --project IDENT");
  const projectQuery = requireFlag(parsed, "project");
  const catalog = await ensureCatalog(parsed, cfg, deps, { needModules: true, project: projectQuery });
  const project = resolveProject(catalog, projectQuery);
  return { project, modules: catalog.modulesByProjectId[project.id] || [] };
}

async function namedListCommand(
  kind: "state" | "label" | "member",
  action: string | undefined,
  parsed: ParsedArgs,
  cfg: Config,
  deps: Deps,
): Promise<Result> {
  if (action && action !== "list") throw fail("USAGE", `Usage: plane-cli ${kind} list --project IDENT`);
  const projectQuery = requireFlag(parsed, "project");
  const catalog = await ensureCatalog(parsed, cfg, deps, { needModules: true, project: projectQuery });
  const project = resolveProject(catalog, projectQuery);
  if (kind === "label") await ensureProjectExtras(catalog, cfg, deps, project.id, "labels");
  if (kind === "member") await ensureProjectExtras(catalog, cfg, deps, project.id, "members");
  const key = kind === "state" ? "statesByProjectId" : kind === "label" ? "labelsByProjectId" : "membersByProjectId";
  return { project, [kind === "state" ? "states" : kind === "label" ? "labels" : "members"]: catalog[key][project.id] || [] };
}

async function issueCommand(action: string | undefined, parsed: ParsedArgs, cfg: Config, deps: Deps): Promise<Result> {
  if (action === "get") return getIssue(parsed, cfg, deps);
  if (action === "list") return listIssues(parsed, cfg, deps);
  if (action === "create") return createIssue(parsed, cfg, deps);
  if (action === "update") return updateIssue(parsed, cfg, deps);
  if (action === "comment") return commentIssue(parsed, cfg, deps);
  throw fail("USAGE", "Usage: plane-cli issue get|list|create|update|comment");
}

async function getIssue(parsed: ParsedArgs, cfg: Config, deps: Deps): Promise<Result> {
  const key = parsed.positionals[0] || parsed.flags.key;
  if (!key) throw fail("USAGE", "Usage: plane-cli issue get KEY");
  if (proEnabled(cfg)) {
    const issue = await proRequest(deps, cfg, `/task-api/issues/${encodeURIComponent(key)}`, {
      include_comments: parsed.flags["include-comments"] ? "latest" : "false",
      comments_limit: 5,
    });
    return parsed.raw ? { issue } : { issue };
  }
  const issue = (await planeRequest(
    deps,
    cfg,
    "GET",
    `/workspaces/${cfg.workspaceSlug}/work-items/${encodeURIComponent(key)}/`,
    undefined,
    { expand: "assignees,labels,state" },
  )) as Record<string, unknown>;
  return { issue: parsed.raw ? issue : compactIssue(issue, key.split("-")[0]) };
}

async function listIssues(parsed: ParsedArgs, cfg: Config, deps: Deps): Promise<Result> {
  const projectQuery = requireFlag(parsed, "project");
  const catalog = await ensureCatalog(parsed, cfg, deps, { needModules: true, project: projectQuery });
  const project = resolveProject(catalog, projectQuery);
  const limit = Number(parsed.flags.limit || 20);
  if (!Number.isFinite(limit) || limit <= 0) throw fail("USAGE", "--limit must be a positive number");
  const states = catalog.statesByProjectId[project.id];
  // /api/v1 has no filter backend on the work-item list, so a ?state= param is silently
  // dropped and the response looks filtered but is not. Page and filter here instead.
  const wanted = parsed.flags.state ? resolveState(catalog, project.id, parsed.flags.state) : null;
  const collected: Record<string, unknown>[] = [];
  let cursor: string | undefined;
  let more = false;
  for (let page = 0; page < (wanted ? 20 : 1); page++) {
    const data = await planeRequest(
      deps,
      cfg,
      "GET",
      `/workspaces/${cfg.workspaceSlug}/projects/${project.id}/work-items/`,
      undefined,
      { per_page: wanted ? 100 : limit, expand: "state", cursor },
    );
    const rows = asIssueList(data);
    collected.push(...(wanted ? rows.filter((row) => issueStateId(row) === wanted.id) : rows));
    const envelope = (data && typeof data === "object" ? data : {}) as {
      next_cursor?: string;
      next_page_results?: boolean;
    };
    more = envelope.next_page_results === true;
    if (!wanted || collected.length >= limit || !more || !envelope.next_cursor) break;
    cursor = envelope.next_cursor;
  }
  const results = collected.slice(0, limit);
  return {
    project,
    state: wanted ? wanted.name : null,
    issues: parsed.raw ? results : results.map((item) => compactIssue(item, project.identifier, states)),
    has_more: more || collected.length > results.length,
  };
}

function issueStateId(raw: Record<string, unknown>): string | null {
  const state = raw.state;
  if (state && typeof state === "object") return String((state as { id?: unknown }).id ?? "");
  return typeof state === "string" ? state : null;
}

async function createIssue(parsed: ParsedArgs, cfg: Config, deps: Deps): Promise<Result> {
  const projectQuery = requireFlag(parsed, "project");
  const title = parsed.flags.title || parsed.flags.name;
  if (!title) throw fail("USAGE", "issue create requires --title");
  const dates = requiredCreateDates(parsed, deps);
  const catalog = await ensureCatalog(parsed, cfg, deps, { needModules: true, project: projectQuery });
  const project = resolveProject(catalog, projectQuery);
  if (parsed.flags.assignee || parsed.flags.label) {
    await ensureProjectExtras(catalog, cfg, deps, project.id, parsed.flags.assignee ? "members" : "labels");
    if (parsed.flags.assignee && parsed.flags.label) await ensureProjectExtras(catalog, cfg, deps, project.id, "labels");
  }
  const body: Record<string, unknown> = { name: title };
  if (dates.startDate) body.start_date = dates.startDate;
  if (dates.targetDate) body.target_date = dates.targetDate;
  const imageAssets = await prepareDescriptionImages(parsed, cfg, deps, project.id, "ISSUE_DESCRIPTION");
  if (parsed.flags.description || imageAssets.length) body.description_html = withImages(toHtml(parsed.flags.description || ""), imageAssets);
  if (parsed.flags.priority) body.priority = requirePriority(parsed.flags.priority);
  if (parsed.flags.state) body.state = resolveState(catalog, project.id, parsed.flags.state).id;
  if (parsed.flags.assignee) body.assignees = [resolveMember(catalog, project.id, parsed.flags.assignee).id];
  if (parsed.flags.label) {
    body.labels = flagList(parsed.flags, "label").map((name) => resolveLabel(catalog, project.id, name).id);
  }
  const created = (await planeRequest(
    deps,
    cfg,
    "POST",
    `/workspaces/${cfg.workspaceSlug}/projects/${project.id}/work-items/`,
    body,
  )) as Record<string, unknown>;
  await bindDescriptionImages(cfg, deps, project.id, "ISSUE_DESCRIPTION", String(created.id), imageAssets);
  if (parsed.flags.module) {
    const mod = resolveModule(catalog, project.id, parsed.flags.module);
    await planeRequest(
      deps,
      cfg,
      "POST",
      `/workspaces/${cfg.workspaceSlug}/projects/${project.id}/modules/${mod.id}/module-issues/`,
      { issues: [created.id] },
    );
  }
  const persisted = await verifyIssueWrite(cfg, deps, project.id, String(created.id), {
    ...dates,
    descriptionHtml: typeof body.description_html === "string" ? body.description_html : undefined,
  });
  const states = catalog.statesByProjectId[project.id];
  return { issue: parsed.raw ? persisted : compactIssue(persisted, project.identifier, states), project };
}

async function updateIssue(parsed: ParsedArgs, cfg: Config, deps: Deps): Promise<Result> {
  const key = parsed.positionals[0] || parsed.flags.key;
  if (!key) throw fail("USAGE", "Usage: plane-cli issue update KEY");
  const current = (await planeRequest(
    deps,
    cfg,
    "GET",
    `/workspaces/${cfg.workspaceSlug}/work-items/${encodeURIComponent(key)}/`,
  )) as Record<string, unknown>;
  const projectId = String(current.project);
  const catalog = await ensureCatalog(parsed, cfg, deps, { needModules: true, project: projectId });
  const project = resolveProject(catalog, projectId);
  const body: Record<string, unknown> = {};
  const imageAssets = await prepareDescriptionImages(parsed, cfg, deps, project.id, "ISSUE_DESCRIPTION");
  if (parsed.flags.title || parsed.flags.name) body.name = parsed.flags.title || parsed.flags.name;
  if (parsed.flags.description || imageAssets.length) {
    const description = parsed.flags.description ? toHtml(parsed.flags.description) : String(current.description_html || "");
    body.description_html = withImages(description, imageAssets);
  }
  if (parsed.flags.priority) body.priority = requirePriority(parsed.flags.priority);
  if (parsed.flags["start-date"]) body.start_date = requireDate(parsed.flags["start-date"], "--start-date");
  if (parsed.flags["target-date"]) body.target_date = requireDate(parsed.flags["target-date"], "--target-date");
  const effectiveStartDate = String(body.start_date || current.start_date || "");
  const effectiveTargetDate = String(body.target_date || current.target_date || "");
  if (effectiveStartDate && effectiveTargetDate) validateDateRange(effectiveStartDate, effectiveTargetDate);
  if (parsed.flags.state) body.state = resolveState(catalog, project.id, parsed.flags.state).id;
  if (parsed.flags.assignee) {
    await ensureProjectExtras(catalog, cfg, deps, project.id, "members");
    body.assignees = [resolveMember(catalog, project.id, parsed.flags.assignee).id];
  }
  if (Object.keys(body).length === 0 && !parsed.flags.module) {
    throw fail("USAGE", "issue update needs at least one field flag");
  }
  const updated = Object.keys(body).length
    ? ((await planeRequest(
        deps,
        cfg,
        "PATCH",
        `/workspaces/${cfg.workspaceSlug}/projects/${project.id}/work-items/${current.id}/`,
        body,
      )) as Record<string, unknown>)
    : current;
  await bindDescriptionImages(cfg, deps, project.id, "ISSUE_DESCRIPTION", String(updated.id), imageAssets);
  if (parsed.flags.module) {
    const mod = resolveModule(catalog, project.id, parsed.flags.module);
    await planeRequest(
      deps,
      cfg,
      "POST",
      `/workspaces/${cfg.workspaceSlug}/projects/${project.id}/modules/${mod.id}/module-issues/`,
      { issues: [updated.id] },
    );
  }
  const states = catalog.statesByProjectId[project.id];
  if (Object.keys(body).length === 0) return { issue: parsed.raw ? updated : compactIssue(updated, project.identifier, states), project };
  const persisted = await verifyIssueWrite(cfg, deps, project.id, String(updated.id), {
    startDate: typeof body.start_date === "string" ? body.start_date : undefined,
    targetDate: typeof body.target_date === "string" ? body.target_date : undefined,
    descriptionHtml: typeof body.description_html === "string" ? body.description_html : undefined,
  });
  return { issue: parsed.raw ? persisted : compactIssue(persisted, project.identifier, states), project };
}

async function commentIssue(parsed: ParsedArgs, cfg: Config, deps: Deps): Promise<Result> {
  const updating = parsed.positionals[0] === "update";
  const key = (updating ? parsed.positionals[1] : parsed.positionals[0]) || parsed.flags.key;
  const existingCommentId = updating ? parsed.positionals[2] || parsed.flags["comment-id"] : undefined;
  const bodyText = parsed.flags.body;
  if (!key || !bodyText || (updating && !existingCommentId)) {
    throw fail("USAGE", "Usage: plane-cli issue comment KEY --body TEXT | issue comment update KEY COMMENT_ID --body TEXT");
  }
  if (updating && !UUID_PATTERN.test(existingCommentId!)) {
    throw fail("USAGE", "COMMENT_ID must be a UUID");
  }
  const current = (await planeRequest(
    deps,
    cfg,
    "GET",
    `/workspaces/${cfg.workspaceSlug}/work-items/${encodeURIComponent(key)}/`,
  )) as Record<string, unknown>;
  const imageAssets = await prepareDescriptionImages(parsed, cfg, deps, String(current.project), "COMMENT_DESCRIPTION");
  const commentHtml = withImages(toHtml(bodyText), imageAssets);
  const comment = updating
    ? await planeRequest(
        deps,
        cfg,
        "PATCH",
        `/workspaces/${cfg.workspaceSlug}/projects/${current.project}/work-items/${current.id}/comments/${encodeURIComponent(existingCommentId!)}/`,
        { comment_html: commentHtml },
      )
    : await planeRequest(
        deps,
        cfg,
        "POST",
        `/workspaces/${cfg.workspaceSlug}/projects/${current.project}/work-items/${current.id}/comments/`,
        { comment_html: commentHtml },
      );
  if (imageAssets.length) {
    const commentId = updating ? existingCommentId! : String((comment as Record<string, unknown>).id || "");
    if (!commentId) throw fail("ASSET_BIND", "Plane did not return a comment ID required to bind inline images");
    await bindDescriptionImages(cfg, deps, String(current.project), "COMMENT_DESCRIPTION", commentId, imageAssets);
  }
  return { comment };
}

type DescriptionAsset = { id: string; name: string; content_type: string; size: number };
type AssetTarget = "ISSUE_DESCRIPTION" | "COMMENT_DESCRIPTION";

const IMAGE_CONTENT_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function prepareDescriptionImages(
  parsed: ParsedArgs,
  cfg: Config,
  deps: Deps,
  projectId: string,
  targetType: AssetTarget,
): Promise<DescriptionAsset[]> {
  const paths = flagList(parsed.flags, "image");
  if (!paths.length) return [];
  if (!deps.readImageFile) throw fail("IMAGE_READ", "Image file access is not available in this runtime");
  const assets: DescriptionAsset[] = [];
  for (const path of paths) {
    const file = deps.readImageFile(path);
    if (!file || !file.isFile || file.size <= 0 || file.bytes.length === 0) {
      throw fail("IMAGE_INVALID", "Each --image value must name a non-empty regular file");
    }
    const name = basename(path);
    const contentType = IMAGE_CONTENT_TYPES[extname(name).toLowerCase()];
    if (!contentType) throw fail("IMAGE_INVALID", "Images must be JPEG, PNG, WebP, or GIF files");
    assets.push(await uploadDescriptionImage(cfg, deps, projectId, targetType, { name, contentType, size: file.size, bytes: file.bytes }));
  }
  return assets;
}

async function uploadDescriptionImage(
  cfg: Config,
  deps: Deps,
  projectId: string,
  targetType: AssetTarget,
  image: { name: string; contentType: string; size: number; bytes: Uint8Array },
): Promise<DescriptionAsset> {
  const path = `/workspaces/${cfg.workspaceSlug}/projects/${projectId}/description-assets/`;
  let created: Record<string, unknown>;
  try {
    created = (await planeRequest(deps, cfg, "POST", path, {
      name: image.name,
      content_type: image.contentType,
      size: image.size,
      target_type: targetType,
    })) as Record<string, unknown>;
  } catch (error) {
    if (httpStatus(error) === 404) {
      throw fail(
        "DESCRIPTION_ASSET_API_UNAVAILABLE",
        "The target Plane server has not deployed the description-assets API required for inline images",
        404,
      );
    }
    throw descriptionAssetFailure(error, "ASSET_CREATE", "Plane could not create an inline-image upload session");
  }
  const assetId = typeof created.asset_id === "string" ? created.asset_id : "";
  const uploadData = created.upload_data as { url?: unknown; fields?: unknown } | undefined;
  if (!UUID_PATTERN.test(assetId) || !uploadData || typeof uploadData.url !== "string" || !uploadData.fields || typeof uploadData.fields !== "object") {
    throw fail("ASSET_RESPONSE", "Plane returned an invalid description-image upload session");
  }
  const form = new FormData();
  for (const [key, value] of Object.entries(uploadData.fields as Record<string, unknown>)) {
    if (typeof value !== "string") throw fail("ASSET_RESPONSE", "Plane returned invalid description-image upload fields");
    form.set(key, value);
  }
  form.set("file", new Blob([image.bytes.slice().buffer as ArrayBuffer], { type: image.contentType }), image.name);
  let uploadResponse: Response;
  try {
    uploadResponse = await deps.fetch(uploadData.url, { method: "POST", body: form });
  } catch {
    throw fail("ASSET_UPLOAD", "Direct image upload failed before the server could confirm it");
  }
  if (!uploadResponse.ok) throw fail("ASSET_UPLOAD", `Direct image upload failed (HTTP ${uploadResponse.status})`, uploadResponse.status);
  const confirmed = await confirmDescriptionImage(cfg, deps, `${path}${assetId}/confirm/`);
  if (confirmed.state !== "confirmed") throw fail("ASSET_CONFIRM", "Plane did not confirm the uploaded inline image");
  return { id: assetId, name: image.name, content_type: image.contentType, size: image.size };
}

async function confirmDescriptionImage(cfg: Config, deps: Deps, path: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return (await planeRequest(deps, cfg, "PATCH", path)) as Record<string, unknown>;
    } catch (error) {
      const status = httpStatus(error);
      if (status === 409) {
        throw descriptionAssetFailure(error, "ASSET_CONFIRM_CONFLICT", "Inline-image confirmation conflicted; no target was written");
      }
      if (status === 503 && attempt === 0) {
        await transientBackoff(deps, attempt);
        continue;
      }
      throw descriptionAssetFailure(error, "ASSET_CONFIRM", "Plane could not confirm the uploaded inline image");
    }
  }
  throw fail("ASSET_CONFIRM", "Plane could not confirm the uploaded inline image");
}

function withImages(html: string, assets: DescriptionAsset[]): string {
  if (!assets.length) return html;
  const images = assets.map(
    (asset) => `<image-component src="${asset.id}" width="100%" height="auto" alignment="left" status="uploaded"></image-component>`,
  );
  return [html, ...images].filter(Boolean).join("\n");
}

async function bindDescriptionImages(
  cfg: Config,
  deps: Deps,
  projectId: string,
  targetType: AssetTarget,
  targetId: string,
  assets: DescriptionAsset[],
): Promise<void> {
  if (!assets.length) return;
  const path = `/workspaces/${cfg.workspaceSlug}/projects/${projectId}/description-assets/bind/`;
  const idempotencyKey = deps.randomUUID ? deps.randomUUID() : randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await planeRequest(
        deps,
        cfg,
        "POST",
        path,
        { target_type: targetType, target_id: targetId, asset_ids: assets.map((asset) => asset.id) },
        undefined,
        { "Idempotency-Key": idempotencyKey },
      );
      return;
    } catch (error) {
      const status = httpStatus(error);
      if (status === 409) {
        throw descriptionAssetFailure(error, "ASSET_BIND_CONFLICT", "Inline-image binding conflicted; no follow-up write was performed");
      }
      if (status !== 503 || attempt === 1) {
        throw descriptionAssetFailure(error, "ASSET_BIND", "Plane could not bind inline images to the target");
      }
      await transientBackoff(deps, attempt);
    }
  }
}

async function transientBackoff(deps: Deps, attempt: number): Promise<void> {
  await (deps.delay?.(100 * (attempt + 1)) || Promise.resolve());
}

function descriptionAssetFailure(error: unknown, code: string, message: string): CliError {
  const status = httpStatus(error);
  return fail(code, `${message}${status ? ` (HTTP ${status})` : ""}`, status);
}

async function searchCommand(parsed: ParsedArgs, cfg: Config, deps: Deps): Promise<Result> {
  const q = parsed.action || parsed.positionals[0] || parsed.flags.q;
  if (!q) throw fail("USAGE", "Usage: plane-cli search QUERY");
  const limit = Number(parsed.flags.limit || 20);
  if (proEnabled(cfg)) {
    const result = await proRequest(deps, cfg, "/task-api/search", {
      q,
      limit,
      include_description: true,
      include_comments: false,
    });
    return { result };
  }
  const result = await planeRequest(deps, cfg, "GET", `/workspaces/${cfg.workspaceSlug}/work-items/search/`, undefined, {
    search: q,
    limit,
  });
  return { result };
}

async function contextCommand(parsed: ParsedArgs, cfg: Config, deps: Deps): Promise<Result> {
  requirePro(cfg);
  const includeMembers = parsed.flags["include-members"] !== "false";
  const result = await proRequest(deps, cfg, "/task-api/context", { include_members: includeMembers });
  return { result };
}

async function digestCommand(parsed: ParsedArgs, cfg: Config, deps: Deps): Promise<Result> {
  requirePro(cfg);
  const person = parsed.flags.person || parsed.action;
  if (!person || person === "--person") throw fail("USAGE", "Usage: plane-cli digest --person NAME");
  const result = await proRequest(deps, cfg, "/task-api/person-digest", {
    person,
    window_days: Number(parsed.flags["window-days"] || 7),
    timezone: parsed.flags.timezone || "Asia/Shanghai",
    include_attention: true,
    limit: Number(parsed.flags.limit || 20),
  });
  return { result };
}

async function ensureCatalog(
  parsed: ParsedArgs,
  cfg: Config,
  deps: Deps,
  opts: { needModules?: boolean; project?: string } = {},
): Promise<Catalog> {
  const existing = loadCatalog(deps, cfg);
  const status = catalogStatus(existing, cfg, deps.now());
  const workspaceMismatch = existing && existing.workspace && existing.workspace !== cfg.workspaceSlug;
  const catalog =
    parsed.refresh || !existing || status.stale || workspaceMismatch
      ? await refreshCatalog(parsed, cfg, deps)
      : existing;
  if (opts.needModules && opts.project) {
    const project = resolveProject(catalog, opts.project);
    if (catalog.modulesByProjectId[project.id] == null || catalog.statesByProjectId[project.id] == null) {
      await refreshProjectCatalog(catalog, cfg, deps, project.id);
      saveCatalog(deps, cfg, catalog);
    }
  }
  return catalog;
}

function projectCatalogInfo(catalog: Catalog, query: string) {
  const project = resolveProject(catalog, query);
  const modules = catalog.modulesByProjectId[project.id];
  const states = catalog.statesByProjectId[project.id];
  return {
    ...project,
    modulesLoaded: modules != null,
    statesLoaded: states != null,
    moduleCount: modules?.length ?? 0,
    stateCount: states?.length ?? 0,
  };
}

async function installCommand(parsed: ParsedArgs, cfg: Config, deps: Deps): Promise<Result> {
  const prefix = parsed.flags.prefix || `${deps.homedir}/.local/bin`;
  const outfile = `${prefix.replace(/\/+$/, "")}/plane-cli`;
  deps.mkdirp(prefix);
  if (!deps.compile) throw fail("INSTALL", "compile is not available in this environment");
  await deps.compile(outfile);
  return { installed: outfile, configPath: cfg.configPath, hint: "Ensure the install prefix is on PATH" };
}

async function refreshCatalog(
  parsed: ParsedArgs,
  cfg: Config,
  deps: Deps,
  opts: { warmAll?: boolean; skipped?: WarmSkip[] } = {},
): Promise<Catalog> {
  const catalog = emptyCatalog(cfg.workspaceSlug, new Date(deps.now()).toISOString());
  const rows = await listAll((cursor) =>
    planeRequest(deps, cfg, "GET", `/workspaces/${cfg.workspaceSlug}/projects/`, undefined, {
      per_page: 100,
      cursor,
    }),
  );
  catalog.projects = rows.map(compactProject);
  const only = parsed.flags.project;
  // Warming states/modules is per-project work that a plain `project list` never needs,
  // and each call is gated by project (not workspace) membership. Only warm on demand.
  const targets = only
    ? [resolveProject(catalog, only)]
    : opts.warmAll
      ? rows.filter(isWarmableProject).map(compactProject)
      : [];
  const failures = await mapLimit(targets, WARM_CONCURRENCY, (project) =>
    refreshProjectCatalog(catalog, cfg, deps, project.id, { tolerate: !only }).then((reason) =>
      reason ? { project: project.identifier || project.id, reason } : null,
    ),
  );
  saveCatalog(deps, cfg, catalog);
  opts.skipped?.push(...failures.filter((entry): entry is WarmSkip => entry !== null));
  return catalog;
}

// The API throttles per key (default 60/min) and the proxy drops large connection bursts,
// so a workspace-wide warm is paced rather than fired all at once.
const WARM_CONCURRENCY = 4;

type WarmSkip = { project: string; reason: string };

// States and modules sit behind ProjectEntityPermission (active project membership) and
// are always empty for archived projects, so warming those is a guaranteed 403 or no-op.
function isWarmableProject(raw: Record<string, unknown>): boolean {
  return raw.is_member !== false && !raw.archived_at;
}

async function refreshProjectCatalog(
  catalog: Catalog,
  cfg: Config,
  deps: Deps,
  projectId: string,
  opts: { tolerate?: boolean } = {},
): Promise<string | null> {
  try {
    const [modules, states] = await Promise.all([
    listAll((cursor) =>
      planeRequest(deps, cfg, "GET", `/workspaces/${cfg.workspaceSlug}/projects/${projectId}/modules/`, undefined, {
        per_page: 100,
        cursor,
      }),
    ),
    listAll((cursor) =>
      planeRequest(deps, cfg, "GET", `/workspaces/${cfg.workspaceSlug}/projects/${projectId}/states/`, undefined, {
        per_page: 100,
        cursor,
      }),
    ),
    ]);
    catalog.modulesByProjectId[projectId] = modules.map(compactModule);
    catalog.statesByProjectId[projectId] = states.map(compactState);
    return null;
  } catch (error) {
    // A bulk warm must not fail because one project is unreachable or the server errored
    // on it. Leave the entry unset so an explicit `state list --project X` still reports
    // the real failure, and hand the reason back so the caller can surface it.
    if (!opts.tolerate) throw error;
    return error instanceof Error ? error.message : String(error);
  }
}

async function ensureProjectExtras(
  catalog: Catalog,
  cfg: Config,
  deps: Deps,
  projectId: string,
  kind: "labels" | "members",
): Promise<void> {
  const bag = kind === "labels" ? catalog.labelsByProjectId : catalog.membersByProjectId;
  if (bag[projectId]?.length) return;
  const path =
    kind === "labels"
      ? `/workspaces/${cfg.workspaceSlug}/projects/${projectId}/labels/`
      : `/workspaces/${cfg.workspaceSlug}/projects/${projectId}/members/`;
  const rows = await listAll((cursor) => planeRequest(deps, cfg, "GET", path, undefined, { per_page: 100, cursor }));
  if (kind === "labels") catalog.labelsByProjectId[projectId] = rows.map(compactLabel);
  else catalog.membersByProjectId[projectId] = rows.map(compactMember).filter((row): row is NonNullable<typeof row> => Boolean(row));
  saveCatalog(deps, cfg, catalog);
}

function requirePro(cfg: Config): void {
  if (!proEnabled(cfg)) {
    throw fail(
      "CONFIG",
      "Pro Task API is disabled. Set enableProTaskApi true or PLANE_ENABLE_PRO_TASK_API=true, plus proBaseUrl and token",
    );
  }
}

function requireFlag(parsed: ParsedArgs, name: string): string {
  const value = parsed.flags[name];
  if (!value) throw fail("USAGE", `Missing --${name}`);
  return value;
}

function asIssueList(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  if (data && typeof data === "object" && Array.isArray((data as { results?: unknown }).results)) {
    return (data as { results: Record<string, unknown>[] }).results;
  }
  return [];
}

if (import.meta.main) {
  process.exit(await run(process.argv.slice(2)));
}
