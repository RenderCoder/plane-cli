import { describe, expect, test } from "bun:test";
import { run } from "./cli.ts";
import { DEFAULT_TTL_DAYS, type Deps } from "./lib.ts";

function memoryDeps(opts?: { now?: number; fetch?: Deps["fetch"] }): {
  deps: Deps;
  files: Map<string, string>;
  modes: Map<string, number>;
  calls: string[];
} {
  const files = new Map<string, string>();
  const modes = new Map<string, number>();
  const calls: string[] = [];
  const deps: Deps = {
    env: {
      PLANE_API_KEY: "test-key",
      PLANE_WORKSPACE_SLUG: "rti-tek",
      PLANE_BASE_URL: "https://plane.example",
    },
    homedir: "/tmp/fake-home",
    now: () => opts?.now ?? Date.parse("2026-09-10T00:00:00Z"),
    readFile: (path) => files.get(path) ?? null,
    writeFile: (path, data) => {
      files.set(path, data);
    },
    mkdirp: () => {},
    chmod: (path, mode) => {
      modes.set(path, mode);
    },
    fetch:
      opts?.fetch ||
      (async (input) => {
        calls.push(String(input));
        return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
      }),
    stdout: () => {},
    stderr: () => {},
  };
  return { deps, files, modes, calls };
}

function capture(deps: Deps): { out: string[] } {
  const out: string[] = [];
  deps.stdout = (s) => out.push(s.trimEnd());
  return { out };
}

describe("config and cache", () => {
  test("config init writes local ttl file", async () => {
    const { deps, files } = memoryDeps();
    const { out } = capture(deps);
    const code = await run(["config", "init"], deps);
    expect(code).toBe(0);
    const path = "/tmp/fake-home/.config/plane-cli/config.json";
    expect(files.get(path)).toContain(`"catalogTtlDays": ${DEFAULT_TTL_DAYS}`);
    expect(JSON.parse(out[0]).ok).toBe(true);
  });

  test("config set stores apiKey without printing it", async () => {
    const { deps, files, modes } = memoryDeps();
    const { out } = capture(deps);
    expect(await run(["config", "init"], deps)).toBe(0);
    expect(await run(["config", "set", "apiKey", "secret-token"], deps)).toBe(0);
    expect(await run(["config", "show"], deps)).toBe(0);
    expect(out.join("\n")).not.toContain("secret-token");
    const setPayload = JSON.parse(out[1]);
    expect(setPayload.saved).toBe(true);
    expect(setPayload.key).toBe("apiKey");
    const show = JSON.parse(out[2]);
    expect(show.config.apiKeyConfigured).toBe(true);
    expect(show.config.enableProTaskApi).toBe(false);
    expect(files.get("/tmp/fake-home/.config/plane-cli/config.json")).toContain("secret-token");
    expect(modes.get("/tmp/fake-home/.config/plane-cli")).toBe(0o700);
    expect(modes.get("/tmp/fake-home/.config/plane-cli/config.json")).toBe(0o600);
  });

  test("config set stores proPersonalToken without printing it", async () => {
    const { deps, files } = memoryDeps();
    deps.env = { ...deps.env };
    delete deps.env.PLANE_API_KEY;
    delete deps.env.PLANE_PRO_PERSONAL_TOKEN;
    const { out } = capture(deps);
    expect(await run(["config", "init"], deps)).toBe(0);
    expect(await run(["config", "set", "proBaseUrl", "https://pro.example"], deps)).toBe(0);
    expect(await run(["config", "set", "proPersonalToken", "pro-secret-token"], deps)).toBe(0);
    expect(await run(["config", "show"], deps)).toBe(0);
    const dumped = out.join("\n");
    expect(dumped).not.toContain("pro-secret-token");
    const setPayload = JSON.parse(out[2]);
    expect(setPayload.saved).toBe(true);
    expect(setPayload.key).toBe("proPersonalToken");
    expect(setPayload).not.toHaveProperty("value");
    const show = JSON.parse(out[3]);
    expect(show.config.proTokenConfigured).toBe(true);
    expect(show.config).not.toHaveProperty("proPersonalToken");
    expect(show.config).not.toHaveProperty("proToken");
    expect(files.get("/tmp/fake-home/.config/plane-cli/config.json")).toContain("pro-secret-token");
  });

  test("reads an existing config when sandbox permissions deny chmod", async () => {
    const { deps, files } = memoryDeps();
    files.set(
      "/tmp/fake-home/.config/plane-cli/config.json",
      JSON.stringify({ workspaceSlug: "rti-tek", apiKey: "test-key" }),
    );
    deps.chmod = () => {
      const error = new Error("operation not permitted") as NodeJS.ErrnoException;
      error.code = "EPERM";
      throw error;
    };
    const { out } = capture(deps);

    expect(await run(["config", "show"], deps)).toBe(0);
    expect(JSON.parse(out[0]).config.apiKeyConfigured).toBe(true);
  });

  test("search stays on standard API until Pro is explicitly enabled", async () => {
    const keys: string[] = [];
    const { deps } = memoryDeps({
      fetch: async (input, init) => {
        const url = String(input);
        const headers = (init?.headers || {}) as Record<string, string>;
        keys.push(`${url} ${headers["X-Api-Key"] || ""}`);
        if (url.includes("/task-api/")) return json({ used: "pro" });
        return json({ used: "standard" });
      },
    });
    deps.env.PLANE_PRO_BASE_URL = "https://pro.example";
    deps.env.PLANE_PRO_PERSONAL_TOKEN = "pro-token";
    const { out } = capture(deps);
    expect(await run(["search", "login"], deps)).toBe(0);
    expect(JSON.parse(out[0]).result.used).toBe("standard");
    deps.env.PLANE_ENABLE_PRO_TASK_API = "true";
    expect(await run(["search", "login"], deps)).toBe(0);
    expect(JSON.parse(out[1]).result.used).toBe("pro");
    expect(keys.some((row) => row.includes("pro.example") && row.endsWith(" pro-token"))).toBe(true);
    expect(keys.some((row) => row.includes("pro.example") && row.endsWith(" test-key"))).toBe(false);
  });

  test("does not send standard apiKey to Pro when pro token is missing", async () => {
    const calls: { url: string; apiKey?: string }[] = [];
    const { deps } = memoryDeps({
      fetch: async (input, init) => {
        const url = String(input);
        const headers = (init?.headers || {}) as Record<string, string>;
        calls.push({ url, apiKey: headers["X-Api-Key"] });
        if (url.includes("/task-api/") || url.includes("pro.example")) return json({ used: "pro" });
        return json({ used: "standard" });
      },
    });
    deps.env.PLANE_PRO_BASE_URL = "https://pro.example";
    deps.env.PLANE_ENABLE_PRO_TASK_API = "true";
    const { out } = capture(deps);
    expect(await run(["search", "login"], deps)).toBe(0);
    expect(JSON.parse(out[0]).result.used).toBe("standard");
    expect(calls.some((c) => c.url.includes("/task-api/") || c.url.includes("pro.example"))).toBe(false);
    expect(calls.every((c) => c.apiKey === "test-key")).toBe(true);

    expect(await run(["context"], deps)).toBe(1);
    const ctx = JSON.parse(out[1]);
    expect(ctx.ok).toBe(false);
    expect(ctx.code).toBe("CONFIG");
    expect(calls.filter((c) => c.url.includes("pro.example"))).toEqual([]);
  });

  test("cache status reports missing catalog as stale", async () => {
    const { deps } = memoryDeps();
    const { out } = capture(deps);
    const code = await run(["cache", "status"], deps);
    expect(code).toBe(0);
    const payload = JSON.parse(out[0]);
    expect(payload.cache.present).toBe(false);
    expect(payload.cache.stale).toBe(true);
    expect(payload.cache.ttlDays).toBe(3);
  });
});

