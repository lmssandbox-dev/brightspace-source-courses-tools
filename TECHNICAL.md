# Brightspace Source Courses Tools — Implementation

## Date feature: src/dates

activities contains native readers and normalizers. activityDiscovery combines supported activities. activityWriters maps native reads into safe update payloads for Assignments, Quizzes and Discussion Topics, preserves availability semantics/settings, writes once and reads back. Incomplete required settings block updates; uncertain transport outcomes are reconciled through read-back rather than blind PUT retries.

courseCsv parses and validates the input. activityDates provides single-activity preview/apply; discoveryDiagnostics provides read-only inspection. Existing route URLs are retained.

## Replication feature: src/replication

client validates actual Source Courses and replica offerings, updates course active state while preserving supported fields, and submits native LP sourceCourses/{sourceId}/deploy requests. Version-specific payload fields are checked. Read-back verifies status and preserved settings.

jobs parses mapping CSVs, performs read-only validation, prepares replicas, submits batches of at most 100 replicas per source, and automatically reactivates accepted replicas. Uploads support 10,000 mappings / 5 MB. view renders mapping validation, saved results, confirmation forms and CSV reports.

A deployment ID confirms initiation, not copy completion. Unexpected or lost responses remain uncertain and are never resubmitted automatically. No copy-job-token inference is used. Activation follows acceptance and can occur while copying is queued or running. Failed and uncertain submissions are excluded from automatic activation. Copy logs are checked only when requested, and do not prove completion merely because activation succeeded.

## Shared infrastructure: src/shared

- auth.js: Private Key JWT token exchange and OAuth public keys.
- client.js: guarded API transport, pagination, native PUT transport and scope matching.
- id.js, courses.js, deploymentGuard.js: identities, course/source lookup and LTI launch-deployment restriction.
- database.js: dedicated database validation.
- jobs.js: common job lifecycle, date planning/execution and delegation to replication jobs.
- store.js: existing bulk_date_jobs, bulk_date_chunks and bulk_date_locks collections, ownership, confirmations and leases.
- routes.js: shared signed workflow actions, date bulk forms and delegation to the replication view.

One worker lease coordinates the three workflows. Historical Source/replica reservations are no longer enforced; the worker lease still allows only one primary job at a time, with bounded parallel work inside copy/deployment jobs. The namespace and endpoints remain unchanged. The database is selected by the explicit MONGODB_URL path; `brightspace_source_courses_tools` remains a valid existing name. No old database records are migrated.

Forms bind action, workflow, job, expiry and LTI session. Ownership is checked before access. Atomic confirmations prevent duplicate queueing. Saves are fenced by worker and running state. Interrupted work is retained for inspection. Activation retries preserve deployment results and reconcile current active states without redeploying. The activation action removes preview expiry and records the reactivation request.

HTML is escaped and CSV cells neutralize spreadsheet formula injection. API credentials are not returned in diagnostic output. Brightspace LTI installation governs user access; API permissions are those of the Service User.

The application does not enforce historical course reservations. Users can start another deployment; this may reset replicas while earlier copies are still queued or running.

## Browser presentation

src/ui/page.js renders the shared shell and presentation helpers. src/ui/install.js serves only the two public bundled assets and wraps HTML responses while leaving CSV/JSON intact. src/ui/app.mjs imports the D2L web components and enhances native submit buttons; the original buttons retain submitter values and browser validation. Signed POST fields remain on the same forms. File inputs populate bounded CSV textareas; required empty fields are revealed before validation. Native controls remain usable if the enhancement bundle fails.

Date presentation lives in src/dates/view.js and replication presentation in src/replication/view.js. The shared route controller retains authorization, ownership, expiry and atomic-confirmation behavior. The workspace route only renders forms and uses the existing LTI guard. No writer, database or OAuth protocol changes are introduced by the interface.

Esbuild bundles the browser module and styles into public/assets/app.js and app.css. D2L dependencies are pinned in the lockfile. Asset routes contain no session data. Local browser checks cover navigation, responsive layout, file loading, required confirmations and submit behavior with fixture-only jobs.

## Time zones and navigation

The sidebar switches between date management, deployment and history while preserving entered form values. `src/dates/timeZone.js` validates named time zones and converts local inputs to UTC, rejecting nonexistent and ambiguous local times. Date jobs retain the selected zone for reviews and results; reports keep UTC date columns and include the selected zone. Existing jobs without a saved zone default to America/Sao_Paulo.

Deployment execution now reactivates accepted replicas automatically per batch. `src/replication/monitor.js` processes explicit on-demand copy-check requests with bounded reads, fenced leases, durable progress, and no recurring polling. It recognizes only the tenant-observed full-copy success message with matching source/target IDs, a single copy-job ID, and no additional log page; other text remains unconfirmed. It does not block new deployments. See README for matching and API-version limitations.


