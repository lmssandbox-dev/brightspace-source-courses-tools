# Bulk processing performance and safety

## Preparation

Course Copy offers two modes without changing its four-column CSV template:

- **Direct submission** is selected on new forms. ID-only rows make no Brightspace validation requests. Codes still resolve to unique IDs; matching ID/code pairs must agree. It skips additional type/access checks and lets the copy API reject unsupported or inaccessible courses at submission. The report records these failures. Course names can be blank for ID-only rows. This mode does not create missing courses or enable Source Courses as origins.
- **Verify courses before copying** checks org-unit metadata and supported course types before confirmation. Unknown types retain authoritative checks. Existing saved jobs and requests without a mode retain verified behavior.

Both modes enforce the CSV schema, identifier format, 10,000-row/5 MB limits, self-copy prevention, duplicate suppression, conflicting destination rejection and origin/destination overlap rejection. Local errors and unresolved/ambiguous codes block confirmation. Neither mode submits anything until the user confirms. Components and resolved mappings are saved in the confirmed job.

Course Copy resolves at most four mappings concurrently. Repeated codes share one lookup promise. For at least 250 distinct codes, it first attempts a complete directory scan capped at 100 pages / 50,000 records and at most one page per four requested codes; incomplete scans are discarded and exact lookup is used. A scan can cost extra requests on a large tenant. There is no cross-job cache of potentially stale course permissions or codes.

Source Deployer also resolves at most four mappings concurrently and caches codes, source validation and replica metadata within the preview. Conflict detection and source grouping run in CSV order after resolution. Planning saves progress every 25 processed mappings. It retains authoritative source/replica checks and revalidates each batch before changing replica state; direct mode applies only to Course Copy.

## Submission and checking

Course Copy has up to four submission workers. Each saves an uncertain-intent checkpoint **before** its POST, then saves the returned token/result. Workers queue copies without waiting for Brightspace to finish copying. On-demand native status checks use up to four workers and skip terminal tokens.

Source Deployer runs up to four independent source groups concurrently. Batches for the **same source** remain sequential and contain at most 100 replicas. Every batch preserves this sequence: validate, deactivate and verify replicas, submit deployment, reactivate accepted replicas and verify active state. Rejected and uncertain replicas are never automatically activated. Deployment copy-log monitoring checks up to 10 replicas per dispatch with four concurrent reads and keeps previously confirmed successes.

One primary job still holds the application worker lease. Date Manager execution is still sequential. The API ceiling below covers all these workflows and concurrent monitor traffic together.

## Shared API budget

The Mongo gate is keyed by tenant origin and OAuth client ID. It admits at most four requests concurrently, reserves credits before sending, and targets 30,000 credits per local 60-second window. It uses the highest measured cost per normalized route, with 125 credits / 250 ms spacing when cost is unknown. Missing cost headers restore that conservative reservation without reporting it as a measured cost. At a known cost of 10 credits, minimum start spacing is 20 ms. Costs above the entire local budget stop requests for review.

Responses adjust spacing to remaining credits/reset time. A remaining balance at or below 10,000 credits (or the last request cost, if higher) pauses new requests. HTTP 429 pauses all workers for at least 60 seconds or the longer server reset/Retry-After, plus one second. Already-sent requests can finish. The pause survives restart and a late successful response cannot shorten it. Explicit 429 rejection is retried within bounded limits; timeouts and ambiguous write outcomes are never automatically replayed.

These are application safeguards, not a guarantee that 429s can never occur: Brightspace can change request costs and other clients can consume credits. Coordinate instances on the same database and OAuth registration; separate databases cannot share reservations. Do not run old serial-gate binaries concurrently with this version. MongoDB failure prevents new requests.

D2L documents the response headers and dynamic costs in [API rate limiting](https://docs.valence.desire2learn.com/basic/apicall.html#rate-limiting).

## Persistence and interruption

Execution saves only changed task paths plus small job metadata instead of rewriting thousands of rows on every response. Checkpoints are serialized within a job and retain worker/status guards. Final saves retain the complete cumulative report. Failed persistence stops scheduling; active workers drain before the lease is released. A systemic copy failure stops new submissions, but up to four already in flight can still complete. Deployment groups similarly finish in-flight batches while stopping new groups/batches after their systemic-failure threshold.

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

The job report shows the latest 20 jobs for this deployment with preparation, submission and native-check durations, checkpoint count and checkpoint duration. Unfinished/interrupted phases have no finished duration. Checkpoint aggregates exclude the final save's own duration. Source Deployer's separate copy-log monitor does not currently publish a job phase duration. Submission duration measures app submission/preparation/activation work, **not** Brightspace's later copy completion time. These reports contain job IDs, never credentials or course content.

Compare equivalent jobs with the same mapping count, identifier mode and components. First verify content/status on a small job, then increase volume. Local regression tests include 5,000-row direct preparation and submission, repeated lookups, batch ordering, concurrent failure handling, targeted persistence and a deterministic model of the actual Mongo reservation expressions. They do not replace a live MongoDB/Render/Brightspace performance test or establish a completion-time promise.