describe("cache check --project", () => {
  test("loads the requested project's modules after a single-project refresh", async () => {
    const calls: string[] = [];
    const fetchImpl: Deps["fetch"] = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/projects/") && !url.includes("/modules/") && !url.includes("/states/") && !url.includes("/work-items/")) {
        return json([
          { id: "p1", name: "Silicon", identifier: "SIL" },
          { id: "p2", name: "App", identifier: "APP" },
        ]);
      }
      if (url.includes("/projects/p1/modules/")) return json([{ id: "m1", name: "CLI" }]);
      if (url.includes("/projects/p1/states/")) return json([{ id: "s1", name: "Todo" }]);
      if (url.includes("/projects/p2/modules/")) return json([{ id: "m2", name: "API" }]);
      if (url.includes("/projects/p2/states/")) return json([{ id: "s2", name: "Backlog" }]);
      return json([]);
    };
    const { deps, files } = memoryDeps({ fetch: fetchImpl });
    const { out } = capture(deps);

    expect(await run(["cache", "refresh", "--project", "SIL"], deps)).toBe(0);
    const afterRefresh = JSON.parse(files.get("/tmp/fake-home/.config/plane-cli/catalog.json")!);
    expect(afterRefresh.projects.map((p: { identifier: string }) => p.identifier)).toEqual(["SIL", "APP"]);
    expect(afterRefresh.modulesByProjectId.p1[0].name).toBe("CLI");
    expect(afterRefresh.modulesByProjectId.p2).toBeUndefined();
    expect(JSON.parse(out[0]).cache.projectsWithModules).toBe(1);

    const checkCode = await run(["cache", "check", "--project", "APP"], deps);
    expect(checkCode).toBe(0);
    const check = JSON.parse(out[1]);
    expect(check.ok).toBe(true);
    expect(check.project.identifier).toBe("APP");
    expect(check.project.modulesLoaded).toBe(true);
    expect(check.project.statesLoaded).toBe(true);
    expect(check.project.moduleCount).toBe(1);
    expect(check.cache.projectsWithModules).toBe(2);
    expect(calls.some((url) => url.includes("/projects/p2/modules/"))).toBe(true);
    expect(calls.some((url) => url.includes("/projects/p2/states/"))).toBe(true);

    const afterCheck = JSON.parse(files.get("/tmp/fake-home/.config/plane-cli/catalog.json")!);
    expect(afterCheck.modulesByProjectId.p2[0].name).toBe("API");
    expect(afterCheck.statesByProjectId.p2[0].name).toBe("Backlog");
  });
});

describe("install", () => {
  test("compiles a binary into ~/.local/bin", async () => {
    const { deps, files } = memoryDeps();
    deps.compile = async (outfile) => {
      files.set(outfile, "binary");
    };
    const { out } = capture(deps);
    expect(await run(["install"], deps)).toBe(0);
    const payload = JSON.parse(out[0]);
    expect(payload.installed).toBe("/tmp/fake-home/.local/bin/plane-cli");
    expect(files.get("/tmp/fake-home/.local/bin/plane-cli")).toBe("binary");
  });
});

describe("fresh catalog", () => {
  test("skips project fetch when cache is within ttl", async () => {
    const calls: string[] = [];
    const { deps, files } = memoryDeps({
      now: Date.parse("2026-09-10T00:00:00Z"),
      fetch: async (input) => {
        calls.push(String(input));
        return json([]);
      },
    });
    files.set(
      "/tmp/fake-home/.config/plane-cli/catalog.json",
      JSON.stringify({
        fetchedAt: "2026-09-09T00:00:00Z",
        workspace: "rti-tek",
        projects: [{ id: "p1", name: "Silicon", identifier: "SIL" }],
        modulesByProjectId: { p1: [{ id: "m1", name: "CLI" }] },
        statesByProjectId: { p1: [{ id: "s1", name: "Todo" }] },
        labelsByProjectId: {},
        membersByProjectId: {},
      }),
    );
    const { out } = capture(deps);
    const code = await run(["module", "list", "--project", "SIL"], deps);
    expect(code).toBe(0);
    expect(calls).toEqual([]);
    expect(JSON.parse(out[0]).modules[0].name).toBe("CLI");
  });
});

