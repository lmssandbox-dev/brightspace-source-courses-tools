# Bulk processing performance and safety

## Preparation

Both copy tools automatically use IDs directly and resolve only supplied codes. When both ID and code are supplied, they must agree. No mapping-check selector or extra course-detail reads are used during preparation. Course names may be blank for ID-only mappings. Course Copy defers type/access errors to Brightspace's copy API.

CSV structure and identifier format, 10,000-row/5 MB limits, self-copy prevention, duplicate suppression and conflicting/overlapping mappings are still checked locally. Invalid or unresolved rows are excluded from executable tasks and remain in the report. Confirmation is available when at least one valid mapping remains, with a warning to review excluded rows. Nothing is submitted before confirmation.

All three tools use the shared MongoDB org-code directory first, in 500-code batches. Missing codes use bounded exactOrgUnitCode API searches and are saved for future jobs. Per-job promises deduplicate concurrent misses. The nightly Organizational Units dataset import refreshes the directory; known matches reflect the saved snapshot, not a live permission/code check. See [RESOLUTION.md](RESOLUTION.md) for setup, freshness, failure behavior and server-only commands.

Source Deployer also resolves at most eight mappings concurrently using the shared directory and per-job promise cache, with no source/replica detail reads. Conflict detection and source grouping run in CSV order after resolution. Planning saves progress every 25 processed mappings. Execution retains source/replica checks before changing activation state, plus deactivation/read-back, deployment and reactivation safeguards. These execution steps are separate from mapping preparation.

## Submission and checking

Course Copy has up to four submission workers. Each saves an uncertain-intent checkpoint **before** its POST, then saves the returned token/result. Workers queue copies without waiting for Brightspace to finish copying. On-demand native status checks use up to four workers and skip terminal tokens.

Source Deployer runs up to four independent source groups concurrently. Batches for the **same source** remain sequential and contain at most 100 replicas. Every batch preserves this sequence: validate, deactivate and verify replicas, submit deployment, reactivate accepted replicas and verify active state. Rejected and uncertain replicas are never automatically activated. Deployment copy-log monitoring checks up to 10 replicas per dispatch with four concurrent reads and keeps previously confirmed successes.

One primary job still holds the application worker lease. Date Manager resolves up to eight course identifiers and discovers up to four courses concurrently, then updates up to four independent courses after every course passes accessibility revalidation. The API ceiling below covers all these workflows and concurrent monitor traffic together.

## Shared API budget

The Mongo gate is keyed by tenant origin and OAuth client ID. It admits at most four requests concurrently, reserves credits before sending, and targets 30,000 credits per local 60-second window. It uses the highest measured cost per normalized route, with 125 credits / 250 ms spacing when cost is unknown. Missing cost headers restore that conservative reservation without reporting it as a measured cost. At a known cost of 10 credits, minimum start spacing is 20 ms. Costs above the entire local budget stop requests for review.

Responses adjust spacing to remaining credits/reset time. A remaining balance at or below 10,000 credits (or the last request cost, if higher) pauses new requests. HTTP 429 pauses all workers for at least 60 seconds or the longer server reset/Retry-After, plus one second. Already-sent requests can finish. The pause survives restart and a late successful response cannot shorten it. Explicit 429 rejection is retried within bounded limits; timeouts and ambiguous write outcomes are never automatically replayed.

These are application safeguards, not a guarantee that 429s can never occur: Brightspace can change request costs and other clients can consume credits. Coordinate instances on the same database and OAuth registration; separate databases cannot share reservations. Do not run old serial-gate binaries concurrently with this version. MongoDB failure prevents new requests.

