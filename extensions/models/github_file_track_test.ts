import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  base64ToBytes,
  decideSync,
  destSlug,
  model,
} from "./github_file_track.ts";

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
  assertEquals(model.resources.syncSummary.schema.parse(summary), summary);
  assertThrows(() =>
    model.resources.syncSummary.schema.parse({
      ...summary,
      changedPaths: "/tmp/file.md",
    })
  );
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