Deployment presentation uses one four-counter row and a summary. Copy-check progress is inline, with a hidden signed status form for automatic refresh on conclusion pages. No dialog or per-replica HTML table is generated. History exposes only View job; its MongoDB projection computes total/copied counts without returning copy-log bodies, and routes select Copies in process / Copies concluded for submitted or activated jobs. Error/cancelled statuses are preserved. See README for exact labels and the limitations of message-based completion recognition.

## Localization

`src/ui/locales/en.json`, `es-419.json`, and `pt-BR.json` contain matching catalogs keyed by English UI text. Dynamic messages use numbered `{0}` placeholders; preserve the same placeholders in each translation. `src/ui/i18n.js` handles exact strings and full-string patterns, normalizes the supported locale allowlist, and translates only CSV report headings. Unknown strings fall back to their original text.

`src/ui/language.mjs` translates text nodes and accessible labels after UI enhancement without replacing form elements. Original English strings are retained in WeakMaps so repeated language switches remain reversible. The header selector stores `brightspace-tools-language` in localStorage and propagates `uiLanguage` through hidden form inputs, including refresh and report forms. When browser storage is unavailable, the submitted locale carries the preference between rendered pages. No locale is stored on the job or inferred from the tenant. Native browser controls follow browser settings.

When changing visible wording, update all three catalogs and run `npm test` and `npm run build`. Localization tests cover catalog parity, placeholders, dynamic counts, unsupported locales, and preservation of CSV body data. User content and raw Brightspace diagnostics are not machine translated.

Copy-check optimization: new manual checks query only submitted or uncertain replicas without saved successful-copy confirmation. Confirmed results and CSV evidence are retained per job. Each run snapshots its pending replica IDs and checks batches of 10, keeping progress stable as results arrive. Already queued legacy checks finish their original scan; new deployment jobs have independent results. When nothing remains to check, no API work is queued.

Each independently deployed tenant can now select a dedicated database through the existing MONGODB_URL path. Both LTI storage and job storage use that URI. Explicit application names are required; system names, missing names, and dbName query overrides are rejected. Existing connection strings remain valid. Database creation occurs on first write, subject to MongoDB permissions. This does not migrate data or change any live Render configuration.

Environment setup is documented in [ENVIRONMENT.md](ENVIRONMENT.md), with all 17 variables, their sources/defaults, key generation, LTI versus OAuth key URLs, database isolation, scopes, and installation troubleshooting. Use [.env.example](.env.example) as the placeholder-only server configuration template.

API rate safeguards and actual-cost reporting are described in ENVIRONMENT.md under “API pacing and measured costs”. The shared durable gate covers server tenant API traffic. Use `node scripts/api-cost-report.js` after a representative live test; no live measurements have been collected by local tests. Full-scale production capacity and interrupted deployment recovery remain operational validation items.

Pacing tuning: the shared gate now targets 30,000 measured credits/minute with a 10,000-credit reserve, adaptive reset-aware spacing and a conservative 250 ms fallback when costs are missing. At 10 credits, start-to-start spacing is 20 ms; response latency counts toward it. Up to eight exact-code lookups, Course Copy submissions, native copy-result checks or Source Deployer operations/checks may overlap, while other requests remain capped at four and total active requests at eight, under the same durable budget; ambiguous writes are never replayed. This reduces artificial delay, but does not guarantee job completion during outages or make interrupted deployments automatically resumable.

CSV templates: the date template downloads as `date-manager-template.csv`. Deployment accepts `SourceOrgUnitId,SourceOrgUnitCode,ReplicaOrgUnitId,ReplicaOrgUnitCode`; provide an ID, code, or matching pair for each side. Codes must resolve to exactly one non-deleted directory match or live API match. Source/replica type/access validation remains an execution-time safeguard. Aliases are deduplicated after resolution; conflicting targets and source/target overlap block deployment. All four headers are required, even when code cells are empty. Legacy two-column CSV files are rejected; download the new template. Code lookup requires orgstructure read access.

## Native component copy: src/copy

`src/resolution` provides the shared MongoDB directory, staged dataset imports and live exact-code fallback. The copy resolver also deduplicates lookups within each validation job. Course Copy preparation always bypasses ID lookups and type validation, resolving only codes and matching supplied ID/code pairs. The old validation-mode form parameter does not enable extra checks. Ambiguous exact codes are rejected. Minimum LE version is 1.97. `POST /d2l/api/le/{version}/import/{destinationId}/copy/` sends SourceOrgUnitId, Components (null for all or a validated nonempty allowlist), and CallbackUrl:null. No date offsets, reset, creation, or activation calls are sent. Success requires HTTP 202 and a nonempty JobToken. `GET .../copy/{jobToken}` recognizes PENDING, PROCESSING, COMPLETE, COMPLETE_WITH_ERRORS, FAILED, CANCELLED. Token URLs are encoded; metrics normalize them to `:token`.

