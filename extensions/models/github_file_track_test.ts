import { assertEquals } from "jsr:@std/assert@1";
import { decideSync, destSlug } from "./github_file_track.ts";

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
