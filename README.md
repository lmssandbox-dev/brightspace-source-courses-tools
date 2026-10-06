# Brightspace Source Courses Tools

A toolkit for managing Brightspace Source Courses, offering Bulk Course Copy, Bulk Activity Dates Manager and Bulk Source Courses Deployer. One LTI application with three workflow sections, deployed to one Render service. The existing LTI installation, OAuth configuration, MongoDB database and local `.env` are retained.

## 1. Activity dates

Upload a UTF-8 CSV with headers `OrgUnitId,OrgUnitCode`. Supply exactly one ID or code per row; keep both columns in the header. The app accepts Course Offerings and actual Source Courses.

Choose a time zone (Brasília by default), then enter Start, Due and End. The selected zone is saved with the job; skipped or repeated local times around clock changes are rejected. Start must be before Due; Due must be on or before End. 2. Review Updates resolves every course and discovers Assignments, Quizzes and Discussion Topics, including undated activities, without changes. Apply writes the saved plan, reads dates back and records per-activity results. Return through Job History or download the CSV report.

Limits: 10,000 CSV data rows, 5 MB of UTF-8 CSV, 250,000 activities per date job. Duplicates are processed once. Invalid rows or incomplete discovery block the plan. Previews must be confirmed within 30 minutes; confirmed jobs can finish or resume after that window. Changed dates are rejected unless already equal to the requested dates. Availability modes and unrelated activity settings are preserved.

Read-only discovery and the single-activity preview/apply form remain available for troubleshooting. All three activity writers and the CSV date workflow have been validated live by the user.

## 2. Source Course replication

Upload a second CSV with all four headers `SourceOrgUnitId,SourceOrgUnitCode,ReplicaOrgUnitId,ReplicaOrgUnitCode`. Each source and replica requires an ID or code; if both are supplied they must match. Leave unused cells empty. The old two-column format is rejected. Repeat the source ID for multiple replicas. Sources must be actual Source Course org units; replicas must already exist as Course Offerings. Replicas may initially be active or inactive.

1. Validate deployment mappings performs reads only and saves a plan.
2. Confirm Prepare and deploy. Each batch is validated, deactivated and read back immediately before its deployment is submitted. Other batches remain untouched until their turn. Brightspace resets the target content as part of deployment. Submission IDs and results are saved.
3. Accepted replicas are automatically reactivated and read back. Copy-log monitoring runs separately; Job History retains submission, activation, and monitoring results. Activation does not prove copying finished.

Limit: 10,000 rows / 5 MB. Each source is split into batches of at most 100 replicas per deployment request. Duplicate mappings are processed once. Conflicting sources for a replica, self-deployment and source/replica overlap block the preview. If preparation fails, already-deactivated replicas remain inactive with saved results. Inspect them before restoring service; there is no automatic rollback. Activation retry checks current state and does not redeploy.

Finish source date changes before replication. Saved deployment history does not reserve courses or block new jobs. The user confirmed live Source Course deployment after enabling the linked Service User’s course-copy permissions. User-provided reports and screenshots also confirm automatic reactivation and on-demand copy checks for two replicas; large-scale and restart validation remain outstanding.

## Project layout

```text
index.js                 One app entry point
src/
  dates/                 Activity readers, normalization, discovery and date writer
    activities/          Assignments, Quizzes, Discussions and normalizers
  replication/           Source validation, deployment, activation and its view
  shared/                LTI/OAuth helpers, API transport, database and job infrastructure
  ui/                    D2L components, responsive styles and shared page layout
scripts/                 Local discovery and single-activity CLI tools
test/                    Automated tests and JSON fixtures
```

The folders separate features, not deployments. Both features share one Render service, database and LTI installation per Brightspace tenant. A separate prospect tenant uses a separate service and tenant-specific configuration. Keep `test/`, package.json and package-lock.json. README describes operation; TECHNICAL describes implementation; PLAN records remaining work.

## Configuration and deployment

Use Node.js 22. Run `npm ci`, `npm test`, `npm run check`, then `npm start`. Upload the entire current project source to the existing Render service. Do not upload `.env`, private keys, `.local-tools` or node_modules. Do not overlay only selected renamed files: use this complete source layout.