D2L documents the response headers and dynamic costs in [API rate limiting](https://docs.valence.desire2learn.com/basic/apicall.html#rate-limiting).

## Persistence and interruption

Execution saves only changed task paths plus small job metadata instead of rewriting thousands of rows on every response. Checkpoints are serialized within a job and retain worker/status guards. Copy/deployment checkpoint requests arriving together are combined during a 10 ms collection window; every caller waits for the combined database write before submitting its copy. Requests arriving during a write belong to the next batch. A failed batch rejects all waiting workers and poisons that job queue. Date jobs also use the 10 ms collection window, with immutable chunk snapshots captured before database writes. Final saves retain the complete cumulative report. Failed persistence stops scheduling; active workers drain before the lease is released. A systemic copy failure stops new submissions, but up to four already in flight can still complete. Deployment groups similarly finish in-flight batches while stopping new groups/batches after their systemic-failure threshold.

Interrupted copy/deployment jobs retain checkpoints and saved tokens; they are not blindly resumed or resubmitted. An accepted request whose response could not be saved remains uncertain. Inspect Brightspace before creating a replacement job. Cancellation during Course Copy preparation stops further validation, with up to four mappings finishing in flight; it cannot undo a submitted Brightspace copy.

Deploy this version after current bulk jobs finish. No new environment variables, migration script, service or CSV columns are required.

## Administrator-only measurements

Run in the Render shell after a small representative job:

```sh
node scripts/api-cost-report.js
node scripts/job-performance-report.js
```

Both commands read MongoDB only. They never send Brightspace requests. Costs and timings are not shown to end users or added to downloadable course reports.

The API report shows measured costs plus average HTTP duration, average gate wait and maximum HTTP duration. Timing averages include only newly timed requests, so older cost records do not dilute them. Endpoint paths omit IDs, tokens and query strings. Gate wait includes reservation/database/cooldown waits; HTTP duration excludes job persistence and token acquisition. It does not separately measure local semaphore queue time.

The job report shows the latest 20 jobs for this deployment with preparation, submission and native-check durations, logical checkpoint requests, physical checkpoint count and checkpoint duration. New jobs can therefore show fewer physical checkpoints than logical requests. Unfinished/interrupted phases have no finished duration. Checkpoint aggregates exclude the final save's own duration. Source Deployer's separate copy-log monitor does not currently publish a job phase duration. Submission duration measures app submission/preparation/activation work, **not** Brightspace's later copy completion time. These reports contain job IDs, never credentials or course content.

Compare equivalent jobs with the same mapping count, identifier mode and components. First verify content/status on a small job, then increase volume. Local regression tests include 5,000-row direct preparation and submission, repeated lookups, batch ordering, concurrent failure handling, targeted persistence and a deterministic model of the actual Mongo reservation expressions. They do not replace a live MongoDB/Render/Brightspace performance test or establish a completion-time promise.

## Reducing database round trips

Worker lease renewals share an in-flight renewal and reuse a recently verified lease for less than 10 seconds (or one quarter of a shorter lease). The 10-second heartbeat remains active. Expired leases are never reused; a failed renewal blocks further work until a new acquisition. Per-job database writes still require the matching worker and active job status. This removes redundant lease writes around every checkpoint without removing ownership fencing.

The API gate initializes its Mongo document once per process. Short reservation attempts are serialized locally to reduce collisions; HTTP requests still overlap up to four. A cached next-start time, cooldown or credit-window deadline returns a wait without querying MongoDB. All actual grants still pass the atomic Mongo filter. Permit contention uses 250–1,000 ms backoff, and a local completion clears that contention backoff. It never clears a global cooldown. Insufficient credits consider the next request's estimated cost, even when used credits are slightly below the ceiling.

### Check database latency and hosting regions

Run from the **Render shell**, where the application runs:

```sh
node scripts/mongodb-latency-report.js
```

This command performs eight read-only MongoDB pings and reports connection time plus minimum, median and maximum ping duration. It prints no connection URI, credentials, hostname, or database contents. Ping time is not the same as a durable write's latency; database load and write concern can also matter. Compare it with checkpoint timing after repeating the same small job.

Check the Render service region and Atlas cluster/primary region in their dashboards. Do not infer region from an opaque cluster hostname or ping measurement. Render currently lists Oregon, Ohio, Virginia, Frankfurt and Singapore in its [region documentation](https://render.com/docs/regions); AWS São Paulo is not a listed Render service region. If Atlas is in São Paulo, confirm the Render location before considering any migration. No hosting region or database configuration is changed by this update.

Deploy after current jobs finish, repeat the same 11-copy workload and inspect all three reports. Concurrency remains four. The regression suite verifies batching barriers, failure propagation, lease expiry, single initialization and no database polling during a known cooldown. Live latency and throughput must still be measured after deployment.

Source Deployer uses the shared lease reuse, gate waiting and checkpoint coalescing improvements. Activation retries now checkpoint only the affected task, and normal execution omits the redundant end-of-batch save after submission/activation results have already been persisted. Pre-write intent checkpoints, course-state verification, the 100-replica batch limit and sequential batches for each source remain intact. Test a small deployment separately: Course Copy timing does not predict deployment timing because deployment also prepares and reactivates replicas.

Date Manager performance update: course resolution uses up to eight workers; discovery/preview, accessibility revalidation and application use up to four independent courses. Activities within a course remain sequential. All courses must pass revalidation before any write. Repeated CSV identifiers are deduplicated; resolved aliases are processed once. Checkpoints coalesce for 10 ms and snapshot immutable chunks before database I/O. The 250,000-activity limit reserves capacity before parallel preview work. Existing stale-preview, unrelated-setting preservation, read-back verification, worker fencing and uncertain-write recovery remain enabled. No new environment variables are required. Measure a small date job separately with `node scripts/job-performance-report.js`; copy timings do not predict date-update duration. These changes do not remove cross-region MongoDB latency.

Date Manager uses the shared persistent code directory plus a per-planning-run cache for current course reads. ID/code aliases share the course-read promise; each new planning run revalidates those details. Date execution revalidates access separately and preserves stale-date/read-back checks. Source Deployer uses the same persistent code directory; its execution-time activation safeguards are unchanged.

Date Manager CSV accepts an ID, a code, or both in `OrgUnitId,OrgUnitCode`. With both supplied, directory/live code resolution must match the supplied ID before activity discovery. Distinct pairs are validated before resolved-course deduplication, so a repeated ID with a different code cannot bypass matching. Mismatches appear in the report and block the date plan under the existing all-courses-valid requirement. IDs alone skip code resolution; pairs use the shared directory and per-job lookup cache. CSV headers are unchanged; dataset scheduling has optional settings documented in RESOLUTION.md.

Code resolution uses eight mapping workers in Course Copy, Source Deployer and Date Manager. Only GET orgstructure requests with a nonempty exactOrgUnitCode filter qualify for the eight-request allowance. Other calls (including course details, discovery, status checks and writes) share a four-request allowance; all classes together are capped at eight. Credit reservations, pacing, cooldowns and lease expiry remain shared and unchanged. No new environment variables are needed. Compare the same CSV before/after deployment using server-side timing reports; doubling workers does not guarantee twice the throughput.


## Shared directory and nightly dataset refresh

All three tools use the shared MongoDB org-code directory first, in 500-code batches. Missing codes use bounded exactOrgUnitCode API searches and are saved for future jobs. Per-job promises deduplicate concurrent misses. The nightly Organizational Units dataset import refreshes the directory; known matches reflect the saved snapshot, not a live permission/code check. See [RESOLUTION.md](RESOLUTION.md) for setup, freshness, failure behavior and server-only commands.

Run `node scripts/sync-org-units.js` to initialize/refresh after granting the Service User dataset access, then `node scripts/org-unit-cache-report.js` to inspect freshness. Scheduled refresh defaults to 06:00 UTC. The OAuth scope is `datasets:bds:read`; no extra credentials or CSV changes are needed. The 8-worker resolution / 4-worker ordinary API limits remain unchanged. A failed import preserves the previous generation.


Directory sync now downloads a full plus newer differentials for initial setup (and once when upgrading a legacy cache). Later runs download only unprocessed differentials; a newer full rebuilds the baseline. There is no fixed 36-hour interval assumption. The extract ledger and directory publish together after success. Incremental runs use a bounded local MongoDB staging copy for atomic publication, so they reduce API downloads but still require staging storage and database I/O. See [RESOLUTION.md](RESOLUTION.md) for continuity checks and operational details. No environment or CSV changes are required.
