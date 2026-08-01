import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  base64ToBytes,
  buildSummary,
  decideSync,
  destSlug,
  model,
  type SyncOutcome,
} from "./github_file_track.ts";

/** Build a syncRecord outcome for summary tests. */
function ok(destPath: string, changed: boolean): SyncOutcome {
  return {
    ok: true,
    record: {
      repo: "owner/repo",
      ref: "main",
      srcPath: "file.md",
      destPath,
      label: "",
      blobSha: "abc123",
      changed,
      reason: changed ? "written" : "unchanged",
      bytes: 4,
      syncedAt: "2026-07-16T00:00:00.000Z",
    },
  };
}

/** Build a failed-target outcome for summary tests. */
function bad(destPath: string, error = "gh api failed"): SyncOutcome {
  return {
    ok: false,
    failure: { repo: "owner/repo", srcPath: "file.md", destPath, error },
  };
}

// ─────────────────────────────────────────────────────────────────────
// schemas — defaults, contracts, and malformed inputs
// ─────────────────────────────────────────────────────────────────────

Deno.test("global arguments: defaults targets to an empty list", () => {
  assertEquals(model.globalArguments.parse({}), { targets: [] });
});

Deno.test("sync arguments: applies main ref and preserves an optional label", () => {
  assertEquals(model.methods.sync.arguments.parse({
    targets: [{
      repo: "owner/repo",
      srcPath: "docs/readme.md",
      destPath: "/tmp/readme.md",
      label: "documentation",
    }],
  }), {
    targets: [{
      repo: "owner/repo",
      ref: "main",
      srcPath: "docs/readme.md",
      destPath: "/tmp/readme.md",
      label: "documentation",
    }],
    continueOnError: false,
  });
});

Deno.test("sync arguments: rejects a target missing required paths", () => {
  assertThrows(() =>
    model.methods.sync.arguments.parse({
      targets: [{ repo: "owner/repo", srcPath: "file.md" }],
    })
  );
});

Deno.test("sync record schema: supplies an empty label and accepts every reason", () => {
  const schema = model.resources.syncRecord.schema;
  for (const reason of ["written", "unchanged", "created"] as const) {
    const parsed = schema.parse({
      repo: "owner/repo",
      ref: "main",
      srcPath: "file.md",
      destPath: "/tmp/file.md",
      blobSha: "abc123",
      changed: reason !== "unchanged",
      reason,
      bytes: 4,
      syncedAt: "2026-07-16T00:00:00.000Z",
    });
    assertEquals(parsed.label, "");
    assertEquals(parsed.reason, reason);
  }
});

Deno.test("sync record schema: rejects unknown reasons and non-numeric bytes", () => {
  const valid = {
    repo: "owner/repo",
    ref: "main",
    srcPath: "file.md",
    destPath: "/tmp/file.md",
    blobSha: "abc123",
    changed: true,
    reason: "written",
    bytes: 4,
    syncedAt: "2026-07-16T00:00:00.000Z",
  };
  assertThrows(() =>
    model.resources.syncRecord.schema.parse({ ...valid, reason: "skipped" })
  );
  assertThrows(() =>
    model.resources.syncRecord.schema.parse({ ...valid, bytes: "4" })
  );
});

Deno.test("sync summary schema: validates aggregate fields", () => {
  const summary = {
    total: 2,
    changed: 1,
    unchanged: 1,
    changedPaths: ["/tmp/file.md"],
    syncedAt: "2026-07-16T00:00:00.000Z",
  };
  // `failed`/`failures` default so summaries written by older versions still
  // parse.
  assertEquals(model.resources.syncSummary.schema.parse(summary), {
    ...summary,
    failed: 0,
    failures: [],
  });
  assertThrows(() =>
    model.resources.syncSummary.schema.parse({
      ...summary,
      changedPaths: "/tmp/file.md",
    })
  );
});

Deno.test("sync arguments: continueOnError defaults to false", () => {
  const parsed = model.methods.sync.arguments.parse({});
  assertEquals(parsed.continueOnError, false);
});

// ─────────────────────────────────────────────────────────────────────
// buildSummary — a failed target must never be absorbed as "unchanged"
// ─────────────────────────────────────────────────────────────────────

const AT = "2026-07-16T00:00:00.000Z";

Deno.test("buildSummary: counts changed and unchanged targets separately", () => {
  const summary = buildSummary([ok("/tmp/a", true), ok("/tmp/b", false)], AT);
  assertEquals(summary.total, 2);
  assertEquals(summary.changed, 1);
  assertEquals(summary.unchanged, 1);
  assertEquals(summary.failed, 0);
  assertEquals(summary.changedPaths, ["/tmp/a"]);
  assertEquals(summary.failures, []);
});

