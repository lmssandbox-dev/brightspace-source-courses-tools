# Project guide

Brightspace Source Courses Tools is a Node.js LTI 1.3 application for Brightspace operators. It provides bulk activity-date updates, Source Course deployments, and native course copies. One service, LTI installation, and MongoDB database serve each tenant.

## Architecture map

- `index.js` is the composition root: configuration checks, LTI setup, API clients, feature wiring, routes, and background timers.
- `src/dates/` handles activity discovery, native settings normalization, date previews/writes, and date reports.
- `src/replication/` handles Source Course deployment, replica activation, copy-log checks, and reports.
- `src/copy/` handles native component-copy planning, submission, token checks, and reports.
- `src/shared/` contains OAuth/API transport, LTI guards, MongoDB job storage, worker/checkpoint coordination, rate limits, and common routes.
- `src/resolution/` provides the shared org-unit code directory and Brightspace dataset synchronization.
- `src/ui/` contains server-rendered page helpers, styles, localization catalogs, and browser enhancements. `scripts/build-ui.js` bundles ignored assets under `public/assets/`.
- `test/` contains Node built-in tests and API fixtures.

Start with `README.md` for user workflows. Consult `TECHNICAL.md` for implementation relationships, `ENVIRONMENT.md` for tenant configuration and permissions, `PERFORMANCE.md` for worker/rate-limit behavior, and `RESOLUTION.md` for org-unit directory operations. `PLAN.md` is a status record and may contain older or conflicting snapshots; verify current behavior in source and tests.

## Workflow model

All bulk workflows validate and save a plan, require explicit confirmation before writes, then persist progress for Job History and CSV reports. The shared worker coordinates job execution; each feature owns its plan and API behavior.

- Dates: resolve Course Offerings or Source Courses, discover Assignments/Quizzes/Discussion Topics, preview all changes, then apply and read dates back.
- Source deployment: validate source-to-replica mappings, deactivate and verify replicas, submit deployment batches, then reactivate accepted replicas. Copy-log checks are user-requested and separate from activation.
- Course copy: copy all or selected component types from an existing Course Offering to an existing Offering or Source Course; save native job tokens and check status on request.

Course Copy progress measures mapping validation and native copy request submissions separately. Keep `copyStep2*` and `copyStep3*` timing metadata independent, derive submissions from existing outcomes, and retain active elapsed time only through durable progress on recovery. Accepted native `PENDING`/`PROCESSING` submissions count as submitted; never present submission progress as native copy completion or change persisted result classifications for display.

Date Manager supports cancellation while Step 2 resolves course identifiers or discovers/previews activities, while Step 3 is queued, and while Step 3 is applying updates. Planning and queued cancellation retain their existing behavior. A running Step 3 cancellation persists a request marker, stops dispatching writes when observed, drains already-dispatched operations, and finalizes only after verified outcomes are saved. The worker lease and fencing remain active through finalization. Confirmed updates are never rolled back; never-started activities remain pending and appear as not attempted in the partial CSV. On restart, a pending cancellation is recovered without scheduling new writes; in-flight activities use read-only reconciliation and uncertain writes are never replayed. Cancellation does not abort Brightspace requests or release the lease early.

Date Manager chunk cleanup is an explicit administrative operation only. It must take the namespace worker lease, preserve every retained job reference, protect queued/resumable work, and never run as automatic background garbage collection.

Completed Date Manager status views render from one lightweight metadata read; `createBulkJobs` must forward `getStatus()` from the store or `/bulk/status` falls back to full-job reads. Do not load or decode course/activity chunks for the summary. CSV reports and ready previews still load the complete job when required. Step 3 status metadata includes active elapsed time and the latest durable progress timestamp; resumed jobs exclude downtime and the uncheckpointed interval after their last saved progress point from elapsed time and ETA calculations. `/bulk/status` diagnostics start at the earliest app hook before LTI session validation and log handler entry, authorization, `getStatus()`, rendering, response completion, and errors with monotonic durations. Logs use only a random trace token, status, phase, and small/large/unknown size category; never add request, user, job, or activity data.

Date Manager discovery uses up to eight independent courses. Assignment, Quiz, Forum, and independent Forum Topic collection reads use the eight-request API allowance under the shared global ceiling of eight; unrelated ordinary requests remain limited to four. The shared API gate permits at most two concurrent MongoDB reservation attempts per process while atomic database filters enforce cross-process limits. Discovery checkpoints batch 500 progress increments while retaining worker fencing, cancellation safety, and a final durable save before readiness. Step 3 uses a separate 25 ms checkpoint coalescing window; each write intent and verified outcome remains durable before the worker proceeds. Planning previews reuse collection-returned native activity data; apply retains the pre-write GET and post-write read-back.