describe("issue create", () => {
  test("refreshes stale catalog then creates and assigns module", async () => {
    const calls: { method: string; url: string; body?: unknown }[] = [];
    const fetchImpl: Deps["fetch"] = async (input, init) => {
      const url = String(input);
      const method = init?.method || "GET";
      let body: unknown;
      if (typeof init?.body === "string") body = JSON.parse(init.body);
      calls.push({ method, url, body });
      if (url.includes("/projects/") && url.endsWith("/projects/?per_page=100")) {
        return json([{ id: "p1", name: "Silicon", identifier: "SIL" }]);
      }
      if (url.includes("/modules/")) return json([{ id: "m1", name: "CLI" }]);
      if (url.includes("/states/")) return json([{ id: "s1", name: "Todo", group: "unstarted" }]);
      if (url.includes("/projects/p1/work-items/i9/")) {
        return json({ id: "i9", name: "Ship CLI", sequence_id: 1, priority: "medium", start_date: "2026-09-10", target_date: "2026-09-11", description_html: "<h2>Scope</h2><ul><li>ship</li></ul>" });
      }
      if (method === "POST" && url.includes("/work-items/")) {
        return json({ id: "i9", name: "Ship CLI", sequence_id: 1, priority: "medium" });
      }
      if (method === "POST" && url.includes("/module-issues/")) return json({ ok: true });
      return json([]);
    };
    const { deps, files } = memoryDeps({
      now: Date.parse("2026-09-10T00:00:00Z"),
      fetch: fetchImpl,
    });
    files.set(
      "/tmp/fake-home/.config/plane-cli/catalog.json",
      JSON.stringify({
        fetchedAt: "2026-09-01T00:00:00Z",
        workspace: "rti-tek",
        projects: [],
        modulesByProjectId: {},
        statesByProjectId: {},
        labelsByProjectId: {},
        membersByProjectId: {},
      }),
    );
    const { out } = capture(deps);
    const code = await run(
      ["issue", "create", "--project", "SIL", "--title", "Ship CLI", "--start-date", "2026-09-10", "--target-date", "2026-09-11", "--description", "## Scope\n\n- ship", "--module", "CLI", "--priority", "medium"],
      deps,
    );
    expect(code).toBe(0);
    const payload = JSON.parse(out[0]);
    expect(payload.ok).toBe(true);
    expect(payload.issue.key).toBe("SIL-1");
    expect(payload.issue.description_html_summary).toMatchObject({ has_headings: true, has_unordered_list: true });
    expect(calls.some((c) => c.method === "POST" && String(c.url).includes("/work-items/"))).toBe(true);
    const createCall = calls.find((c) => c.method === "POST" && String(c.url).includes("/work-items/"));
    expect(createCall?.body).toMatchObject({ start_date: "2026-09-10", target_date: "2026-09-11" });
    expect(calls.some((c) => c.method === "POST" && String(c.url).includes("/module-issues/"))).toBe(true);
    const catalog = JSON.parse(files.get("/tmp/fake-home/.config/plane-cli/catalog.json")!);
    expect(catalog.projects[0].identifier).toBe("SIL");
    expect(catalog.modulesByProjectId.p1[0].name).toBe("CLI");
  });
});

describe("issue update", () => {
  test("allows --module without another work-item field", async () => {
    const calls: { method: string; url: string; body?: unknown }[] = [];
    const fetchImpl: Deps["fetch"] = async (input, init) => {
      const url = String(input);
      const method = init?.method || "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ method, url, body });
      if (url.includes("/work-items/SIL-7/")) return json({ id: "i7", project: "p1", name: "Existing", sequence_id: 7 });
      if (url.includes("/projects/") && url.endsWith("/projects/?per_page=100")) {
        return json([{ id: "p1", name: "Silicon", identifier: "SIL" }]);
      }
      if (url.includes("/modules/")) return json([{ id: "m1", name: "CLI" }]);
      if (url.includes("/states/")) return json([{ id: "s1", name: "Todo" }]);
      if (method === "POST" && url.includes("/module-issues/")) return json({ ok: true });
      return json([]);
    };
    const { deps } = memoryDeps({ fetch: fetchImpl });
    const { out } = capture(deps);

    expect(await run(["issue", "update", "SIL-7", "--module", "CLI"], deps)).toBe(0);
    expect(JSON.parse(out[0]).issue.key).toBe("SIL-7");
    expect(calls.some((call) => call.method === "PATCH")).toBe(false);
    expect(calls.some((call) => call.method === "POST" && call.url.includes("/module-issues/"))).toBe(true);
  });

  test("reads back an updated Issue and verifies persisted rich text", async () => {
    const calls: { method: string; url: string; body?: unknown }[] = [];
    const { deps, files } = memoryDeps({
      fetch: async (input, init) => {
        const url = String(input);
        const method = init?.method || "GET";
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        calls.push({ method, url, body });
        if (url.includes("/work-items/SIL-7/")) return json({ id: "i7", project: "p1", name: "Existing", sequence_id: 7, start_date: "2026-09-10", target_date: "2026-09-11" });
        if (url.includes("/projects/p1/work-items/i7/")) {
          if (method === "PATCH") return json({ id: "i7", project: "p1", sequence_id: 7 });
          return json({ id: "i7", project: "p1", sequence_id: 7, start_date: "2026-09-10", target_date: "2026-09-11", description_html: "<h2>Scope</h2><ul><li>verified</li></ul>" });
        }
        return json([]);
      },
    });
    files.set(
      "/tmp/fake-home/.config/plane-cli/catalog.json",
      JSON.stringify({ fetchedAt: "2026-09-10T00:00:00Z", workspace: "rti-tek", projects: [{ id: "p1", name: "Silicon", identifier: "SIL" }], modulesByProjectId: { p1: [] }, statesByProjectId: { p1: [] }, labelsByProjectId: {}, membersByProjectId: {} }),
    );
    const { out } = capture(deps);

    expect(await run(["issue", "update", "SIL-7", "--description", "## Scope\n\n- verified"], deps)).toBe(0);
    expect(calls.some((call) => call.method === "PATCH" && call.url.includes("/projects/p1/work-items/i7/"))).toBe(true);
    expect(JSON.parse(out[0]).issue.description_html_summary).toMatchObject({ has_headings: true, has_unordered_list: true });
  });
});