Deno.test("buildSummary: a failed target is counted as failed, not unchanged", () => {
  // The regression: a rejected target previously left `changed` and
  // `unchanged` both at 0, so `total: 1, changed: 0, unchanged: 0` was the only
  // hint that nothing had been fetched.
  const summary = buildSummary([bad("/tmp/a", "gh api 401")], AT);
  assertEquals(summary.total, 1);
  assertEquals(summary.changed, 0);
  assertEquals(summary.unchanged, 0);
  assertEquals(summary.failed, 1);
  assertEquals(summary.failures, [{
    repo: "owner/repo",
    srcPath: "file.md",
    destPath: "/tmp/a",
    error: "gh api 401",
  }]);
});

Deno.test("buildSummary: total always equals changed + unchanged + failed", () => {
  const cases: SyncOutcome[][] = [
    [],
    [ok("/tmp/a", true)],
    [bad("/tmp/a")],
    [ok("/tmp/a", true), ok("/tmp/b", false), bad("/tmp/c")],
    [bad("/tmp/a"), bad("/tmp/b")],
  ];
  for (const outcomes of cases) {
    const s = buildSummary(outcomes, AT);
    assertEquals(
      s.changed + s.unchanged + s.failed,
      s.total,
      `invariant broken for ${outcomes.length} outcome(s)`,
    );
  }
});

Deno.test("buildSummary: a partial failure still reports the successes", () => {
  const summary = buildSummary(
    [ok("/tmp/a", true), bad("/tmp/b"), ok("/tmp/c", false)],
    AT,
  );
  assertEquals(summary.total, 3);
  assertEquals(summary.changed, 1);
  assertEquals(summary.unchanged, 1);
  assertEquals(summary.failed, 1);
  assertEquals(summary.changedPaths, ["/tmp/a"]);
});

Deno.test("buildSummary: failed targets never appear in changedPaths", () => {
  const summary = buildSummary([bad("/tmp/a"), bad("/tmp/b")], AT);
  assertEquals(summary.changedPaths, []);
  assertEquals(summary.failed, 2);
});

Deno.test("buildSummary: an empty run is a valid zero summary", () => {
  const summary = buildSummary([], AT);
  assertEquals(summary.total, 0);
  assertEquals(summary.failed, 0);
  assertEquals(summary.syncedAt, AT);
});

// ─────────────────────────────────────────────────────────────────────
// base64ToBytes — GitHub contents decoding primitive
// ─────────────────────────────────────────────────────────────────────

Deno.test("base64ToBytes: preserves UTF-8 bytes and accepts embedded newlines once stripped", () => {
  const encoded = "aMOpbGxvIPCfjI0=";
  const bytes = base64ToBytes(`\n${encoded.slice(0, 8)}\n${encoded.slice(8)}\n`.replace(/\n/g, ""));
  assertEquals(new TextDecoder().decode(bytes), "héllo 🌍");
});

Deno.test("base64ToBytes: decodes empty content and rejects malformed input", () => {
  assertEquals(base64ToBytes(""), new Uint8Array());
  assertThrows(() => base64ToBytes("%%%not-base64%%%"));
});

// ─────────────────────────────────────────────────────────────────────
// destSlug — stable, filesystem-safe instance names
// ─────────────────────────────────────────────────────────────────────

Deno.test("destSlug: replaces path separators and dots with hyphens", () => {
  assertEquals(
    destSlug("/Users/mat/git/x/.claude/skills/database-scale/stats.md"),
    "Users-mat-git-x-claude-skills-database-scale-stats-md",
  );
});

Deno.test("destSlug: collapses runs of non-alphanumerics", () => {
  assertEquals(destSlug("a//b..c"), "a-b-c");
});

Deno.test("destSlug: trims leading and trailing separators", () => {
  assertEquals(destSlug("/a/b/"), "a-b");
});

Deno.test("destSlug: is stable for the same input", () => {
  const p = "/tmp/foo/bar.md";
  assertEquals(destSlug(p), destSlug(p));
});

// ─────────────────────────────────────────────────────────────────────
// decideSync — the dedup decision
// ─────────────────────────────────────────────────────────────────────

Deno.test("decideSync: no prior record writes as created", () => {
  assertEquals(decideSync(null, "abc", false), {
    write: true,
    reason: "created",
  });
});

Deno.test("decideSync: no prior but dest present writes as written", () => {
  // Prior record absent yet file already on disk (e.g. first sync of a
  // hand-placed file) — still rewrite to take ownership.
  assertEquals(decideSync(null, "abc", true), {
    write: true,
    reason: "written",
  });
});

Deno.test("decideSync: matching SHA with present file is unchanged", () => {
  assertEquals(decideSync("abc", "abc", true), {
    write: false,
    reason: "unchanged",
  });
});

Deno.test("decideSync: matching SHA but missing file is rewritten", () => {
  // Local copy was deleted; restore it even though upstream is unchanged.
  assertEquals(decideSync("abc", "abc", false), {
    write: true,
    reason: "created",
  });
});

Deno.test("decideSync: differing SHA with present file is written", () => {
  assertEquals(decideSync("old", "new", true), {
    write: true,
    reason: "written",
  });
});

Deno.test("decideSync: differing SHA with missing file is created", () => {
  assertEquals(decideSync("old", "new", false), {
    write: true,
    reason: "created",
  });
});
