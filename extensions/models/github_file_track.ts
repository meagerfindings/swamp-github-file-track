/**
 * Track files in GitHub repositories and materialize them on the local
 * filesystem, deduplicated on the upstream Git blob SHA.
 *
 * A single `sync` call fans out across any number of targets — each a
 * `{repo, ref, srcPath, destPath}` tuple — fetching the current blob via the
 * `gh` CLI, comparing its SHA against the last recorded sync, and rewriting the
 * destination file only when the upstream content has changed (or the
 * destination is missing). This makes it a composable primitive for keeping a
 * local copy of someone else's file (a shared skill, a snapshot, a config)
 * fresh without re-fetching or rewriting on every run.
 *
 * @module
 */

import { z } from "npm:zod@4";

// --- Schemas ---

/**
 * A single file to track: a path inside a GitHub repo, mirrored to a local
 * destination. `label` is an optional human-friendly identifier echoed back in
 * the sync record so callers can correlate results without re-deriving paths.
 */
const TargetSchema = z.object({
  /** GitHub repository in `owner/repo` form. */
  repo: z.string(),
  /** Git ref (branch, tag, or commit SHA) to read the file at. */
  ref: z.string().default("main"),
  /** Path to the file inside the repository. */
  srcPath: z.string(),
  /** Absolute local filesystem path to write the file to. */
  destPath: z.string(),
  /** Optional caller-supplied label, echoed back in the sync record. */
  label: z.string().optional(),
});

/** Validated global arguments for a github-file-track model instance. */
const GlobalArgsSchema = z.object({
  /**
   * Default targets to sync when `sync` is called without an explicit list.
   * Lets a model instance bake in its tracked files so a scheduler can call
   * `sync` with no arguments.
   */
  targets: z.array(TargetSchema).default([]),
});

/**
 * The persisted record of the last successful sync for one destination path.
 * Keyed (as an instance name) by a slug of `destPath`, so the next run can
 * compare the upstream SHA without re-reading the destination file.
 */
const SyncRecordSchema = z.object({
  /** GitHub repository the file was tracked from. */
  repo: z.string(),
  /** Git ref the file was read at. */
  ref: z.string(),
  /** Source path inside the repository. */
  srcPath: z.string(),
  /** Local destination path the file was written to. */
  destPath: z.string(),
  /** Caller-supplied label, if any. */
  label: z.string().default(""),
  /** Upstream Git blob SHA of the tracked file at last fetch. */
  blobSha: z.string(),
  /** Whether this run wrote the destination file. */
  changed: z.boolean(),
  /** Why the file was (not) written: written | unchanged | created. */
  reason: z.enum(["written", "unchanged", "created"]),
  /** Size in bytes of the materialized file. */
  bytes: z.number(),
  /** ISO-8601 timestamp of this sync run. */
  syncedAt: z.string(),
});

/** Aggregate summary across all targets in one `sync` invocation. */
const SyncSummarySchema = z.object({
  /** Total targets processed. */
  total: z.number(),
  /** Targets whose destination file was (re)written. */
  changed: z.number(),
  /** Targets skipped because the upstream SHA matched the last sync. */
  unchanged: z.number(),
  /** Destination paths that were (re)written this run. */
  changedPaths: z.array(z.string()),
  /** ISO-8601 timestamp of this sync run. */
  syncedAt: z.string(),
});

// --- Types ---

type Target = z.infer<typeof TargetSchema>;
type SyncRecord = z.infer<typeof SyncRecordSchema>;

interface CmdResult {
  success: boolean;
  stdout: string;
  stderr: string;
  code: number;
}

/** Shape of the GitHub `contents` API response for a single file. */
interface GitHubContentsResponse {
  sha: string;
  content: string;
  encoding: string;
  type: string;
}

// --- Helpers ---

/**
 * Run a subprocess and capture its output. Never throws on a non-zero exit;
 * callers inspect `success`/`code` so a failing `gh` call surfaces as a typed
 * result rather than an exception mid-fan-out.
 */
