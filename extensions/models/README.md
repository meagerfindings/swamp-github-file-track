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
   `unchanged` and writes nothing.

`Promise.allSettled` isolates targets — one failing fetch (bad ref, missing
path, auth error) is logged and skipped without aborting the others.

## Limits

- Files larger than ~1 MB are not supported. The GitHub contents API returns
  `encoding: "none"` for those and requires the blob API; `sync` raises a clear
  error rather than writing a truncated file.
- `destPath` should be absolute. Parent directories are created as needed.

## Resources

| Resource      | Description                                                        |
| ------------- | ----------------------------------------------------------------- |
| `syncRecord`  | Per-destination record: `blobSha`, `changed`, `reason`, `bytes`.  |
| `syncSummary` | Aggregate per run: `total`, `changed`, `unchanged`, `changedPaths`. |

## License

MIT — see [LICENSE.txt](LICENSE.txt).