The existing `.env` is unchanged; no MONGODB_URL entry was found locally. For new environments use `.env.example`. MONGODB_URL must explicitly name an application database; `brightspace_source_courses_tools` remains valid. Keep LTI_KEY and the OAuth signing key/key ID stable across restarts. BS_CLIENT_ID and BS_DEPLOYMENT_ID must match the existing Brightspace installation. LTI controls who launches the app; API requests use the configured Service User's permissions through Client Credentials with Private Key JWT.

Existing endpoints stay the same: `/login` for OIDC login, `/` for target link, `/keys` for LTI public keys, `/.well-known/brightspace-jwks.json` for OAuth public keys, and `/ping` for health checks. No public endpoint writes Brightspace data.

D2L_LE_VERSION must be supported (at least 1.90). Source replication needs D2L_LP_VERSION=1.53 or later. Date writes need `dropbox:folders:write`, `quizzing:quizzes:write` and `discussions:topics:manage`; replication needs `manageCourses:deploy:manage` and `orgunits:course:update`, alongside the required read scopes and Service User permissions. Matching resource/action wildcards are supported. LP 1.54+ also requires locale/address-book fields in course read responses for safe status updates.

## Local diagnostic CLI

`npm run activity:dates -- <assignment|quiz|discussionTopic> <courseId> <activityId> <startISO> <dueISO> <endISO> [forumId] [--apply]`

Preview is the default; Discussion Topics require the forum ID. The CLI uses the same writers and OAuth configuration, without an LTI launch or MongoDB. `npm run verify:discovery` runs the discovery verification script. These are development tools; use the saved-job UI for bulk work.

## D2L interface

The workspace has a left sidebar for Bulk Activity Dates Manager, Bulk Source Courses Deployer and Job History. It uses `@brightspace-ui/core` buttons, alerts and loading indicators. Native date inputs use the selected time zone. CSV templates and compact aggregate results are included; per-replica details remain in CSV reports. Development tools, the Workspace header button, and the footer are omitted. Deployment submission never implies copy completion.

`npm ci` builds frontend assets automatically through postinstall. `npm start` also builds them before starting the server. For manual builds use `npm run build`. Render may continue using the existing service; no separate frontend hosting or database is needed. Commit package.json, package-lock.json, src/ui, the updated source and scripts/build-ui.js. Generated public/assets files are ignored by Git and rebuilt during deployment. Browser assets are served locally; no CDN is required.

The frontend was checked locally with synthetic jobs and no Brightspace writes. Verify it through a real LTI launch after deployment, including the LMS frame size and platform browser restrictions.

### Large date jobs

Date-job records use immutable chunks in `bulk_date_chunks`, publishing checkpoint references only after chunks are stored. Planning checkpoints every 50 work items; execution saves before and after each activity. A restarted worker resumes resolution/discovery and skips saved results. An in-flight write is flagged as uncertain, never automatically repeated. Systemic API failures still stop writes. Replication supports 10,000 mappings / 5 MB; interrupted submissions remain available for inspection and are not automatically resubmitted.

Date-job screens show compact summaries; the CSV report includes all records. Processing remains sequential to bound API traffic. The complete job is loaded into worker memory, so size the server for the activity ceiling; chunking removes the single MongoDB document limit but is not a streaming worker. Historical immutable chunks are retained and need a retention policy before sustained high-volume production use. Large jobs have been tested locally with synthetic data, not at 10,000-course scale against a live Brightspace tenant.

## Application identity

Display name: **Brightspace Source Courses Tools**. Package name: `brightspace-source-courses-tools`. Project folder: `Brightspace Source Courses Tools`. The date and deployment tools retain their feature names; Bulk Course Copy is the third workflow. This branding change does not rename the existing Render service URL, LTI registration, environment variables, collections or job namespace. The database configuration is described below.

## Fresh database setup

Each service selects its database using the path in `MONGODB_URL`; no additional variable is required. Names must contain 1–63 letters, digits, underscores or hyphens. System databases (`admin`, `local`, `config`) are rejected. No data is migrated from `brightspace_activity_date_manager`, and the old database is not deleted. The new database is created on the first successful write.

