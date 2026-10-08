# Bulk processing performance and safety

## Preparation

Both copy tools automatically use IDs directly and resolve only supplied codes. When both ID and code are supplied, they must agree. No mapping-check selector or extra course-detail reads are used during preparation. Course names may be blank for ID-only mappings. Course Copy defers type/access errors to Brightspace's copy API.

CSV structure and identifier format, 10,000-row/5 MB limits, self-copy prevention, duplicate suppression and conflicting/overlapping mappings are still checked locally. Invalid or unresolved rows are excluded from executable tasks and remain in the report. Confirmation is available when at least one valid mapping remains, with a warning to review excluded rows. Nothing is submitted before confirmation.

All three tools use the shared MongoDB org-code directory first, in 500-code batches. The directory stores only non-deleted Course Offerings and Source Courses. Because excluded types are not represented, a code without a live exact-code verification made after the latest publication uses the bounded exactOrgUnitCode API search; successful exact results are reused until a directory publication invalidates them. Per-job promises deduplicate lookups. See [RESOLUTION.md](RESOLUTION.md) for setup, freshness, failure behavior and server-only commands.

Source Deployer also resolves at most eight mappings concurrently using the shared directory and per-job promise cache, with no source/replica detail reads. Conflict detection and source grouping run in CSV order after resolution. Planning saves progress every 25 processed mappings. Execution skips source/replica preflight reads and the redundant inactivity recheck, retaining deactivation/read-back, deployment and reactivation safeguards. These execution steps are separate from mapping preparation.

## Submission and checking

Course Copy has up to eight submission workers. Each saves an uncertain-intent checkpoint **before** its POST, then saves the returned token/result. Workers queue copies without waiting for Brightspace to finish copying. On-demand native status checks use up to eight workers and skip terminal tokens.

Source Deployer runs up to eight independent source groups concurrently. Batches for the **same source** remain sequential and contain at most 100 replicas. Every batch preserves this sequence: deactivate and verify replicas, submit deployment, reactivate accepted replicas and verify active state. Rejected and uncertain replicas are never automatically activated. Deployment copy-log monitoring checks up to 10 replicas per dispatch with eight concurrent reads and keeps previously confirmed successes.

One primary job still holds the application worker lease. Date Manager resolves up to eight course identifiers and discovers up to eight courses concurrently, then updates up to four independent courses after the saved activity preview is confirmed. Assignment, Quiz and Forum reads run concurrently; independent forum topic reads are also scheduled concurrently. The API ceiling below covers all these workflows and concurrent monitor traffic together.

## Shared API budget

The Mongo gate is keyed by tenant origin and OAuth client ID. It admits at most eight requests concurrently across exact-code lookups, Date Manager discovery collection reads, Course Copy submissions/checks and Source Deployer operations/checks, with unrelated requests limited to four; all traffic shares the same eight-request ceiling. It reserves credits before sending and targets 30,000 credits per local 60-second window. It uses the highest measured cost per normalized route, with 125 credits / 250 ms spacing when cost is unknown. Missing cost headers restore that conservative reservation without reporting it as a measured cost. At a known cost of 10 credits, minimum start spacing is 20 ms. Costs above the entire local budget stop requests for review.

Responses adjust spacing to remaining credits/reset time. A remaining balance at or below 10,000 credits (or the last request cost, if higher) pauses new requests. HTTP 429 pauses all workers for at least 60 seconds or the longer server reset/Retry-After, plus one second. Already-sent requests can finish. The pause survives restart and a late successful response cannot shorten it. Explicit 429 rejection is retried within bounded limits; timeouts and ambiguous write outcomes are never automatically replayed.

These are application safeguards, not a guarantee that 429s can never occur: Brightspace can change request costs and other clients can consume credits. Coordinate instances on the same database and OAuth registration; separate databases cannot share reservations. Do not run old serial-gate binaries concurrently with this version. MongoDB failure prevents new requests.