Date Manager Step 2 status uses a worker-fenced metadata-only progress update about every five seconds. It must not write rows, courses, tasks or activity chunks and must not replace the resolution-boundary save or 500-increment discovery checkpoints. Step 2 timing is separate from Step 3; recovery excludes downtime and work after the last durable progress point. Keep the ten-second status refresh and calculate one overall planning ETA from metadata only; resolution shows “Calculating ETA…” unless a reliable discovery baseline already exists.

Step 2 discovery utilization lives in `src/shared/step2Utilization.js`; it uses a separate async context from Step 3 and persists bounded snapshots through existing metadata updates/checkpoints. Use `node scripts/date-step2-utilization-report.js [job-id]` for the admin-only metadata report. Interpret API waits as overlapping request sums; discovery permits are job-attributed, not global occupancy, and pending work without HTTP does not prove global capacity is available.

Use `node scripts/api-gate-state-report.js` for a one-shot read-only snapshot of current shared API-gate state and stored discovery-route costs. It reads the tenant gate document only; snapshots do not establish historical gate conditions or available Brightspace capacity.

Source Deployer Step 3 utilization is saved on existing durable checkpoints in bounded `performance.deploymentStep3Utilization` metadata and is excluded from user-facing pages and CSV reports. It records build SHA from `RENDER_GIT_COMMIT` only when that value is a valid commit SHA; otherwise it stores `unknown`. Use `node scripts/deployment-step3-utilization-report.js [job-id]` for the administrator-only report. Elapsed time ends when the latest telemetry checkpoint begins its physical save. Treat operation and API wait durations as overlapping sums; API permit acquisition includes its component waits. Queue-wait union and time-weighted concurrency are wall-time measurements. Persistence duration covers completed saves before the most recent telemetry checkpoint because a save cannot durably include its own completion time.

## Conventions and safety constraints

- Follow the existing dependency-injected feature-factory pattern and wire shared clients/services in `index.js`.
- Keep tenant API calls behind the shared guarded, rate-limited transport. Preserve bounded pagination and worker limits.
- Bulk forms and job actions must retain LTI session, owner, signed-ticket, expiry, and workflow-kind checks. Keep writes behind saved-plan confirmation.
- Preserve native Brightspace settings when updating dates or course active state; retain read-back verification and stale-preview checks.
- Never automatically repeat a write with an uncertain outcome. Timeouts, process restarts, or lost responses can occur after Brightspace accepted a request; keep the saved result inspectable and require reconciliation.
- Deployment preparation can leave replicas inactive if it fails. Surface per-replica outcomes and do not add rollback or resubmission assumptions casually. Activation does not establish that copying has completed.
- Treat org-unit code cache hits as snapshots, not live identity checks. Do not resolve ambiguous codes by choosing the first match.
- The shared org-unit directory stores only non-deleted Course Offerings and Source Courses. Because excluded types may share a code, directory-only matches require current live exact-code verification before resolution; successful verification can be reused until directory publication.
- Escape rendered HTML and spreadsheet CSV values; sanitize API diagnostics and never expose credentials or raw request configuration.
- Visible UI text belongs in all three catalogs under `src/ui/locales/` (English, Latin American Spanish, Brazilian Portuguese). Keep catalog keys/placeholders aligned.
- Do not casually change Brightspace API payloads, minimum API versions, job persistence/checkpoint semantics, tenant/database namespacing, scopes, or retry behavior; inspect the related tests and subsystem docs first.
- Preserve phase-specific persistence semantics: persist read-only resolution at its phase boundary before dependent discovery; discovery plans and write outcomes require durable checkpointing. Keep large MongoDB chunk writes batched rather than issuing high-volume sequential round trips.

## Development checks

- Use Node.js 22. Install with `npm ci`.
- Run `npm test` and `npm run check` for source changes. Run `npm run build` after UI changes; `npm start` also builds assets through `prestart`.
- `npm run activity:dates -- ...` is a preview-first single-activity diagnostic CLI; `npm run verify:discovery` runs discovery verification. Bulk changes should be exercised through saved-job workflows.
- Do not commit `.env`, private keys, `node_modules/`, or generated `public/assets/` bundles. Configure tenant-specific LTI/OAuth credentials and scopes using `.env.example` and `ENVIRONMENT.md`.