For a prospect service, set its own database path in Render's `MONGODB_URL`, for example `/brightspace_prospect_demo`. Leave the existing service's URL unchanged. Preserve the credentials, cluster host and query options. The MongoDB user needs access to the new database. For local execution, set MONGODB_URL using `.env.example`; the existing local `.env` has no MONGODB_URL entry.

When changing only the database for the same tenant, keep LTI_KEY, OAuth credentials and Brightspace settings unchanged. For a prospect tenant, configure its own LTI registration, OAuth application, Service User and signing credentials. This fresh database has no old job history, sessions or LTI records. The app registers its configured Brightspace platform at startup. Verify a fresh LTI launch after deployment; database-backed signing keys may be regenerated, so pinned platform keys may need updating. Render configuration and live database creation have not been performed by this source change.

Deployment execution continues after isolated validation, preparation, rejection, partial-success, or uncertain outcomes. Uncertain POSTs are never retried. Authentication failure (401), exhausted rate-limit retries (429), or three consecutive service/permission failures stop further batches. Explicit 429 responses allow two retries respecting Retry-After up to 60 seconds; longer waits stop rather than retry early. Persistence and lease failures always interrupt processing. The CSV distinguishes submitted, failed, uncertain and not-attempted replicas; the screen shows a compact summary. Activation excludes failed/not-attempted replicas; any left inactive during preparation require inspection. No manual copy-completion confirmation is required. Automatic activation is restricted to accepted submissions.

Deployment errors retain HTTP status, selected sanitized Brightspace error messages, and request/correlation identifiers when returned. These appear in dedicated CSV columns. Raw responses, request configuration, authorization headers, and cookies are not stored. Existing jobs retain only previously captured diagnostics.

## Automatic reactivation and copy-log monitoring

The deployment workflow is Upload Mappings → Review & Confirm → Deploy & Check Copy. Each accepted replica is automatically activated after submission, while copying may still be queued or running. Rejected or uncertain submissions are not automatically activated. History never reserves courses or blocks a fresh deployment; repeating deployment may reset a replica whose previous copy is still running.

Copy-log checks are on demand. In Job History, choose **View job**, then click **Check copy results now** inside the job to queue one background pass. The signed request is session- and owner-checked; repeated clicks while queued/running return progress without duplicating the run. Checks use `GET /d2l/api/le/{version}/ccb/logs` (LE 1.91+ and Service User permission to view copy logs).

A lightweight worker dispatch timer checks only explicitly queued requests every 10 seconds. Each pass reads up to 10 replicas sequentially. MongoDB stores a run identifier, progress cursor, lease, timestamps, and results; expired leases can resume after restart. A completed pass is not scheduled again. Previous automatic schedule fields are ignored. Opening history and downloading a CSV never request fresh logs. Render must be running for queued work to progress.

Reports retain the latest saved snapshot, per-replica timestamps and pending-current-check indicators. Old results are preserved until replaced. The API provides text logs rather than a structured result linked to the Source Course deployment ID. Missing logs do not mean failure; ambiguous copy IDs or pagination remain unconfirmed. No copy checks reserve courses or prevent a new deployment. New submissions can reset replicas while earlier copies are still queued/running.

## Service User permissions and troubleshooting

Client Credentials authentication uses the Service User linked to the OAuth registration. Both OAuth scopes and that Service User’s Brightspace permissions must allow the operation. Interactive OAuth in Postman may have different permissions. In this installation, deployment returned HTTP 403 until course-copy permissions were enabled for the linked Service User, despite the deployment scope and Source Course deployment permission already being present. The minimum permission set was not isolated because several permissions were enabled together.

Source-name lookup uses GET `/d2l/api/lp/{version}/orgstructure/{id}` and requires `organizations:organization:read` plus organizational-structure access. A forbidden optional name lookup falls back to the source ID without blocking deployment. Existing saved warnings remain historical; test changed permissions with a new preview. Copy-log checking separately requires a supported LE version of at least 1.91 and Service User access to copy-course logs.

## Current deployment interface and completion recognition

