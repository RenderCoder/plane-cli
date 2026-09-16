import { describe, expect, test } from "bun:test";
import {
  compactIssue,
  isStale,
  listAll,
  parseArgv,
  resolveProject,
  toHtml,
  type Catalog,
} from "./lib.ts";

describe("parseArgv", () => {
  test("parses resource action flags and positionals", () => {
    const parsed = parseArgv(["issue", "create", "--project", "SIL", "--title", "Fix login", "--pretty"]);
    expect(parsed.resource).toBe("issue");
    expect(parsed.action).toBe("create");
    expect(parsed.flags.project).toBe("SIL");
    expect(parsed.flags.title).toBe("Fix login");
    expect(parsed.pretty).toBe(true);
  });

  test("parses equals flags and boolean help", () => {
    const parsed = parseArgv(["--help", "cache", "check", "--project=APP"]);
    expect(parsed.help).toBe(true);
    expect(parsed.resource).toBe("cache");
    expect(parsed.action).toBe("check");
    expect(parsed.flags.project).toBe("APP");
  });
});

describe("catalog freshness", () => {
  test("is stale after ttl and fresh within ttl", () => {
    const now = Date.parse("2026-09-10T00:00:00Z");
    expect(isStale("2026-09-06T00:00:00Z", 3, now)).toBe(true);
    expect(isStale("2026-09-08T00:00:00Z", 3, now)).toBe(false);
    expect(isStale("not-a-date", 3, now)).toBe(true);
  });
});

describe("resolveProject", () => {
  const catalog: Catalog = {
    fetchedAt: "2026-09-10T00:00:00Z",
    workspace: "rti-tek",
    projects: [
      { id: "p1", name: "Silicon", identifier: "SIL" },
      { id: "p2", name: "App", identifier: "APP" },
    ],
    modulesByProjectId: {},
    statesByProjectId: {},
    labelsByProjectId: {},
    membersByProjectId: {},
  };

  test("resolves by identifier, name, or id", () => {
    expect(resolveProject(catalog, "sil").id).toBe("p1");
    expect(resolveProject(catalog, "App").id).toBe("p2");
    expect(resolveProject(catalog, "p1").identifier).toBe("SIL");
  });

  test("throws when missing", () => {
    expect(() => resolveProject(catalog, "NOPE")).toThrow("project not found: NOPE");
  });
});

describe("toHtml", () => {
  test("renders common Markdown as structured HTML", () => {
    expect(toHtml("hello\nworld")).toBe("<p>hello<br/>world</p>");
    expect(toHtml("## Hello\n\n- a\n- b\n\n**bold**")).toBe(
      "<h2>Hello</h2><ul><li>a</li><li>b</li></ul><p><strong>bold</strong></p>",
    );
    expect(toHtml("[Plane](https://plane.so) and `code`\n\n```ts\nconst x = 1;\n```")).toBe(
      '<p><a href="https://plane.so">Plane</a> and <code>code</code></p><pre><code class="language-ts">const x = 1;</code></pre>',
    );
    expect(toHtml("[query](https://example.com/a_b_c?x=1&y=2)")).toBe(
      '<p><a href="https://example.com/a_b_c?x=1&amp;y=2">query</a></p>',
    );
    expect(toHtml("[`code`](https://example.com)")).toBe('<p><a href="https://example.com"><code>code</code></a></p>');
    expect(toHtml("[**bold**](https://example.com)")).toBe('<p><a href="https://example.com"><strong>bold</strong></a></p>');
    expect(toHtml("## C#")).toBe("<h2>C#</h2>");
  });

  test("escapes raw HTML and unsafe links", () => {
    expect(toHtml("<script>alert(1)</script>")).toBe("<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>");
    expect(toHtml("[bad](javascript:alert(1))")).toBe("<p>bad)</p>");
  });
});

describe("compactIssue", () => {
  test("builds PROJECT-N key", () => {
    expect(
      compactIssue({ id: "i1", name: "Task", sequence_id: 498, priority: "medium" }, "SIL"),
    ).toEqual({
      key: "SIL-498",
      id: "i1",
      name: "Task",
      priority: "medium",
      state: null,
      project: "SIL",
      assignees: null,
      labels: null,
      start_date: null,
      target_date: null,
      description_html_summary: {
        has_headings: false,
        has_unordered_list: false,
        has_ordered_list: false,
        has_strong: false,
        has_code: false,
      },
    });
  });

  test("reads the state name out of an expanded state object", () => {
    const issue = compactIssue(
      { id: "i1", name: "Task", sequence_id: 1, state: { id: "s1", name: "In Progress", group: "started" } },
      "SIL",
    );
    expect(issue.state).toBe("In Progress");
  });

  test("resolves a bare state uuid through the cached states", () => {
    const states = [{ id: "s1", name: "Done", group: "completed" }];
    expect(compactIssue({ id: "i1", state: "s1" }, "SIL", states).state).toBe("Done");
    // Unknown ids fall back to the raw value rather than reporting null.
    expect(compactIssue({ id: "i1", state: "s9" }, "SIL", states).state).toBe("s9");
  });

  test("normalizes assignees and labels whether or not they are expanded", () => {
    expect(compactIssue({ id: "i1", assignees: ["u1", "u2"], labels: [] }, "SIL")).toMatchObject({
      assignees: ["u1", "u2"],
      labels: [],
    });
    expect(
      compactIssue({ id: "i1", assignees: [{ id: "u1", display_name: "Ann" }], labels: [{ id: "l1" }] }, "SIL"),
    ).toMatchObject({ assignees: ["u1"], labels: ["l1"] });
  });
});

describe("listAll", () => {
  test("stops on next_page_results rather than on a missing cursor", async () => {
    // The API always sends a non-empty next_cursor, even on the final page.
    const pages = [
      { results: [{ id: "a" }], next_cursor: "100:1:0", next_page_results: true },
      { results: [{ id: "b" }], next_cursor: "100:2:0", next_page_results: false },
    ];
    const seen: (string | undefined)[] = [];
    const rows = await listAll(async (cursor) => {
      seen.push(cursor);
      return pages[seen.length - 1];
    });
    expect(rows.map((row) => row.id)).toEqual(["a", "b"]);
    expect(seen).toEqual([undefined, "100:1:0"]);
  });

  test("treats a bare array response as a single page", async () => {
    let calls = 0;
    const rows = await listAll(async () => {
      calls += 1;
      return [{ id: "only" }];
    });
    expect(calls).toBe(1);
    expect(rows).toHaveLength(1);
  });
});
