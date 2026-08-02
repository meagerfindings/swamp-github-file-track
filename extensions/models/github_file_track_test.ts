import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
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

interface ResourceWrite {
  specName: string;
  instanceName: string;
  data: Record<string, unknown>;
}

/** Run a test with a fake `gh` executable first on PATH. */
async function withFakeGh(
  script: string,
  run: (tempDir: string) => Promise<void>,
): Promise<void> {
  const tempDir = await Deno.makeTempDir();
  const oldPath = Deno.env.get("PATH") ?? "";
  try {
    const ghPath = `${tempDir}/gh`;
    await Deno.writeTextFile(ghPath, `#!/bin/sh\n${script}`);
    await Deno.chmod(ghPath, 0o755);
    Deno.env.set("PATH", `${tempDir}:${oldPath}`);
    await run(tempDir);
  } finally {
    Deno.env.set("PATH", oldPath);
    await Deno.remove(tempDir, { recursive: true });
  }
}

/** Whether a test path exists. */
async function testPathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      return false;
    }
    throw err;
  }
}

/** Invoke `sync` while recording every resource write. */
async function executeSync(
  targets: Array<{
    repo: string;
    ref?: string;
    srcPath: string;
    destPath: string;
  }>,
  writes: ResourceWrite[],
): Promise<{ dataHandles: { name: string }[] }> {
  const args = model.methods.sync.arguments.parse({ targets });
  return await model.methods.sync.execute(args, {
    globalArgs: { targets: [] },
    writeResource: (specName, instanceName, data) => {
      writes.push({
        specName,
        instanceName,
        data: data as Record<string, unknown>,
      });
      return Promise.resolve({ name: instanceName });
    },
    logger: {
      info: () => {},
      warning: () => {},
      error: () => {},
    },
  });
}

// ─────────────────────────────────────────────────────────────────────
// schemas — defaults, contracts, and malformed inputs
// ─────────────────────────────────────────────────────────────────────

Deno.test("global arguments: defaults targets to an empty list", () => {
  assertEquals(model.globalArguments.parse({}), { targets: [] });
});