The steps are **Upload Mappings → Review & Confirm → Deploy & Check Copy**. The upload button is **2. Review & Confirm** and the confirmed deployment button is **3. Deploy & Check Copy**. Validation, review, execution and result pages share four counters: **Source Courses**, **Replicas**, **Copied Successfully**, and **Copy in Process**. Copy in Process counts submitted or uncertain replicas without a recognized full-copy success message; it is not a live queue-state measurement. Before submission, both copy counters are zero. Invalid mappings are reported through validation messages and the CSV, rather than a separate Need attention counter.

A requested check displays an inline spinner and progress, retains saved counters, and refreshes every 10 seconds while the check runs. There is no popup. The conclusion page offers Check copy results now and Download submission report; the redundant manual refresh button is omitted there. Detailed course lists are not rendered. Job History offers only View job. For submitted/activated jobs, its badge is Copies in process until every replica has a saved successful result, then Copies concluded. Cancelled and error statuses remain distinct.

Completion recognition is deliberately narrow: a single unambiguous copy-job ID with no additional log page must include the observed Portuguese full-copy message `Todos os dados copiados com êxito do orgUnitId: SOURCE para o orgUnitId: TARGET`, with both IDs matching the requested mapping (an optional final period is accepted). Component-level success messages, unfamiliar/localized wording, missing logs, multiple copy jobs and paginated responses remain unconfirmed. This does not establish a deployment-ID-to-copy-job-ID equivalence; independently initiated copies within the same source/target time window can still be ambiguous. Existing snapshots require a new manual check to receive the recognized status.

The completed heading is **✓ Courses Copied Successfully**. Before completion is confirmed, the submission message reports how many replicas initiated copy and prompts a copy check. Reports preserve per-replica submission, activation, diagnostics, copy-log messages, timestamps and check progress.

## Interface languages

Use the header language selector to choose English, Español (Latinoamérica), or Português (Brasil). The choice is remembered in this browser. Switching languages preserves entered form values and does not start a deployment or copy check. Both workflows, navigation, job summaries, application validation messages, and exported report headings support these languages.

Input CSV headers must remain unchanged. Course names, identifiers, report data, machine statuses, and original Brightspace logs retain their original values. Native file-picker and date-picker controls follow the browser language. English is the default and the fallback when JavaScript is unavailable.

Copy-check optimization: new manual checks query only submitted or uncertain replicas without saved successful-copy confirmation. Confirmed results and CSV evidence are retained per job. Each run snapshots its pending replica IDs and checks batches of 10, keeping progress stable as results arrive. Already queued legacy checks finish their original scan; new deployment jobs have independent results. When nothing remains to check, no API work is queued.

### Deploying custom database support

The custom database-name validation is in `src/shared/database.js`. Publish the updated source to the repository and branch used by the prospect Render service, then deploy that revision. Changing an environment variable alone does not update application code. If startup still says it must select `/brightspace_source_courses_tools`, the service is running the older validation. Keep the intended custom database path and deploy the updated source. Local changes do not automatically modify Render.

Environment setup is documented in [ENVIRONMENT.md](ENVIRONMENT.md), with all 17 variables, their sources/defaults, key generation, LTI versus OAuth key URLs, database isolation, scopes, and installation troubleshooting. Use [.env.example](.env.example) as the placeholder-only server configuration template.

API rate safeguards and actual-cost reporting are described in ENVIRONMENT.md under “API pacing and measured costs”. The shared durable gate covers server tenant API traffic. Use `node scripts/api-cost-report.js` after a representative live test; no live measurements have been collected by local tests. Full-scale production capacity and interrupted deployment recovery remain operational validation items.

Pacing tuning: the shared gate now targets 30,000 measured credits/minute with a 10,000-credit reserve, adaptive reset-aware spacing and a conservative 250 ms fallback when costs are missing. At 10 credits, start-to-start spacing is 20 ms; response latency counts toward it. Requests remain serialized and ambiguous writes are never replayed. This reduces artificial delay, but does not guarantee job completion during outages or make interrupted deployments automatically resumable.