`jobs.js` builds a read-only, deduplicated plan and stores component choices. The shared leased worker dispatches `courseCopy` planning/execution. Before each POST a durable uncertain checkpoint is written and the lease renewed. Only the existing rate-limited transport retries explicit 429; no ambiguous copy POST is replayed. Missing/invalid acceptance responses remain uncertain. A storage or lease failure stops the worker. Copy-job restarts preserve tokens but do not resume submission automatically.

`/copy/{preview,apply,status,cancel,history,report,checkCopies}` uses the shared session-bound HMAC tickets, deployment guard, owner hash and workflow-kind checks. Apply requires confirmCopy=yes, reads only the saved plan, and uses atomic ready→queued confirmation. `checkCopies` atomically queues operation=check only for eligible terminal local jobs with nonterminal tokens. It removes the preview expiry and never enters submission code. Concurrent check clicks cannot schedule duplicate work. Completed tokens are retained unchanged. Reads are on-demand, bounded to eight concurrent requests, rate-limited, and persisted per mapping. Native tokens and diagnostics appear in owner-scoped reports, not public URLs or API-cost metric keys.

The upload parser allows 100 bounded form parameters on /copy/preview for 35 component checkboxes and signed controls. Copy records share the application job collection/namespace and the existing 8 MB document guard; date chunk storage remains separate. The new tool appears first; date and source-deployment routes are unchanged.

Regression coverage: identifier/code validation, duplicate/conflict/chain rejection, origin/destination types, version gate, exact POST payload, non-replayed ambiguous failures, durable checkpoints, interrupted submissions, cumulative checks, terminal-status handling, report escaping, and workflow/session confirmation. Large-volume performance and actual component dependency behavior still require tenant acceptance testing; mocked tests do not guarantee production throughput.

Copy result banners use the deployment confirmation styles: green for accepted submissions without issues and fully confirmed success, amber for validation/copy/uncertain outcomes, and neutral for cancellation. Submitted copies remain explicitly unconfirmed until their native token reports COMPLETE. The Job History card includes the tool label, description, and owner-scoped job link.

## Copy validation performance

All three tools use the shared MongoDB org-code directory first, in 500-code batches. Missing codes use bounded exactOrgUnitCode API searches and are saved for future jobs. Per-job promises deduplicate concurrent misses. The nightly Organizational Units dataset import refreshes the directory; known matches reflect the saved snapshot, not a live permission/code check. See [RESOLUTION.md](RESOLUTION.md) for setup, freshness, failure behavior and server-only commands.

Course Copy caches repeated codes within a single job. ID-only rows make no lookup requests. Matching ID/code pairs, self-copy, conflicting mappings and ambiguity checks remain local preparation requirements; course type/access errors are deferred to submission. Date Manager retains course-type validation because it must discover and safely edit activities.

Validation cancellation is checked before mappings and resolution requests/pages; cancellation aborts further lookup requests. The shared rate limiter remains in force. UI progress distinguishes mapping validation, copy submission and status checking. Mapping progress is saved every 25 processed rows, including duplicates. Confirmation is still required; submission and checks now use bounded parallel workers. Existing running processes require a new deployment to use this resolver.

## Bounded bulk processing

See [PERFORMANCE.md](PERFORMANCE.md) for automatic ID/code mapping in both copy tools, parallel source-group deployment, targeted checkpoints, shared credit reservations, failure behavior, and the server-only timing commands. No new environment variables are required. Local tests cover simulated 5,000-row work; Render/Brightspace throughput remains to be measured after deployment.

Implementation: `src/shared/concurrentGate.js` provides eight Mongo-backed API permits, with at most four held by requests other than exact-code GET lookups, Course Copy submissions/result checks and Source Deployer operations/checks (45-second leases; HTTP timeout at most 30 seconds), start spacing, route-cost reservations and cooldowns. `src/shared/pool.js` drains active workers before propagating an error. `src/shared/jobs.js` serializes checkpoints per job; `src/shared/store.js` snapshots only dirty task paths for copy/deployment execution. Source batches sharing a source run sequentially; at most eight independent source groups overlap. Date discovery and execution use up to four independent courses, with activities sequential within a course. Completed phase durations and aggregate checkpoint durations are saved in `performance`; they are excluded from UI and CSV exports.

### Database round-trip optimization

