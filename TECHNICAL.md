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

One worker lease coordinates both workflows. Historical Source/replica reservations are no longer enforced; the worker lease still serializes app execution. The namespace and endpoints remain unchanged. The database is now configured as `brightspace_source_courses_tools`, without migration of old database records.

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