CSV templates: the date template downloads as `date-manager-template.csv`. Deployment accepts `SourceOrgUnitId,SourceOrgUnitCode,ReplicaOrgUnitId,ReplicaOrgUnitCode`; provide an ID, code, or matching pair for each side. Codes must resolve to exactly one accessible org unit, followed by source/replica type validation. Aliases are deduplicated after resolution; conflicting targets and source/target overlap block deployment. All four headers are required, even when code cells are empty. Legacy two-column CSV files are rejected; download the new template. Code lookup requires orgstructure read access.

LTI launch shows a lightweight blue loading indicator while frontend assets initialize. It starts when the app HTML arrives, not during Brightspace authentication or server cold start. It is removed after UI initialization and has an eight-second visual fallback; without JavaScript it is hidden so server-rendered content remains accessible.

## Bulk Course Copy (first tool in the sidebar)

Use this tool to copy **all components or a selection of component types** from a **Course Offering** into an **existing Course Offering or Source Course**. This is separate from Source Course deployment: it never creates courses, resets content, or changes activation. Source Courses are not accepted as origins. Offering → Source Course was confirmed by the operator in Postman; verify it in each new tenant before bulk use.

Download `copy-template.csv` from the upload page. All four case-sensitive headers are required (their order may vary):

```csv
OriginOrgUnitId,OriginOrgUnitCode,DestinationOrgUnitId,DestinationOrgUnitCode
123,,456,
,MASTER-2026,,DESTINATION-2026
```

Provide an ID, exact unique org-unit code, or matching ID/code pair on both sides. Destinations must already exist. Missing/ambiguous codes, mismatched identifiers, self-copy, multiple origins for a destination, or a destination also used as an origin in the same job block confirmation. Identical resolved mappings are copied once. Limits: 10,000 mappings and 5 MB UTF-8 CSV. Validation is read-only and the preview expires after 30 minutes.

1. Upload mappings and choose **Copy all components** or **Copy selected components**. A selected-component job requires at least one component. The same selection applies to every mapping; this selects component types, not individual quizzes, assignments, or files.
2. Review counts, selected components, and the downloadable mapping report. Confirm the copy. Existing content can produce duplicates; Brightspace does not deduplicate previous copies.
3. Submission queues native copy jobs and saves their tokens. Select **Check copy results now** to retrieve their status. Completed/failed/cancelled tokens are not checked again. Return through **Job History → Course Copy Jobs**. Page refresh reloads saved progress; it does not continually poll Brightspace or submit new copies.

The report contains all original CSV rows, resolved IDs/names, validation, native copy status, token, component selection, last successful check time, and diagnostic text. A partial check preserves previous results; a read error never erases a saved successful copy. `COMPLETE` counts as success; `COMPLETE_WITH_ERRORS`, `FAILED`, and `CANCELLED` require review in Brightspace. This tool requires LE API **1.97 or newer** so COMPLETE is not mistaken for an older status that could include errors.

Submission checkpoints and tokens are saved in MongoDB before/after each request. Timeouts, unexpected responses, and interrupted submissions are **not automatically repeated**; inspect Brightspace before making a new job. Authentication/transport/server failures stop remaining submissions. Explicit 429 responses use the shared rate-limit handling. A restart interrupts the local job and preserves available tokens for on-demand checks; unsent rows require a new reviewed job. There is no remote cancellation or rollback. The UI Cancel action cancels only local pending work.

Supported component types: AttendanceRegisters, Awards, Checklists, Competencies, CompletionTracking, Content, CourseAppearance, CourseFiles, Discussions, DisplaySettings, Dropbox (Assignments), Faq, Forms (registration forms), Glossary, Grades, GradesSettings, Groups, Homepages, IntelligentAgents, LearningOutcomes, Links, LtiLink, LtiTP, Navbars, News, QuestionLibrary, Quizzes, ReleaseConditions, Rubrics, S3Model, Schedule, SelfAssessments, Surveys, ToolNames, Widgets. Include related components required by your content; the app does not automatically add dependencies.

The interface and report headings support English, Brazilian Portuguese, and Latin American Spanish. CSV input headers, native API status values, tokens, and diagnostic report data remain stable machine values.