D2L documents the response headers and dynamic costs in [API rate limiting](https://docs.valence.desire2learn.com/basic/apicall.html#rate-limiting).

## Persistence and interruption

Execution saves only changed task paths plus small job metadata instead of rewriting thousands of rows on every response. Checkpoints are serialized within a job and retain worker/status guards. Copy/deployment checkpoint requests arriving together are combined during a 10 ms collection window; every caller waits for the combined database write before submitting its copy. Requests arriving during a write belong to the next batch. A failed batch rejects all waiting workers and poisons that job queue. Date jobs also use the 10 ms collection window, with immutable chunk snapshots captured before database writes. Final saves retain the complete cumulative report. Failed persistence stops scheduling; active workers drain before the lease is released. A systemic copy failure stops new submissions, but up to eight already in flight can still complete. Deployment groups similarly finish in-flight batches while stopping new groups/batches after their systemic-failure threshold.

Interrupted copy/deployment jobs retain checkpoints and saved tokens; they are not blindly resumed or resubmitted. An accepted request whose response could not be saved remains uncertain. Inspect Brightspace before creating a replacement job. Cancellation during Course Copy preparation stops further validation, with up to eight mappings finishing in flight; it cannot undo a submitted Brightspace copy.

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

The API gate initializes its Mongo document once per process. Short reservation attempts are serialized locally to reduce collisions; HTTP requests still overlap up to eight for code lookups and Course Copy submissions/checks and Source Deployer operations/checks, with other requests limited to four. A cached next-start time, cooldown or credit-window deadline returns a wait without querying MongoDB. All actual grants still pass the atomic Mongo filter. Permit contention uses 250–1,000 ms backoff, and a local completion clears that contention backoff. It never clears a global cooldown. Insufficient credits consider the next request's estimated cost, even when used credits are slightly below the ceiling.

### Check database latency and hosting regions

Run from the **Render shell**, where the application runs:

```sh
node scripts/mongodb-latency-report.js
```

This command performs eight read-only MongoDB pings and reports connection time plus minimum, median and maximum ping duration. It prints no connection URI, credentials, hostname, or database contents. Ping time is not the same as a durable write's latency; database load and write concern can also matter. Compare it with checkpoint timing after repeating the same small job.

Check the Render service region and Atlas cluster/primary region in their dashboards. Do not infer region from an opaque cluster hostname or ping measurement. Render currently lists Oregon, Ohio, Virginia, Frankfurt and Singapore in its [region documentation](https://render.com/docs/regions); AWS São Paulo is not a listed Render service region. If Atlas is in São Paulo, confirm the Render location before considering any migration. No hosting region or database configuration is changed by this update.

Deploy after current jobs finish, repeat the same 11-copy workload and inspect all three reports. Course Copy submissions and native checks now use eight workers; Source Deployer execution/checks also use eight; Date Manager execution remains at four. The regression suite verifies batching barriers, failure propagation, lease expiry, single initialization and no database polling during a known cooldown. Live latency and throughput must still be measured after deployment.

Source Deployer uses the shared lease reuse, gate waiting and checkpoint coalescing improvements. Activation retries now checkpoint only the affected task, and normal execution omits the redundant end-of-batch save after submission/activation results have already been persisted. Pre-write intent checkpoints, course-state verification, the 100-replica batch limit and sequential batches for each source remain intact. Test a small deployment separately: Course Copy timing does not predict deployment timing because deployment also prepares and reactivates replicas.

Date Manager performance update: course resolution is read-only and uses up to eight workers; directory lookup uses 500-code batches with at most four batches in flight. MongoDB-backed cancellation polling during planning is throttled to once per second; in-process cancellation remains immediate. Resolution makes no periodic saves while resolving CSV rows. After all courses are resolved and sorted, one durable save completes before activity discovery starts. Discovery uses up to eight independent courses; Assignments, Quizzes and Forums are read concurrently, and up to eight independent forum-topic reads are scheduled concurrently. Discovery checkpoints batch 500 progress increments; checkpoint coalescing, worker fencing, cancellation safety and the final durable plan save remain. Application still uses up to four independent courses, with activities within each course sequential. Planning previews reuse native objects returned by the collection APIs and issue no additional individual GET per activity. Mapping and activity previews must succeed before confirmation; apply retains its pre-write current-settings/stale-preview GET and post-write read-back GET. Repeated CSV identifiers are deduplicated; resolved aliases are processed once. Checkpoints snapshot immutable chunks before database I/O.

Date Manager discovery continues to use the native Assignment, Quiz, Discussion Forum and Topic collection APIs. Planning builds previews from returned native activity objects, avoiding an additional individual GET per activity. Apply still GETs each activity before PUT to validate saved preview dates and preserve current native settings, then GETs again for read-back verification. Only discovery collection routes use the eight-request allowance; unrelated ordinary traffic remains limited to four. Payload semantics, safety checks, rate limiting, persistence behavior and other workflows are unchanged.

Initial persistence for large date jobs retains chunked storage and batches content-addressed chunk upserts with MongoDB `bulkWrite()` calls of at most 500 operations. The main job document is published only after every required chunk batch succeeds. This reduces MongoDB round trips during the Step 1 → Step 2 transition, before course resolution or activity discovery starts. The 250,000-activity limit reserves capacity before parallel preview work. Existing stale-preview, unrelated-setting preservation, read-back verification, worker fencing and uncertain-write recovery remain enabled. No new environment variables are required. Measure a small date job separately with `node scripts/job-performance-report.js`; copy timings do not predict date-update duration. These changes do not remove cross-region MongoDB latency.

Date Manager resolves codes through the shared persistent directory, checks ID/code matches and uses IDs directly. Mapping makes no course-detail requests. Discovery and activity writes surface access errors; stale-date/read-back checks remain. Source Deployer uses the same persistent code directory; its execution-time activation safeguards are unchanged.

Step 2 exposes Cancel during course resolution and activity discovery/preview. The worker checks cancellation before scheduling further planning work, lets in-flight read-only requests drain, and checkpoints retained results with worker fencing. Cancelled plans cannot become ready or start date writes.

Date Manager CSV accepts an ID, a code, or both in `OrgUnitId,OrgUnitCode`. With both supplied, directory/live code resolution must match the supplied ID before activity discovery. Distinct pairs are validated before resolved-course deduplication, so a repeated ID with a different code cannot bypass matching. Mismatches appear in the report and block the date plan under the existing all-courses-valid requirement. IDs alone skip code resolution; pairs use the shared directory and per-job lookup cache. CSV headers are unchanged; dataset scheduling has optional settings documented in RESOLUTION.md.

Code resolution uses eight mapping workers in Course Copy, Source Deployer and Date Manager. GET orgstructure requests with a nonempty exactOrgUnitCode filter, Date Manager Assignment/Quiz/Forum/Topic collection reads, POST import/{id}/copy/ submissions, GET import/{id}/copy/{token} result checks, Source Deployer POST deploy and PUT course status calls, GET course/org-unit metadata and reofferedCourses, and GET ccb/logs qualify for the eight-request allowance. Other calls, including date updates, retain a four-request allowance; all classes together are capped at eight. Credit reservations, pacing, cooldowns and lease expiry remain shared and unchanged. No new environment variables are needed. Compare the same CSV before/after deployment using server-side timing reports; doubling workers does not guarantee twice the throughput.


## Shared directory and nightly dataset refresh

All three tools use the shared MongoDB org-code directory first, in 500-code batches with at most four lookup batches in flight. The directory stores only non-deleted Course Offerings and Source Courses. Because excluded types are not in the directory, a code without a live exact-code verification made after the latest publication uses the bounded exactOrgUnitCode API search; that exact result is reused until the next successful publication. Per-job promises deduplicate lookups. See [RESOLUTION.md](RESOLUTION.md) for setup, freshness, failure behavior and server-only commands.

Run `node scripts/sync-org-units.js` to initialize/refresh after granting the Service User dataset access, then `node scripts/org-unit-cache-report.js` to inspect freshness. Scheduled refresh defaults to 06:00 UTC. The OAuth scope is `datasets:bds:read`; no extra credentials or CSV changes are needed. The 8-worker resolution / 4-worker ordinary API limits remain unchanged. A failed import preserves the previous generation.


Directory sync downloads a full plus newer differentials for initial setup and whenever the directory representation version changes. Migration requires an authoritative full rebuild; available old extract ledgers are checked for continuity, and the previous published generation remains available if rebuilding fails. Later runs download only unprocessed differentials; deletes and type changes remove ineligible IDs from the staging generation. The extract ledger and directory publish together after success. Incremental runs copy only eligible directory documents to staging in bounded batches. Filtering reduces persistent documents and staging writes. One test-tenant inspection found a 62% reduction in logical data (8.04 MB to 3.06 MB, 26,393 to 10,023 records); actual savings vary by tenant. Fewer documents and index entries can ease Atlas M0 storage and I/O pressure, but do not imply a throughput guarantee. See [RESOLUTION.md](RESOLUTION.md) for continuity checks and operational details. No environment or CSV changes are required.

### Date Manager chunk retention and recovery

Immutable checkpoint updates can leave older content-addressed chunk documents after their job pointers move forward. This is expected for checkpoint safety; cleanup is an explicit Render Shell maintenance task, never a background process. Run `node scripts/cleanup-date-jobs.js` for a dry-run, `node scripts/cleanup-date-jobs.js --apply` to remove only unreferenced chunks, or `node scripts/cleanup-date-jobs.js --apply --all-date-jobs` to remove terminal Date Manager history and its chunks as well. The script is namespace-scoped, acquires the bulk worker lease, aborts if a bulk workflow is planning or running, holds the lease so queued work cannot start, and uses batches of at most 250 deletions. Queued, validating, ready/nonterminal jobs and all chunks owned by those resumable jobs, including unpublished chunks, remain protected. It reports logical JSON bytes, not physical Atlas storage reclamation.

Atlas Free Tier has limited storage and I/O headroom. Use the preview before applying cleanup and schedule it when no workflows are pending; bounded deletes limit each database operation but do not guarantee a specific storage reduction or runtime. Date Manager saves confirmed task outcomes and the task's write intent durably. On a persistence/lease interruption it stops scheduling writes; after lease recovery, saved in-flight tasks get read-only Brightspace reconciliation and eligible pending tasks resume. A PUT with an unconfirmed result is never replayed. Reconciliation confirms only when requested dates and the saved preview settings fingerprint match; missing or changed evidence remains uncertain. Step 3 progress reads persisted aggregate totals and refreshes on the existing 10-second interval without loading activity chunks.

Source Deployer now runs eight independent source groups and eight copy-log reads per dispatch (still at most ten replicas per dispatch). Batches for the same source stay sequential. Course and org-unit metadata endpoints share the eight-request allowance even when used by another tool; Date Manager discovery uses eight courses and execution uses four. All request classes together still have only eight permits, while unrelated ordinary API traffic remains limited to four. No new environment variables are required.


Mapping continues to trust the supplied org-unit type: Date Manager uses IDs directly or resolves codes through the filtered MongoDB directory and current exact-code API cache, then discovers activities. It no longer calls courses/{id}, sourceCourses/{id}/reofferedCourses or orgstructure/{id} for course-detail mapping, nor repeats course preflight before applying. Cached names are optional; ID-only rows may have blank names/codes in reports. Activity reads, preview completeness, stale-date checks and write read-back remain.

Source Deployer also removes source/replica preflight and the duplicate inactivity read before POST. setActive still reads full current course settings before PUT and verifies the result afterward, preserving unrelated fields. Invalid source IDs can now be rejected only after replica deactivation; those replicas may remain inactive and are identified in reports. No deployment is retried automatically. Fix the mapping and inspect replica state before another run.
