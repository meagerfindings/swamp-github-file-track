# @mgreten/github-file-track

Track files in GitHub repositories and materialize them on the local
filesystem, deduplicated on the upstream Git blob SHA. A single `sync` call fans
out across any number of `{repo, ref, srcPath, destPath}` targets, fetching each
file via the `gh` CLI and rewriting the destination only when the upstream
content has changed (or the destination is missing).

It's a composable primitive for keeping a local copy of someone else's file
fresh — a shared Claude Code skill, a snapshot, a config — without re-fetching
or rewriting on every run. Point it at one file on a schedule, or at many files
to mirror a whole set in one execution.

## Installation

```sh
swamp extension pull @mgreten/github-file-track
```

Requires the `gh` CLI to be installed and authenticated (`gh auth login`).
Authentication is delegated entirely to `gh` — this model stores no
credentials.

## Setup

Create a model instance and bake the tracked files into its global arguments so
a scheduler can call `sync` with no method arguments:

```sh
swamp model create @mgreten/github-file-track file-track
```

Then set `globalArguments.targets` in the instance definition YAML:

```yaml
globalArguments:
  targets:
    - repo: owner/repo
      ref: main
      srcPath: path/to/file.md
      destPath: /absolute/local/path/file.md
      label: my-file
```

## Usage

Sync the instance's configured targets:

```sh
swamp model method run file-track sync --json
```

Each run writes one `syncRecord` resource per destination (carrying the upstream
`blobSha`, whether the file `changed`, the `reason`, and `bytes`) plus one
`syncSummary` with aggregate counts. On the next run, a destination whose
upstream SHA is unchanged and whose local file is still present is skipped.

## How dedup works

For each target, `sync`:

1. Fetches the file via `gh api repos/{repo}/contents/{srcPath}?ref={ref}`,
   reading the blob `sha` and base64 content.
2. Compares that SHA against the last `syncRecord` for the destination.
3. Writes the file when the SHA differs, **or** when it matches but the local
   file is missing (so a deleted copy is restored). Otherwise reports
   `unchanged` and writes nothing. Changed content is written to a sibling
   temporary file and atomically renamed over the destination.

## Failure handling

`Promise.allSettled` isolates targets — one failing fetch (bad ref, missing
path, auth error) does not abort the others, so a batch still syncs everything
it can. Once the batch finishes, `sync` **fails** if any target failed.

That matters because a failed target leaves its destination file **untouched,
not empty**. Anything reading that file afterwards silently reads stale content,
so a `sync` that reported success would be indistinguishable from one that
genuinely had nothing to do.

Every run records the outcome either way:

```jsonc
// syncSummary — total always equals changed + unchanged + failed
{ "total": 3, "changed": 1, "unchanged": 1, "failed": 1,
  "failures": [{ "repo": "owner/repo", "srcPath": "a.md",
                 "destPath": "/tmp/a.md", "error": "gh api ... (HTTP 401)" }] }
```

The summary is written **before** the error is raised, so the detail is
inspectable with `swamp data get <model> <summary>` even on a failed run.

## Limits

- Files larger than ~1 MB are not supported. The GitHub contents API returns
  `encoding: "none"` for those and requires the blob API; `sync` raises a clear
  error rather than writing a truncated file.
- `destPath` should be absolute. Parent directories are created as needed.
- A batch rejects duplicate normalized destination paths and paths whose
  filesystem-safe sync-record names would collide.

## Resources

| Resource      | Description                                                        |
| ------------- | ----------------------------------------------------------------- |
| `syncRecord`  | Per-destination record: `blobSha`, `changed`, `reason`, `bytes`.  |
| `syncSummary` | Aggregate per run: `total`, `changed`, `unchanged`, `failed`, `failures`, `changedPaths`. |

## License

MIT — see [LICENSE.txt](LICENSE.txt).