describe("credential source", () => {
  test("config show names where the key came from", async () => {
    const { deps } = memoryDeps();
    const { out } = capture(deps);
    expect(await run(["config", "show"], deps)).toBe(0);
    expect(JSON.parse(out[0]).config.sources).toEqual({
      apiKey: "env",
      workspaceSlug: "env",
      baseUrl: "env",
    });
  });

  test("a rejected token points at the env var that shadowed config.json", async () => {
    const fetchImpl: Deps["fetch"] = async () =>
      new Response(JSON.stringify({ detail: "Given API token is not valid" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    const { deps } = memoryDeps({ fetch: fetchImpl });
    const { out } = capture(deps);

    expect(await run(["project", "list"], deps)).toBe(1);
    const payload = JSON.parse(out[0]);
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain("PLANE_API_KEY env var");
  });
});

describe("catalog scope", () => {
  test("project list only lists projects and never warms per-project data", async () => {
    // States/modules sit behind project membership; warming every project made
    // `project list` fail with 403 on any project the token cannot reach.
    const calls: string[] = [];
    const fetchImpl: Deps["fetch"] = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/states/") || url.includes("/modules/")) {
        return new Response(JSON.stringify({ detail: "You do not have permission to perform this action." }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        });
      }
      return json([
        { id: "p1", name: "Silicon", identifier: "SIL", is_member: true },
        { id: "p2", name: "Secret", identifier: "SEC", is_member: false },
      ]);
    };
    const { deps } = memoryDeps({ fetch: fetchImpl });
    const { out } = capture(deps);

    expect(await run(["project", "list"], deps)).toBe(0);
    const payload = JSON.parse(out[0]);
    expect(payload.ok).toBe(true);
    expect(payload.projects.map((p: { identifier: string }) => p.identifier)).toEqual(["SIL", "SEC"]);
    expect(calls.filter((url) => url.includes("/states/") || url.includes("/modules/"))).toEqual([]);
  });

  test("cache refresh skips unreachable projects and tolerates a denial", async () => {
    const calls: string[] = [];
    const fetchImpl: Deps["fetch"] = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/projects/p3/")) {
        return new Response(JSON.stringify({ detail: "denied" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/states/")) return json([{ id: "s1", name: "Todo", group: "unstarted" }]);
      if (url.includes("/modules/")) return json([{ id: "m1", name: "CLI" }]);
      return json([
        { id: "p1", name: "Silicon", identifier: "SIL", is_member: true },
        { id: "p2", name: "Old", identifier: "OLD", is_member: true, archived_at: "2026-03-26T19:08:17Z" },
        { id: "p3", name: "Stale", identifier: "STL", is_member: true },
        { id: "p4", name: "Secret", identifier: "SEC", is_member: false },
      ]);
    };
    const { deps, files } = memoryDeps({ fetch: fetchImpl });
    const { out } = capture(deps);

    expect(await run(["cache", "refresh"], deps)).toBe(0);
    const payload = JSON.parse(out[0]);
    expect(payload.ok).toBe(true);
    // The denial is reported rather than swallowed.
    expect(payload.skipped).toHaveLength(1);
    expect(payload.skipped[0].project).toBe("STL");
    expect(payload.skipped[0].reason).toContain("403");
    // Archived (p2) and non-member (p4) projects are never warmed.
    expect(calls.some((url) => url.includes("/projects/p2/"))).toBe(false);
    expect(calls.some((url) => url.includes("/projects/p4/"))).toBe(false);
    const catalog = JSON.parse(files.get("/tmp/fake-home/.config/plane-cli/catalog.json")!);
    expect(catalog.statesByProjectId.p1).toHaveLength(1);
    // A denied project stays unset so an explicit command still surfaces the error.
    expect(catalog.statesByProjectId.p3).toBeUndefined();
  });
});

describe("issue list", () => {
  test("filters by state client-side because the API ignores ?state=", async () => {
    const calls: string[] = [];
    const fetchImpl: Deps["fetch"] = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/states/")) {
        return json([
          { id: "s1", name: "Todo", group: "unstarted" },
          { id: "s2", name: "Done", group: "completed" },
        ]);
      }
      if (url.includes("/modules/")) return json([]);
      if (url.includes("/work-items/")) {
        return json({
          results: [
            { id: "i1", name: "A", sequence_id: 1, state: { id: "s1", name: "Todo" } },
            { id: "i2", name: "B", sequence_id: 2, state: { id: "s2", name: "Done" } },
          ],
          next_cursor: "100:1:0",
          next_page_results: false,
        });
      }
      return json([{ id: "p1", name: "Silicon", identifier: "SIL", is_member: true }]);
    };
    const { deps } = memoryDeps({ fetch: fetchImpl });
    const { out } = capture(deps);

    expect(await run(["issue", "list", "--project", "SIL", "--state", "Done"], deps)).toBe(0);
    const payload = JSON.parse(out[0]);
    expect(payload.state).toBe("Done");
    expect(payload.issues).toHaveLength(1);
    expect(payload.issues[0].key).toBe("SIL-2");
    expect(payload.issues[0].state).toBe("Done");
    // The useless ?state= param is no longer sent.
    expect(calls.some((url) => url.includes("state=s2"))).toBe(false);
  });
});

describe("issue create validation", () => {
  test("fails when Plane does not persist the requested date or rich-text structure", async () => {
    const { deps, files } = memoryDeps({
      fetch: async (input, init) => {
        const url = String(input);
        const method = init?.method || "GET";
        if (url.includes("/projects/") && url.endsWith("/projects/?per_page=100")) return json([{ id: "p1", name: "Silicon", identifier: "SIL" }]);
        if (url.includes("/modules/") || url.includes("/states/")) return json([]);
        if (method === "POST" && url.includes("/work-items/")) return json({ id: "i1", sequence_id: 1 });
        if (url.includes("/projects/p1/work-items/i1/")) return json({ id: "i1", sequence_id: 1, start_date: "2026-09-10", target_date: "2026-09-11", description_html: "<p>Scope</p>" });
        return json([]);
      },
    });
    files.set(
      "/tmp/fake-home/.config/plane-cli/catalog.json",
      JSON.stringify({ fetchedAt: "2026-09-10T00:00:00Z", workspace: "rti-tek", projects: [{ id: "p1", name: "Silicon", identifier: "SIL" }], modulesByProjectId: { p1: [] }, statesByProjectId: { p1: [] }, labelsByProjectId: {}, membersByProjectId: {} }),
    );
    const { out } = capture(deps);

    expect(await run(["issue", "create", "--project", "SIL", "--title", "X", "--start-date", "2026-09-10", "--target-date", "2026-09-11", "--description", "## Scope"], deps)).toBe(1);
    expect(JSON.parse(out[0]).code).toBe("WRITE_VERIFY");
  });

  test("requires dates before reading the catalog or creating an Issue", async () => {
    const calls: string[] = [];
    const { deps } = memoryDeps({ fetch: async (input) => (calls.push(String(input)), json([])) });
    const { out } = capture(deps);

    expect(await run(["issue", "create", "--project", "SIL", "--title", "X"], deps)).toBe(1);
    const payload = JSON.parse(out[0]);
    expect(payload.code).toBe("MISSING_DATES");
    expect(payload.error).toContain("recommended: --start-date");
    expect(calls).toEqual([]);
  });

  test("keeps and validates a single explicit date exception", async () => {
    const calls: { method: string; url: string; body?: unknown }[] = [];
    const { deps, files } = memoryDeps({
      fetch: async (input, init) => {
        const url = String(input);
        const method = init?.method || "GET";
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        calls.push({ method, url, body });
        if (url.includes("/projects/") && url.endsWith("/projects/?per_page=100")) return json([{ id: "p1", name: "Silicon", identifier: "SIL" }]);
        if (url.includes("/modules/") || url.includes("/states/")) return json([]);
        if (method === "POST" && url.includes("/work-items/")) return json({ id: "i1", sequence_id: 1 });
        if (url.includes("/projects/p1/work-items/i1/")) return json({ id: "i1", sequence_id: 1, start_date: "2026-09-10" });
        return json([]);
      },
    });
    files.set(
      "/tmp/fake-home/.config/plane-cli/catalog.json",
      JSON.stringify({ fetchedAt: "2026-09-10T00:00:00Z", workspace: "rti-tek", projects: [{ id: "p1", name: "Silicon", identifier: "SIL" }], modulesByProjectId: { p1: [] }, statesByProjectId: { p1: [] }, labelsByProjectId: {}, membersByProjectId: {} }),
    );
    const { out } = capture(deps);

    expect(await run(["issue", "create", "--project", "SIL", "--title", "X", "--start-date", "2026-09-10", "--allow-missing-dates"], deps)).toBe(0);
    const create = calls.find((call) => call.method === "POST" && call.url.includes("/work-items/"));
    expect(create?.body).toMatchObject({ start_date: "2026-09-10" });
    expect(JSON.parse(out[0]).issue.start_date).toBe("2026-09-10");
    expect(await run(["issue", "create", "--project", "SIL", "--title", "X", "--start-date", "2026-02-30", "--allow-missing-dates"], deps)).toBe(1);
    expect(JSON.parse(out[1]).code).toBe("INVALID_DATE");
  });

  test("recommends the following local calendar date across DST", async () => {
    const { deps } = memoryDeps({ now: Date.parse("2026-11-01T07:30:00Z") });
    const { out } = capture(deps);

    expect(await run(["issue", "create", "--project", "SIL", "--title", "X"], deps)).toBe(1);
    expect(JSON.parse(out[0]).error).toContain("--start-date 2026-11-01 --target-date 2026-11-02");
  });

  test("rejects invalid and reversed date ranges before writing", async () => {
    const { deps } = memoryDeps();
    const { out } = capture(deps);

    expect(await run(["issue", "create", "--project", "SIL", "--title", "X", "--start-date", "2026-02-30", "--target-date", "2026-03-01"], deps)).toBe(1);
    expect(JSON.parse(out[0]).code).toBe("INVALID_DATE");
    expect(await run(["issue", "create", "--project", "SIL", "--title", "X", "--start-date", "2026-09-12", "--target-date", "2026-09-10"], deps)).toBe(1);
    expect(JSON.parse(out[1]).code).toBe("INVALID_DATE_RANGE");
  });

  test("rejects a priority the API would 400 on, before any write", async () => {
    const calls: string[] = [];
    const fetchImpl: Deps["fetch"] = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("/states/") || url.includes("/modules/")) return json([]);
      return json([{ id: "p1", name: "Silicon", identifier: "SIL", is_member: true }]);
    };
    const { deps } = memoryDeps({ fetch: fetchImpl });
    const { out } = capture(deps);

    expect(await run(["issue", "create", "--project", "SIL", "--title", "X", "--start-date", "2026-09-10", "--target-date", "2026-09-11", "--priority", "P1"], deps)).toBe(1);
    const payload = JSON.parse(out[0]);
    expect(payload.ok).toBe(false);
    expect(payload.code).toBe("USAGE");
    expect(payload.error).toContain("urgent");
    expect(calls.some((url) => url.includes("POST"))).toBe(false);
  });
});

