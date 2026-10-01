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

## Socket and SSE load testing

The first optimization checkpoint is commit `7c8dfb3f`. Follow-up testing uses
real Socket.IO CLI clients, authenticated gzip SSE streams, and HTTP message
pagination against an isolated Hub. No production credentials or databases are
used. Run the driver with Node 24 (native TypeScript support) and put Bun on PATH:

```sh
PATH="$HOME/.bun/bin:$PATH" node hub/scripts/stress-long-session.ts \
    --messages 500000 --sessions 2 --clients 1 --rate 80 \
    --duration 15 --mode mixed --cpu 0
bun run --cwd hub typecheck:scripts
```

`messages` is per session. The Hub worker is pinned to one CPU with `taskset`;
the driver runs separately. Use a CPU permitted by your host's affinity mask,
or omit `--cpu`. Fixtures contain invoked historical messages and metadata
growing with history size. Mixed traffic includes real metadata/state changes,
agent/user messages and heartbeats. Replay traffic repeats unchanged updates.
The shared-client scenario deliberately exercises stale-version conflicts;
these are counted separately from errors.

The generator is open-loop, with a limit of 32 outstanding operations per
client. Offered, sent, acknowledged and backpressured counts are all reported;
do not infer successful processing of the full offered rate from latency alone.
Message/heartbeat operations use a subsequent ping acknowledgement as an
ordering barrier. Probes open fresh SSE connections and fetch the latest 50
messages every 250 ms; existing SSE streams remain open and are drained.
SSE handshake measures the first complete `connection-changed` frame, not just
HTTP headers. Probe deadlines are five seconds. Worker CPU is process CPU as a
percentage of one core, and event-loop delay is sampled by a 10 ms timer.
WebSocket wire bytes exclude HTTP/SSE traffic. RSS is sampled, not a heap-size
measurement. The harness removes its generated database on exit.

For a diagnostic CPU profile, add `--profile /tmp`. Profiles include startup
and fixture insertion, so distinguish that work from steady-state traffic.
The profile of the replay test attributed most steady-state work to WebSocket
send and Socket.IO JSON parse/stringify, rather than SQL writes. It does not
prove the precise fraction spent compressing versus socket I/O.

## Follow-Up Optimizations

- CLI metadata updates now preserve Hub-owned fields inside the same store
  transaction that checks the live version and namespace. This avoids a second
  full-session read, while retaining protection against forged or stale Hub
  fields. Internal writes keep their previous behavior.
- Position cursors use composite comparisons on timestamp and sequence, matching
  the existing display-order index and retaining strict/inclusive boundaries.
- Schema v27 adds `idx_messages_uninvoked_local`, covering the latest-page
  queue lookup without scanning every historical message. It includes scheduled
  and indeterminate rows; the narrower immediate-delivery index remains intact.
- WebSocket compression remains negotiated and enabled, but uses Bun's `3KB`
  compressor rather than the default shared compressor. This lowered blocking
  under the large-metadata replay workload. It can trade compression ratio for
  CPU cost; wire bytes are now measured rather than assuming identical bandwidth.
  Terminal and voice-proxy workloads still need separate production-like checks.

Schema upgrade builds an index over existing messages and can delay startup on
a large database. An older v26 binary will reject a v27 database: rollback must
restore the pre-upgrade backup, not simply swap binaries.

## Load-Test Results

Full machine-readable results are in [long-session-stress-results.json](long-session-stress-results.json).
Before is checkpoint `7c8dfb3f`; after includes all follow-up changes above.
Runs were sequential on the same workstation, each for 15 seconds, with two
sessions and a single-core Hub. Values below are before / after, in milliseconds
except CPU and throughput. These are individual runs, not confidence intervals.

| Scenario | ACK P95 | SSE P95 | Messages API P95 | Loop P99 | CPU % | ACK/s |
| --- | --- | --- | --- | --- | --- | --- |
| 100k/session, mixed 80/s | 11.8 / 10.5 | 3.7 / 13.5 | 22.5 / 9.3 | 10.7 / 5.2 | 24.7 / 23.7 | 80 / 80 |
| 500k/session, mixed 80/s | 52.6 / 19.1 | 14.3 / 12.9 | 86.4 / 19.6 | 66.0 / 15.1 | 52.1 / 39.4 | 79.9 / 80 |
| 500k/session, replay 400/s | 1505 / 254 | 2594 / 139 | 125 / 153 | 1728 / 75.6 | 99.3 / 90.9 | 168 / 339 |
| 100k/session, 2 clients/session, mixed 240/s | 932 / 625 | 405 / 641 | 1189 / 798 | 317 / 248 | 80.2 / 76.9 | 212 / 229 |

All final runs had zero acknowledgement errors and zero probe errors. The
baseline replay run had two probe errors and only three successful SSE samples,
so that percentile has especially limited statistical value. Final replay still
backpressured 922 of 6,000 offered operations; shared-client traffic backpressured
172 of 3,600. Version mismatches are expected in the shared-client scenario.
SSE latency did not improve universally, despite lower acknowledgement and
event-loop latency. Do not describe this as a complete reconnect-timeout fix.

A separate 30-second replay run acknowledged 9,008 operations (300/s), with
zero errors, 2,992 backpressured operations, CPU 95.1%, ACK P95 258 ms, SSE P95
1,281 ms and loop P99 213 ms. This confirms higher throughput but also exposes
occasional stalls under sustained saturation. Its WebSocket traffic was 106.7 MB
received by the driver and 125.2 MB sent, excluding HTTP/SSE. Shorter-run SSE
results are not a guarantee of low tail latency over longer periods.

Validation after the follow-up changes: 1,384 Hub tests passed, three skipped,
zero failed; Hub and script typechecks and Hub build passed. Migration coverage
checks v26->v27 and repeated reopen, index selection, scheduled/indeterminate
queue visibility, and retained historical data. The load driver's interrupt
cleanup is tested separately from the steady-state measurements.

## Production Verification

The synthetic load test does not model a remote tunnel, a slow browser's render
loop, or every CLI agent. Extreme repeated metadata traffic still costs full
JSON parsing and acknowledgements; avoiding that completely would require
client coalescing or a negotiated delta protocol. Short local runs do not
establish long-running stability or eliminate production reconnect timeouts.

Before a production upgrade, back up the live SQLite database using SQLite's
backup API, verify the 0.29.0-to-current migration on a copy, and preserve the
old image and database backup for rollback. This development work has not
changed or restarted the production Hub.