Concurrent copy/deployment checkpoints now share a durable write when ready together; no copy is sent before its checkpoint succeeds. Lease renewals are deduplicated and reused briefly within the valid lease, while the heartbeat and worker/status fencing remain. The API gate initializes once and waits on known spacing/reset/budget deadlines without repeated database polling. Course Copy submissions and native result checks use eight workers; Source Deployer execution/checks also use eight; Date Manager discovery/updates retain four. The job report distinguishes checkpoint requests from physical saves. Run `node scripts/mongodb-latency-report.js` in Render for a read-only connection/ping report; credentials and hostnames are never printed. See [PERFORMANCE.md](PERFORMANCE.md) for behavior, tests, region checks and the repeat-test procedure. No new environment variables or infrastructure changes are required.

Source Deployer uses the shared lease reuse, gate waiting and checkpoint coalescing improvements. Activation retries now checkpoint only the affected task, and normal execution omits the redundant end-of-batch save after submission/activation results have already been persisted. Pre-write intent checkpoints, course-state verification, the 100-replica batch limit and sequential batches for each source remain intact. Test a small deployment separately: Course Copy timing does not predict deployment timing because deployment also prepares and reactivates replicas.

Date Manager performance update: course resolution uses up to eight workers; discovery/preview, accessibility revalidation and application use up to four independent courses. Activities within a course remain sequential. All courses must pass revalidation before any write. Repeated CSV identifiers are deduplicated; resolved aliases are processed once. Checkpoints coalesce for 10 ms and snapshot immutable chunks before database I/O. The 250,000-activity limit reserves capacity before parallel preview work. Existing stale-preview, unrelated-setting preservation, read-back verification, worker fencing and uncertain-write recovery remain enabled. No new environment variables are required. Measure a small date job separately with `node scripts/job-performance-report.js`; copy timings do not predict date-update duration. These changes do not remove cross-region MongoDB latency.

Date Manager uses the shared persistent code directory plus a per-planning-run cache for current course reads. ID/code aliases share the course-read promise; each new planning run revalidates those details. Date execution revalidates access separately and preserves stale-date/read-back checks. Source Deployer uses the same persistent code directory; its execution-time activation safeguards are unchanged.

Date Manager CSV accepts an ID, a code, or both in `OrgUnitId,OrgUnitCode`. With both supplied, directory/live code resolution must match the supplied ID before activity discovery. Distinct pairs are validated before resolved-course deduplication, so a repeated ID with a different code cannot bypass matching. Mismatches appear in the report and block the date plan under the existing all-courses-valid requirement. IDs alone skip code resolution; pairs use the shared directory and per-job lookup cache. CSV headers are unchanged; dataset scheduling has optional settings documented in RESOLUTION.md.

Code resolution uses eight mapping workers in Course Copy, Source Deployer and Date Manager. GET orgstructure requests with a nonempty exactOrgUnitCode filter, POST import/{id}/copy/ submissions, GET import/{id}/copy/{token} result checks, Source Deployer POST deploy and PUT course status calls, GET course/org-unit metadata and reofferedCourses, and GET ccb/logs qualify for the eight-request allowance. Other calls (including activity discovery and date updates) share a four-request allowance; all classes together are capped at eight. Credit reservations, pacing, cooldowns and lease expiry remain shared and unchanged. No new environment variables are needed. Compare the same CSV before/after deployment using server-side timing reports; doubling workers does not guarantee twice the throughput.


## Shared directory and nightly dataset refresh

All three tools use the shared MongoDB org-code directory first, in 500-code batches. Missing codes use bounded exactOrgUnitCode API searches and are saved for future jobs. Per-job promises deduplicate concurrent misses. The nightly Organizational Units dataset import refreshes the directory; known matches reflect the saved snapshot, not a live permission/code check. See [RESOLUTION.md](RESOLUTION.md) for setup, freshness, failure behavior and server-only commands.

Run `node scripts/sync-org-units.js` to initialize/refresh after granting the Service User dataset access, then `node scripts/org-unit-cache-report.js` to inspect freshness. Scheduled refresh defaults to 06:00 UTC. The OAuth scope is `datasets:bds:read`; no extra credentials or CSV changes are needed. The 8-worker resolution / 4-worker ordinary API limits remain unchanged. A failed import preserves the previous generation.


Directory sync now downloads a full plus newer differentials for initial setup (and once when upgrading a legacy cache). Later runs download only unprocessed differentials; a newer full rebuilds the baseline. There is no fixed 36-hour interval assumption. The extract ledger and directory publish together after success. Incremental runs use a bounded local MongoDB staging copy for atomic publication, so they reduce API downloads but still require staging storage and database I/O. See [RESOLUTION.md](RESOLUTION.md) for continuity checks and operational details. No environment or CSV changes are required.