Deno.test("sync arguments: applies main ref and preserves an optional label", () => {
  assertEquals(
    model.methods.sync.arguments.parse({
      targets: [{
        repo: "owner/repo",
        srcPath: "docs/readme.md",
        destPath: "/tmp/readme.md",
        label: "documentation",
      }],
    }),
    {
      targets: [{
        repo: "owner/repo",
        ref: "main",
        srcPath: "docs/readme.md",
        destPath: "/tmp/readme.md",
        label: "documentation",
      }],
    },
  );
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
// sync execution — failures persist a summary and fail the method
// ─────────────────────────────────────────────────────────────────────

Deno.test("sync: failed fetch writes its summary before rejecting", async () => {
  await withFakeGh(
    "echo 'gh: Bad credentials (HTTP 401)' >&2\nexit 1\n",
    async (tempDir) => {
      const destPath = `${tempDir}/policy.hujson`;
      await Deno.writeTextFile(destPath, "stale-but-intact");
      const writes: ResourceWrite[] = [];

      await assertRejects(
        () =>
          executeSync([{
            repo: "owner/private-repo",
            srcPath: "policy.hujson",
            destPath,
          }], writes),
        Error,
        "1 of 1 target(s) failed to sync",
      );

      assertEquals(await Deno.readTextFile(destPath), "stale-but-intact");
      assertEquals(writes.length, 1);
      assertEquals(writes[0].specName, "syncSummary");
      assertEquals(writes[0].data.total, 1);
      assertEquals(writes[0].data.changed, 0);
      assertEquals(writes[0].data.unchanged, 0);
      assertEquals(writes[0].data.failed, 1);
      assertEquals(writes[0].data.changedPaths, []);
    },
  );
});

Deno.test("sync: partial failure records successes then rejects", async () => {
  await withFakeGh(
    `case "$2" in
  *good.md*)
    echo '{"sha":"goodsha","content":"ZnJlc2g=","encoding":"base64","type":"file"}'
    ;;
  *)
    echo 'gh: Not Found (HTTP 404)' >&2
    exit 1
    ;;
esac
`,
    async (tempDir) => {
      const goodPath = `${tempDir}/good.md`;
      const badPath = `${tempDir}/bad.md`;
      await Deno.writeTextFile(badPath, "stale-but-intact");
      const writes: ResourceWrite[] = [];

      await assertRejects(
        () =>
          executeSync([
            {
              repo: "owner/repo",
              srcPath: "good.md",
              destPath: goodPath,
            },
            {
              repo: "owner/repo",
              srcPath: "bad.md",
              destPath: badPath,
            },
          ], writes),
        Error,
        "1 of 2 target(s) failed to sync",
      );

      assertEquals(await Deno.readTextFile(goodPath), "fresh");
      assertEquals(await Deno.readTextFile(badPath), "stale-but-intact");
      assertEquals(writes.map((write) => write.specName), [
        "syncRecord",
        "syncSummary",
      ]);
      assertEquals(writes[1].data.total, 2);
      assertEquals(writes[1].data.changed, 1);
      assertEquals(writes[1].data.unchanged, 0);
      assertEquals(writes[1].data.failed, 1);
      assertEquals(writes[1].data.changedPaths, [goodPath]);
      const entries = await Array.fromAsync(Deno.readDir(tempDir));
      assertEquals(
        entries.some((entry) => entry.name.startsWith("good.md.tmp-")),
        false,
      );
    },
  );
});

Deno.test("sync: rejects duplicate destinations before invoking gh", async () => {
  await withFakeGh(
    'touch "$(dirname "$0")/invoked"\nexit 99\n',
    async (tempDir) => {
      const writes: ResourceWrite[] = [];

      await assertRejects(
        () =>
          executeSync([
            {
              repo: "owner/repo",
              srcPath: "a.md",
              destPath: `${tempDir}/nested/../same.md`,
            },
            {
              repo: "owner/repo",
              srcPath: "b.md",
              destPath: `${tempDir}/same.md`,
            },
          ], writes),
        Error,
        "duplicate destination paths normalize to",
      );

      assertEquals(writes, []);
      assertEquals(await testPathExists(`${tempDir}/invoked`), false);
    },
  );
});

Deno.test("sync: rejects distinct destinations with colliding record slugs", async () => {
  await withFakeGh(
    'touch "$(dirname "$0")/invoked"\nexit 99\n',
    async (tempDir) => {
      const writes: ResourceWrite[] = [];

      await assertRejects(
        () =>
          executeSync([
            {
              repo: "owner/repo",
              srcPath: "a.md",
              destPath: `${tempDir}/a-b`,
            },
            {
              repo: "owner/repo",
              srcPath: "b.md",
              destPath: `${tempDir}/a/b`,
            },
          ], writes),
        Error,
        "destination paths produce the same sync-record name",
      );

      assertEquals(writes, []);
      assertEquals(await testPathExists(`${tempDir}/invoked`), false);
    },
  );
});

Deno.test("sync: failed atomic replacement cleans up its temporary file", async () => {
  await withFakeGh(
    'echo \'{"sha":"abc123","content":"ZnJlc2g=","encoding":"base64","type":"file"}\'\n',
    async (tempDir) => {
      const destPath = `${tempDir}/destination`;
      await Deno.mkdir(destPath);
      const writes: ResourceWrite[] = [];

      await assertRejects(
        () =>
          executeSync([{
            repo: "owner/repo",
            srcPath: "file.md",
            destPath,
          }], writes),
        Error,
        "1 of 1 target(s) failed to sync",
      );

      assertEquals((await Deno.stat(destPath)).isDirectory, true);
      const entries = await Array.fromAsync(Deno.readDir(tempDir));
      assertEquals(
        entries.some((entry) => entry.name.startsWith("destination.tmp-")),
        false,
      );
      assertEquals(writes.map((write) => write.specName), ["syncSummary"]);
      assertEquals(writes[0].data.failed, 1);
    },
  );
});

// ─────────────────────────────────────────────────────────────────────
// base64ToBytes — GitHub contents decoding primitive
// ─────────────────────────────────────────────────────────────────────

Deno.test("base64ToBytes: preserves UTF-8 bytes and accepts embedded newlines once stripped", () => {
  const encoded = "aMOpbGxvIPCfjI0=";
  const bytes = base64ToBytes(
    `\n${encoded.slice(0, 8)}\n${encoded.slice(8)}\n`.replace(/\n/g, ""),
  );
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
    destSlug("/Users/alice/git/x/.claude/skills/database-scale/stats.md"),
    "Users-alice-git-x-claude-skills-database-scale-stats-md",
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