async function runCmd(
  cmd: string[],
  opts?: { cwd?: string },
): Promise<CmdResult> {
  const command = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    stdout: "piped",
    stderr: "piped",
    cwd: opts?.cwd,
  });
  const output = await command.output();
  return {
    success: output.success,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
    code: output.code,
  };
}

/**
 * Turn a destination path into a stable, filesystem-safe instance name so each
 * tracked file gets its own sync-record slot in the data store.
 */
export function destSlug(destPath: string): string {
  return destPath.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Pure decision: should the destination be (re)written? The file is written
 * when the upstream SHA differs from the prior record, OR when it matches but
 * the destination file is missing on disk (so a deleted local copy is restored
 * even though upstream is unchanged). Returns the `reason` for the record.
 */
export function decideSync(
  priorSha: string | null,
  upstreamSha: string,
  destPresent: boolean,
): { write: boolean; reason: "written" | "unchanged" | "created" } {
  const shaMatches = priorSha !== null && priorSha === upstreamSha;
  if (shaMatches && destPresent) {
    return { write: false, reason: "unchanged" };
  }
  return { write: true, reason: destPresent ? "written" : "created" };
}

/**
 * Fetch a file's blob SHA and decoded text from GitHub via the `gh` CLI.
 * Throws a descriptive error (carrying `gh`'s stderr) when the file cannot be
 * read — missing path, bad ref, auth failure, or a file too large for the
 * contents API. The caller's `Promise.allSettled` isolates the failure so other
 * targets still sync.
 */
async function fetchFile(
  target: Target,
): Promise<{ sha: string; content: string }> {
  const endpoint =
    `repos/${target.repo}/contents/${target.srcPath}?ref=${target.ref}`;
  const result = await runCmd(["gh", "api", endpoint]);
  if (!result.success) {
    throw new Error(
      `gh api ${endpoint} failed (exit ${result.code}): ` +
        `${result.stderr.trim() || "no stderr"}`,
    );
  }
  let parsed: GitHubContentsResponse;
  try {
    parsed = JSON.parse(result.stdout) as GitHubContentsResponse;
  } catch {
    throw new Error(`gh api ${endpoint} returned non-JSON output`);
  }
  // The contents API returns encoding "none" for files over ~1 MB; those must
  // be read via the blob API, which this model does not support.
  if (parsed.type !== "file" || parsed.encoding !== "base64") {
    throw new Error(
      `${target.repo}:${target.srcPath} is not a base64 file ` +
        `(type=${parsed.type}, encoding=${parsed.encoding}); ` +
        `files over ~1 MB are not supported`,
    );
  }
  // GitHub base64-encodes contents with embedded newlines; strip them first.
  const decoded = new TextDecoder().decode(
    base64ToBytes(parsed.content.replace(/\n/g, "")),
  );
  return { sha: parsed.sha, content: decoded };
}

/** Decode a base64 string to bytes without relying on `atob` charcode quirks. */
function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Whether a path exists on disk (file or directory). */
async function pathExists(path: string): Promise<boolean> {
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

/**
 * Sync one target: fetch upstream, compare against the prior record, and write
 * the destination only when content changed or the file is missing. Returns the
 * record to persist, or throws if the upstream file cannot be fetched.
 */
async function syncOne(
  target: Target,
  prior: SyncRecord | null,
  syncedAt: string,
): Promise<SyncRecord> {
  const fetched = await fetchFile(target);
  const destPresent = await pathExists(target.destPath);
  const decision = decideSync(
    prior?.blobSha ?? null,
    fetched.sha,
    destPresent,
  );

  if (decision.write) {
    // Ensure the destination directory exists, then write.
    const dir = target.destPath.slice(0, target.destPath.lastIndexOf("/"));
    if (dir) {
      await Deno.mkdir(dir, { recursive: true });
    }
    await Deno.writeTextFile(target.destPath, fetched.content);
  }

  return SyncRecordSchema.parse({
    repo: target.repo,
    ref: target.ref,
    srcPath: target.srcPath,
    destPath: target.destPath,
    label: target.label ?? "",
    blobSha: fetched.sha,
    changed: decision.write,
    reason: decision.reason,
    bytes: new TextEncoder().encode(fetched.content).length,
    syncedAt,
  });
}

// --- Model ---

/**
 * The `@mgreten/github-file-track` model: a `sync` method that mirrors tracked
 * GitHub files to local paths, deduplicated on the upstream blob SHA. Configure
 * `globalArguments.targets` on an instance and call `sync` on a schedule.
 */
export const model = {
  type: "@mgreten/github-file-track",
  version: "2026.05.29.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "syncRecord": {
      description:
        "Per-destination record of the last sync: upstream blob SHA, whether " +
        "the file was rewritten, and byte size. One instance per destPath.",
      schema: SyncRecordSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    "syncSummary": {
      description: "Aggregate counts across all targets in one sync run.",
      schema: SyncSummarySchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    sync: {
      description:
        "Fetch each tracked file from GitHub and write it locally when the " +
        "upstream blob SHA changed (or the destination is missing). Fans out " +
        "across all targets in a single execution. Pass `targets` to override " +
        "the instance default.",
      arguments: z.object({
        /** Targets to sync; defaults to the instance's `globalArgs.targets`. */
        targets: z.array(TargetSchema).optional(),
      }),
      execute: async (
        args: { targets?: Target[] },
        context: {
          globalArgs: z.infer<typeof GlobalArgsSchema>;
          writeResource: (
            specName: string,
            instanceName: string,
            data: unknown,
          ) => Promise<{ name: string }>;
          readResource?: (
            instanceName: string,
          ) => Promise<Record<string, unknown> | null>;
          logger: {
            info: (msg: string, props?: Record<string, unknown>) => void;
            warning: (msg: string, props?: Record<string, unknown>) => void;
          };
        },
      ): Promise<{ dataHandles: { name: string }[] }> => {
        const targets = args.targets ?? context.globalArgs.targets;
        if (targets.length === 0) {
          throw new Error(
            "no targets to sync — pass `targets` or set globalArgs.targets",
          );
        }

        context.logger.info("github-file-track: syncing {count} target(s)", {
          count: targets.length,
        });

        const syncedAt = new Date().toISOString();
        const handles: { name: string }[] = [];
        const changedPaths: string[] = [];
        let changedCount = 0;

        // Fan out: process every target in one execution under one lock.
        const results = await Promise.allSettled(
          targets.map(async (target) => {
            const slug = destSlug(target.destPath);
            const priorRaw = context.readResource
              ? await context.readResource(slug)
              : null;
            const prior = priorRaw
              ? (SyncRecordSchema.parse(priorRaw) as SyncRecord)
              : null;
            const record = await syncOne(target, prior, syncedAt);
            return { slug, record };
          }),
        );

        for (let i = 0; i < results.length; i++) {
          const result = results[i];
          if (result.status === "rejected") {
            context.logger.warning("github-file-track: target failed: {err}", {
              err: String(result.reason),
              target: targets[i].destPath,
            });
            continue;
          }
          const { slug, record } = result.value;
          if (record.changed) {
            changedCount++;
            changedPaths.push(record.destPath);
          }
          const handle = await context.writeResource(
            "syncRecord",
            slug,
            record,
          );
          handles.push(handle);
          context.logger.info(
            "github-file-track: {reason} {destPath} ({bytes} bytes)",
            {
              reason: record.reason,
              destPath: record.destPath,
              bytes: record.bytes,
            },
          );
        }

        const summaryHandle = await context.writeResource(
          "syncSummary",
          `summary-${syncedAt}`,
          SyncSummarySchema.parse({
            total: targets.length,
            changed: changedCount,
            unchanged: handles.length - changedCount,
            changedPaths,
            syncedAt,
          }),
        );
        handles.push(summaryHandle);

        return { dataHandles: handles };
      },
    },
  },
};
