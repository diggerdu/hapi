# Long-session performance development

Date: 2026-10-01.
Upstream baseline: `86c88df93baf5d1f738dd4b202078bdf6dec376e` (CLI version 0.30.7).
Checkout: `/home/alex/Repos/VPS/hapi`.

## Scope

The deployed 0.29.0 Hub profile showed synchronous SQLite and JSON processing
inside CLI socket event handlers saturating the main event loop. Latest upstream
already includes prepared-statement caching, per-socket session-access caching,
and a partial index for immediate queued messages. This patch builds on those
changes rather than reimplementing them.

## Changes

- Versioned metadata/state writes reuse the existing bounded statement cache.
- CLI metadata/state synchronization opts into unchanged-value detection.
  A matching payload and version receives a success acknowledgement with the
  existing version; it does not write, advance activity/sequence, or broadcast.
- Stale versions still receive `version-mismatch`, even for identical payloads.
  Deduplication respects namespace checks, metadata merging, Hub archive fields,
  and preallocated-session adoption. Internal writes keep their prior behavior
  unless they explicitly request deduplication.
- Identical serialized metadata takes a fast path before JSON parsing.
  Merged or reordered objects use semantic equality as a fallback.
- Metadata writes read only identity, tag, metadata, and metadata version.
  Activity recording and post-write broadcasts read only namespace and updated
  time, avoiding unrelated JSON parsing.
- Queued-thinking checks use an indexed, one-row existence query instead of
  loading and decoding every queued prompt. Actual queue delivery still loads
  messages normally.

Activity timestamps continue to persist synchronously and monotonically.
Write batching, client update coalescing, history workers, and frontend changes
are not included in this patch.

## Validation

- Hub typecheck passed.
- Hub suite: 1,382 passed, 3 skipped, 0 failed. The skipped Cursor migration
  integration tests require a real agent/operator fixture.
- CLI versioned-ack tests: 5 passed.
- Web build, embedded asset generation, and Hub build passed. Upstream web
  build warnings about bundle size, manifest metadata, and font references
  remain outside this backend patch.
- `git diff --check` passed.

Added regression tests cover duplicate acknowledgements without broadcasts,
stale-version rejection, cross-namespace denial, null state, nested key ordering,
preallocated stubs, unchanged internal-write behavior, monotonic durable activity,
deleted sessions, and queue eligibility/removal.

## Synthetic benchmark

Run from the repository root:

```sh
bun run hub/scripts/benchmark-long-session.ts
```

The script creates temporary SQLite fixtures with 10,000, 100,000, and 500,000
invoked messages. Synthetic metadata grows from approximately 7.6 KB to 398 KB.
Each operation has 50 warmup calls and 1,000 measured calls. Temporary database
files are removed afterward. A fallback queue check allows the same script to
run against the unmodified upstream checkout for comparison.

Measured locally with Bun 1.3.12 on Linux x86_64; baseline and patched runs were
executed sequentially. The repository declares Bun 1.4.0 as its package manager.
Values below are P95 duration in milliseconds, rounded from one comparison run.

| Messages | Activity before/after | Metadata replay before/after | State replay before/after |
| --- | --- | --- | --- |
| 10,000 | 0.0407 / 0.0107 | 0.0660 / 0.0204 | 0.0179 / 0.0075 |
| 100,000 | 0.2077 / 0.0176 | 0.3338 / 0.1345 | 0.0260 / 0.0060 |
| 500,000 | 1.0888 / 0.0613 | 1.9749 / 0.6994 | 0.0738 / 0.0077 |

Baseline identical metadata/state updates each advanced their version 1,050
times including warmup. Patched versions did not advance. Empty-queue checks
were already approximately 1-2 microseconds upstream and showed no material
improvement. Their plan uses `idx_messages_immediate_queued`.

These are store-path microbenchmarks, not public SSE latency or production CPU
measurements. Metadata comparison still scales with payload size, and a real
activity update still writes the sessions row. The patch does not establish
constant-time processing for arbitrarily growing metadata.

## Next verification

Use an isolated Hub and synthetic CLI traffic to measure event-loop delay and
authenticated SSE handshake latency while multiple long sessions stream.
Include unchanged replays, genuine metadata changes, stale-version retries,
queued input, and concurrent clients. Track per-session event counts and bytes
without logging message content or tokens.

Before a production upgrade, back up the live SQLite database using SQLite's
backup API, verify the 0.29.0-to-current migration on a copy, and preserve the
old image and database backup for rollback. This development work has not
changed or restarted the production Hub.