describe("personal notifications", () => {
  test("marks a notification read idempotently with encoded identifiers and no request body", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const notification = {
      id: "n1",
      title: "Mention",
      read_at: "2026-09-15T07:00:00Z",
      updated_at: "2026-09-15T07:00:00Z",
    };
    const { deps } = memoryDeps({
      fetch: async (input, init) => {
        calls.push({ url: String(input), init });
        return json(notification);
      },
    });
    deps.env = { ...deps.env, PLANE_WORKSPACE_SLUG: "rti/tek ?" };
    const { out } = capture(deps);

    expect(await run(["notification", "mark-read", "n1"], deps)).toBe(0);
    expect(await run(["notification", "mark-read", "n1"], deps)).toBe(0);
    expect(calls).toHaveLength(2);
    expect(new URL(calls[0].url).pathname).toBe("/api/v1/workspaces/rti%2Ftek%20%3F/notifications/n1/read/");
    expect(calls[0].init?.method).toBe("POST");
    expect(calls[0].init?.body).toBeUndefined();
    expect(new Headers(calls[0].init?.headers).get("X-Api-Key")).toBe("test-key");
    expect(JSON.parse(out[0]).notification).toEqual(notification);
    expect(JSON.parse(out[1]).notification).toEqual(notification);
  });

  test("does not report a notification as read when the personal API rejects the request", async () => {
    const { deps } = memoryDeps({
      fetch: async () => new Response(JSON.stringify({ detail: "authentication required" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    });
    const { out } = capture(deps);

    expect(await run(["notification", "mark-read", "n1"], deps)).toBe(1);
    const payload = JSON.parse(out[0]);
    expect(payload).toMatchObject({ ok: false, code: "HTTP" });
    expect(payload.error).toContain("HTTP 401");
    expect(payload).not.toHaveProperty("notification");
  });

  test.each([403, 404])("does not report a notification as read for HTTP %i", async (status) => {
    const { deps } = memoryDeps({
      fetch: async () => new Response(JSON.stringify({ detail: "not permitted" }), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    });
    const { out } = capture(deps);

    expect(await run(["notification", "mark-read", "n1"], deps)).toBe(1);
    const payload = JSON.parse(out[0]);
    expect(payload).toMatchObject({ ok: false, code: "HTTP" });
    expect(payload.error).toContain(`HTTP ${status}`);
    expect(payload).not.toHaveProperty("notification");
  });

  test("does not report a notification as read when the network request fails", async () => {
    const { deps } = memoryDeps({
      fetch: async () => {
        throw new Error("network unavailable");
      },
    });
    const { out } = capture(deps);

    expect(await run(["notification", "mark-read", "n1"], deps)).toBe(1);
    const payload = JSON.parse(out[0]);
    expect(payload).toMatchObject({ ok: false, code: "ERROR" });
    expect(payload.error).toContain("network unavailable");
    expect(payload).not.toHaveProperty("notification");
  });

  test("sends cursor pagination and filters without changing per-page", async () => {
    const calls: string[] = [];
    const { deps } = memoryDeps({
      fetch: async (input) => {
        calls.push(String(input));
        return json({ total_results: 2, next_cursor: "next", next_page_results: true, results: [{ id: "n1" }] });
      },
    });
    const { out } = capture(deps);

    expect(await run(["notification", "list", "--read", "false", "--mentioned", "true", "--per-page", "50", "--cursor", "page-1"], deps)).toBe(0);
    const url = new URL(calls[0]);
    expect(url.pathname).toBe("/api/v1/workspaces/rti-tek/notifications/");
    expect(Object.fromEntries(url.searchParams)).toEqual({ read: "false", mentioned: "true", per_page: "50", cursor: "page-1" });
    expect(JSON.parse(out[0]).notifications.next_cursor).toBe("next");
    expect(JSON.parse(out[0]).notifications.next_page_results).toBe(true);
  });

  test("rejects an invalid page size before sending a request", async () => {
    const calls: string[] = [];
    const { deps } = memoryDeps({ fetch: async (input) => (calls.push(String(input)), json({})) });
    const { out } = capture(deps);

    expect(await run(["notification", "list", "--per-page", "101"], deps)).toBe(1);
    expect(JSON.parse(out[0]).code).toBe("USAGE");
    expect(calls).toEqual([]);
  });
});

describe("inline images", () => {
  test("creates an Issue only after images are confirmed, then binds its returned Issue ID", async () => {
    const assetId = "00000000-0000-4000-8000-000000000002";
    const calls: { method: string; url: string; body?: unknown }[] = [];
    const { deps, files } = memoryDeps({
      fetch: async (input, init) => {
        const url = String(input);
        calls.push({ method: init?.method || "GET", url, body: init?.body });
        if (url === "https://storage.example/upload") return new Response(null, { status: 204 });
        if (url.includes(`description-assets/${assetId}/confirm/`)) return json({ state: "confirmed" });
        if (url.includes("description-assets/bind/")) return json({ ok: true });
        if (url.includes("description-assets/")) {
          return json({ asset_id: assetId, state: "created", upload_data: { url: "https://storage.example/upload", fields: { key: "private" } } });
        }
        if (url.includes("/projects/project-1/work-items/issue-9/")) {
          return json({ id: "issue-9", name: "Diagram", sequence_id: 9, start_date: "2026-09-10", target_date: "2026-09-11", description_html: `<p><img src="${assetId}" /></p>` });
        }
        if (url.includes("/work-items/")) return json({ id: "issue-9", name: "Diagram", sequence_id: 9 });
        return json({});
      },
    });
    files.set(
      "/tmp/fake-home/.config/plane-cli/catalog.json",
      JSON.stringify({
        fetchedAt: "2026-09-10T00:00:00Z",
        workspace: "rti-tek",
        projects: [{ id: "project-1", name: "Silicon", identifier: "SIL" }],
        modulesByProjectId: { "project-1": [] },
        statesByProjectId: { "project-1": [] },
        labelsByProjectId: {},
        membersByProjectId: {},
      }),
    );
    deps.readImageFile = () => ({ size: 12, isFile: true, bytes: new Uint8Array([1, 2, 3]) });
    const { out } = capture(deps);

    expect(await run(["issue", "create", "--project", "SIL", "--title", "Diagram", "--start-date", "2026-09-10", "--target-date", "2026-09-11", "--image", "diagram.png"], deps)).toBe(0);
    expect(calls.map((call) => call.url)).toEqual([
      expect.stringContaining("/description-assets/"),
      "https://storage.example/upload",
      expect.stringContaining(`/description-assets/${assetId}/confirm/`),
      expect.stringContaining("/work-items/"),
      expect.stringContaining("/description-assets/bind/"),
      expect.stringContaining("/work-items/issue-9/"),
    ]);
    const issueCall = calls.find((call) => call.url.includes("/work-items/"))!;
    expect(JSON.parse(String(issueCall.body)).description_html).toContain(`src="${assetId}"`);
    const bindCall = calls.find((call) => call.url.includes("description-assets/bind/"))!;
    expect(JSON.parse(String(bindCall.body))).toMatchObject({ target_type: "ISSUE_DESCRIPTION", target_id: "issue-9", asset_ids: [assetId] });
    expect(JSON.parse(out[0]).issue.key).toBe("SIL-9");
  });

  test("uploads, confirms, writes a comment, then binds the returned comment ID without leaking upload data", async () => {
    const assetId = "00000000-0000-4000-8000-000000000001";
    const calls: { method: string; url: string; body?: unknown; headers?: HeadersInit }[] = [];
    let bindAttempts = 0;
    const { deps } = memoryDeps({
      fetch: async (input, init) => {
        const url = String(input);
        calls.push({ method: init?.method || "GET", url, body: init?.body, headers: init?.headers });
        if (url.includes("/work-items/SIL-7/")) return json({ id: "issue-7", project: "project-1" });
        if (url.includes("description-assets/bind/")) {
          bindAttempts++;
          return bindAttempts === 1
            ? new Response(JSON.stringify({ detail: "try again" }), { status: 503, headers: { "Content-Type": "application/json" } })
            : json({ ok: true });
        }
        if (url.includes(`description-assets/${assetId}/confirm/`)) return json({ state: "confirmed" });
        if (url.includes("description-assets/")) {
          return json({
            asset_id: assetId,
            state: "created",
            upload_data: { url: "https://storage.example/upload?signature=secret", fields: { key: "private-key", policy: "signed" } },
          });
        }
        if (url === "https://storage.example/upload?signature=secret") return new Response(null, { status: 204 });
        if (url.includes("/comments/")) return json({ id: "comment-9" });
        return json({});
      },
    });
    deps.readImageFile = () => ({ size: 12, isFile: true, bytes: new Uint8Array([1, 2, 3]) });
    deps.randomUUID = () => "stable-idempotency-key";
    const { out } = capture(deps);

    expect(await run(["issue", "comment", "SIL-7", "--body", "## Screenshot\n\n- verified", "--image", "screenshot.png"], deps)).toBe(0);
    const paths = calls.map((call) => call.url);
    expect(paths).toEqual([
      expect.stringContaining("/work-items/SIL-7/"),
      expect.stringContaining("/description-assets/"),
      "https://storage.example/upload?signature=secret",
      expect.stringContaining(`/description-assets/${assetId}/confirm/`),
      expect.stringContaining("/comments/"),
      expect.stringContaining("/description-assets/bind/"),
      expect.stringContaining("/description-assets/bind/"),
    ]);
    const commentCall = calls.find((call) => call.url.includes("/comments/"))!;
    expect(JSON.parse(String(commentCall.body)).comment_html).toContain("<h2>Screenshot</h2><ul><li>verified</li></ul>");
    expect(JSON.parse(String(commentCall.body)).comment_html).toContain(`src="${assetId}"`);
    expect(JSON.parse(String(commentCall.body)).comment_html).not.toContain("storage.example");
    const bindCalls = calls.filter((call) => call.url.includes("description-assets/bind/"));
    for (const bindCall of bindCalls) {
      expect(JSON.parse(String(bindCall.body))).toMatchObject({ target_type: "COMMENT_DESCRIPTION", target_id: "comment-9", asset_ids: [assetId] });
      expect(new Headers(bindCall.headers).get("Idempotency-Key")).toBe("stable-idempotency-key");
    }
    const directUpload = calls.find((call) => call.url.includes("storage.example"))!;
    expect(directUpload.body).toBeInstanceOf(FormData);
    expect(new Headers(directUpload.headers).get("X-Api-Key")).toBeNull();
    expect(out.join("\n")).not.toContain("storage.example");
    expect(out.join("\n")).not.toContain("secret");
  });

  test("updates an existing comment and binds images to the supplied comment ID", async () => {
    const assetId = "00000000-0000-4000-8000-000000000003";
    const commentId = "00000000-0000-4000-8000-000000000103";
    const calls: { method: string; url: string; body?: unknown }[] = [];
    const { deps } = memoryDeps({
      fetch: async (input, init) => {
        const url = String(input);
        calls.push({ method: init?.method || "GET", url, body: init?.body });
        if (url.includes("/work-items/SIL-7/")) return json({ id: "issue-7", project: "project-1" });
        if (url === "https://storage.example/upload") return new Response(null, { status: 204 });
        if (url.includes(`description-assets/${assetId}/confirm/`)) return json({ state: "confirmed" });
        if (url.includes("description-assets/bind/")) return json({ ok: true });
        if (url.includes("description-assets/")) return json({ asset_id: assetId, upload_data: { url: "https://storage.example/upload", fields: {} } });
        if (url.includes(`/comments/${commentId}/`)) return json({ id: commentId });
        return json({});
      },
    });
    deps.readImageFile = () => ({ size: 12, isFile: true, bytes: new Uint8Array([1]) });
    const { out } = capture(deps);

    expect(await run(["issue", "comment", "update", "SIL-7", commentId, "--body", "Updated", "--image", "screenshot.png"], deps)).toBe(0);
    const update = calls.find((call) => call.url.includes(`/comments/${commentId}/`))!;
    expect(update.method).toBe("PATCH");
    expect(JSON.parse(String(update.body)).comment_html).toContain(`src="${assetId}"`);
    const bind = calls.find((call) => call.url.includes("description-assets/bind/"))!;
    expect(JSON.parse(String(bind.body))).toMatchObject({ target_type: "COMMENT_DESCRIPTION", target_id: commentId, asset_ids: [assetId] });
    expect(JSON.parse(out[0]).ok).toBe(true);
  });

  test("retries confirm with the same asset ID and redacts persistent service details", async () => {
    const assetId = "00000000-0000-4000-8000-000000000004";
    const calls: string[] = [];
    const { deps } = memoryDeps({
      fetch: async (input) => {
        const url = String(input);
        calls.push(url);
        if (url.includes("/work-items/SIL-7/")) return json({ id: "issue-7", project: "project-1" });
        if (url === "https://storage.example/upload?signature=private") return new Response(null, { status: 204 });
        if (url.includes(`description-assets/${assetId}/confirm/`)) {
          return new Response(JSON.stringify({ detail: "signature=private" }), { status: 503, headers: { "Content-Type": "application/json" } });
        }
        if (url.includes("description-assets/")) {
          return json({ asset_id: assetId, upload_data: { url: "https://storage.example/upload?signature=private", fields: { policy: "private" } } });
        }
        return json({});
      },
    });
    deps.readImageFile = () => ({ size: 12, isFile: true, bytes: new Uint8Array([1]) });
    const { out } = capture(deps);

    expect(await run(["issue", "comment", "SIL-7", "--body", "Screenshot", "--image", "screenshot.png"], deps)).toBe(1);
    expect(calls.filter((url) => url.includes(`/description-assets/${assetId}/confirm/`))).toHaveLength(2);
    const payload = JSON.parse(out[0]);
    expect(payload.code).toBe("ASSET_CONFIRM");
    expect(payload.error).not.toContain("signature");
    expect(payload.error).not.toContain("private");
    expect(calls.some((url) => url.includes("/comments/"))).toBe(false);
  });

  test("rejects a malicious comment ID before issuing any request", async () => {
    const calls: string[] = [];
    const { deps } = memoryDeps({ fetch: async (input) => (calls.push(String(input)), json({})) });
    const { out } = capture(deps);

    expect(await run(["issue", "comment", "update", "SIL-7", "../../labels", "--body", "Updated"], deps)).toBe(1);
    expect(JSON.parse(out[0])).toMatchObject({ code: "USAGE", error: "COMMENT_ID must be a UUID" });
    expect(calls).toEqual([]);
  });

  test("does not replay a confirmation conflict", async () => {
    const assetId = "00000000-0000-4000-8000-000000000008";
    const calls: string[] = [];
    const { deps } = memoryDeps({
      fetch: async (input) => {
        const url = String(input);
        calls.push(url);
        if (url.includes("/work-items/SIL-7/")) return json({ id: "issue-7", project: "project-1" });
        if (url === "https://storage.example/upload") return new Response(null, { status: 204 });
        if (url.includes(`description-assets/${assetId}/confirm/`)) {
          return new Response(JSON.stringify({ detail: "conflict private" }), { status: 409, headers: { "Content-Type": "application/json" } });
        }
        if (url.includes("description-assets/")) return json({ asset_id: assetId, upload_data: { url: "https://storage.example/upload", fields: {} } });
        return json({});
      },
    });
    deps.readImageFile = () => ({ size: 12, isFile: true, bytes: new Uint8Array([1]) });
    const { out } = capture(deps);

    expect(await run(["issue", "comment", "SIL-7", "--body", "Screenshot", "--image", "screenshot.png"], deps)).toBe(1);
    expect(calls.filter((url) => url.includes(`/description-assets/${assetId}/confirm/`))).toHaveLength(1);
    expect(JSON.parse(out[0])).toMatchObject({ code: "ASSET_CONFIRM_CONFLICT" });
    expect(out[0]).not.toContain("private");
  });

  test("does not write a comment or claim success when direct image upload fails", async () => {
    const assetId = "00000000-0000-4000-8000-000000000006";
    const calls: string[] = [];
    const { deps } = memoryDeps({
      fetch: async (input) => {
        const url = String(input);
        calls.push(url);
        if (url.includes("/work-items/SIL-7/")) return json({ id: "issue-7", project: "project-1" });
        if (url === "https://storage.example/upload?signature=private") return new Response("upload failed", { status: 503 });
        if (url.includes("description-assets/")) {
          return json({ asset_id: assetId, upload_data: { url: "https://storage.example/upload?signature=private", fields: { policy: "private" } } });
        }
        return json({});
      },
    });
    deps.readImageFile = () => ({ size: 12, isFile: true, bytes: new Uint8Array([1]) });
    const { out } = capture(deps);

    expect(await run(["issue", "comment", "SIL-7", "--body", "Screenshot", "--image", "screenshot.png"], deps)).toBe(1);
    const payload = JSON.parse(out[0]);
    expect(payload.code).toBe("ASSET_UPLOAD");
    expect(payload.error).not.toContain("private");
    expect(calls.some((url) => url.includes("/comments/"))).toBe(false);
  });

  test("does not continue after a terminal bind failure or leak server detail", async () => {
    const assetId = "00000000-0000-4000-8000-000000000007";
    const calls: string[] = [];
    let bindAttempts = 0;
    const { deps, files } = memoryDeps({
      fetch: async (input) => {
        const url = String(input);
        calls.push(url);
        if (url === "https://storage.example/upload") return new Response(null, { status: 204 });
        if (url.includes(`description-assets/${assetId}/confirm/`)) return json({ state: "confirmed" });
        if (url.includes("description-assets/bind/")) {
          bindAttempts++;
          return new Response(JSON.stringify({ detail: "signature=private" }), { status: 503, headers: { "Content-Type": "application/json" } });
        }
        if (url.includes("description-assets/")) return json({ asset_id: assetId, upload_data: { url: "https://storage.example/upload", fields: {} } });
        if (url.includes("/work-items/")) return json({ id: "issue-9", name: "Diagram", sequence_id: 9 });
        if (url.includes("module-issues/")) return json({ ok: true });
        return json({});
      },
    });
    files.set("/tmp/fake-home/.config/plane-cli/catalog.json", JSON.stringify({
      fetchedAt: "2026-09-10T00:00:00Z", workspace: "rti-tek", projects: [{ id: "project-1", name: "Silicon", identifier: "SIL" }],
      modulesByProjectId: { "project-1": [{ id: "module-1", name: "CLI" }] }, statesByProjectId: { "project-1": [] }, labelsByProjectId: {}, membersByProjectId: {},
    }));
    deps.readImageFile = () => ({ size: 12, isFile: true, bytes: new Uint8Array([1]) });
    const { out } = capture(deps);

    expect(await run(["issue", "create", "--project", "SIL", "--title", "Diagram", "--start-date", "2026-09-10", "--target-date", "2026-09-11", "--image", "diagram.png", "--module", "CLI"], deps)).toBe(1);
    expect(bindAttempts).toBe(2);
    expect(calls.some((url) => url.includes("module-issues/"))).toBe(false);
    const payload = JSON.parse(out[0]);
    expect(payload.code).toBe("ASSET_BIND");
    expect(payload.error).not.toContain("private");
  });

  test("binds an Issue image before a later module association can fail", async () => {
    const assetId = "00000000-0000-4000-8000-000000000005";
    const calls: string[] = [];
    const { deps, files } = memoryDeps({
      fetch: async (input) => {
        const url = String(input);
        calls.push(url);
        if (url === "https://storage.example/upload") return new Response(null, { status: 204 });
        if (url.includes(`description-assets/${assetId}/confirm/`) || url.includes("description-assets/bind/")) return json({ state: "confirmed" });
        if (url.includes("description-assets/")) return json({ asset_id: assetId, upload_data: { url: "https://storage.example/upload", fields: {} } });
        if (url.includes("module-issues/")) return new Response(JSON.stringify({ detail: "module failed" }), { status: 500, headers: { "Content-Type": "application/json" } });
        if (url.includes("/work-items/")) return json({ id: "issue-9", name: "Diagram", sequence_id: 9 });
        return json({});
      },
    });
    files.set("/tmp/fake-home/.config/plane-cli/catalog.json", JSON.stringify({
      fetchedAt: "2026-09-10T00:00:00Z", workspace: "rti-tek", projects: [{ id: "project-1", name: "Silicon", identifier: "SIL" }],
      modulesByProjectId: { "project-1": [{ id: "module-1", name: "CLI" }] }, statesByProjectId: { "project-1": [] }, labelsByProjectId: {}, membersByProjectId: {},
    }));
    deps.readImageFile = () => ({ size: 12, isFile: true, bytes: new Uint8Array([1]) });
    const { out } = capture(deps);

    expect(await run(["issue", "create", "--project", "SIL", "--title", "Diagram", "--start-date", "2026-09-10", "--target-date", "2026-09-11", "--image", "diagram.png", "--module", "CLI"], deps)).toBe(1);
    expect(calls.findIndex((url) => url.includes("description-assets/bind/"))).toBeLessThan(calls.findIndex((url) => url.includes("module-issues/")));
    expect(JSON.parse(out[0]).code).toBe("HTTP");
  });

  test("reports an unavailable description-assets API and never falls back to attachments", async () => {
    const calls: string[] = [];
    const { deps } = memoryDeps({
      fetch: async (input) => {
        const url = String(input);
        calls.push(url);
        if (url.includes("/work-items/SIL-7/")) return json({ id: "issue-7", project: "project-1" });
        return new Response(JSON.stringify({ detail: "not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
      },
    });
    deps.readImageFile = () => ({ size: 12, isFile: true, bytes: new Uint8Array([1]) });
    const { out } = capture(deps);

    expect(await run(["issue", "comment", "SIL-7", "--body", "Screenshot", "--image", "screenshot.png"], deps)).toBe(1);
    expect(JSON.parse(out[0]).code).toBe("DESCRIPTION_ASSET_API_UNAVAILABLE");
    expect(calls.some((url) => url.includes("assets/v2") || url.includes("attachments"))).toBe(false);
    expect(calls).toHaveLength(2);
  });
});

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
}
