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

One worker lease coordinates both workflows. Historical Source/replica reservations are no longer enforced; the worker lease still serializes app execution. The namespace and endpoints remain unchanged. The database is selected by the explicit MONGODB_URL path; `brightspace_source_courses_tools` remains a valid existing name. No old database records are migrated.

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

Pacing tuning: the shared gate now targets 30,000 measured credits/minute with a 10,000-credit reserve, adaptive reset-aware spacing and a conservative 250 ms fallback when costs are missing. At 10 credits, start-to-start spacing is 20 ms; response latency counts toward it. Requests remain serialized and ambiguous writes are never replayed. This reduces artificial delay, but does not guarantee job completion during outages or make interrupted deployments automatically resumable.

CSV templates: the date template downloads as `date-manager-template.csv`. Deployment accepts `SourceOrgUnitId,SourceOrgUnitCode,ReplicaOrgUnitId,ReplicaOrgUnitCode`; provide an ID, code, or matching pair for each side. Codes must resolve to exactly one accessible org unit, followed by source/replica type validation. Aliases are deduplicated after resolution; conflicting targets and source/target overlap block deployment. All four headers are required, even when code cells are empty. Legacy two-column CSV files are rejected; download the new template. Code lookup requires orgstructure read access.

## Native component copy: src/copy

`client.js` validates origins using the Course Offering endpoint; destinations use the same read with Source Course validation only after HTTP 404. Code resolution uses the existing exact-code resolver and rejects ambiguous matches. Minimum LE version is 1.97. `POST /d2l/api/le/{version}/import/{destinationId}/copy/` sends SourceOrgUnitId, Components (null for all or a validated nonempty allowlist), and CallbackUrl:null. No date offsets, reset, creation, or activation calls are sent. Success requires HTTP 202 and a nonempty JobToken. `GET .../copy/{jobToken}` recognizes PENDING, PROCESSING, COMPLETE, COMPLETE_WITH_ERRORS, FAILED, CANCELLED. Token URLs are encoded; metrics normalize them to `:token`.

`jobs.js` builds a read-only, deduplicated plan and stores component choices. The shared leased worker dispatches `courseCopy` planning/execution. Before each POST a durable uncertain checkpoint is written and the lease renewed. Only the existing rate-limited transport retries explicit 429; no ambiguous copy POST is replayed. Missing/invalid acceptance responses remain uncertain. A storage or lease failure stops the worker. Copy-job restarts preserve tokens but do not resume submission automatically.

`/copy/{preview,apply,status,cancel,history,report,checkCopies}` uses the shared session-bound HMAC tickets, deployment guard, owner hash and workflow-kind checks. Apply requires confirmCopy=yes, reads only the saved plan, and uses atomic ready→queued confirmation. `checkCopies` atomically queues operation=check only for eligible terminal local jobs with nonterminal tokens. It removes the preview expiry and never enters submission code. Concurrent check clicks cannot schedule duplicate work. Completed tokens are retained unchanged. Reads are on-demand, serial, rate-limited, and persisted per mapping. Native tokens and diagnostics appear in owner-scoped reports, not public URLs or API-cost metric keys.

The upload parser allows 100 bounded form parameters on /copy/preview for 35 component checkboxes and signed controls. Copy records share the application job collection/namespace and the existing 8 MB document guard; date chunk storage remains separate. The new tool appears first; date and source-deployment routes are unchanged.

Regression coverage: identifier/code validation, duplicate/conflict/chain rejection, origin/destination types, version gate, exact POST payload, non-replayed ambiguous failures, durable checkpoints, interrupted submissions, cumulative checks, terminal-status handling, report escaping, and workflow/session confirmation. Large-volume performance and actual component dependency behavior still require tenant acceptance testing; mocked tests do not guarantee production throughput.
