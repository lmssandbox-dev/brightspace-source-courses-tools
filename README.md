# Brightspace Source Courses Tools

A toolkit for managing Brightspace Source Courses, currently offering Bulk Activity Dates Manager and Bulk Source Courses Deployer. One LTI application with two workflow sections, deployed to one Render service. The existing LTI installation, OAuth configuration, MongoDB database and local `.env` are retained.

## 1. Activity dates

Upload a UTF-8 CSV with headers `OrgUnitId,OrgUnitCode`. Supply exactly one ID or code per row; keep both columns in the header. The app accepts Course Offerings and actual Source Courses.

Choose a time zone (Brasília by default), then enter Start, Due and End. The selected zone is saved with the job; skipped or repeated local times around clock changes are rejected. Start must be before Due; Due must be on or before End. 2. Review Updates resolves every course and discovers Assignments, Quizzes and Discussion Topics, including undated activities, without changes. Apply writes the saved plan, reads dates back and records per-activity results. Return through My recent jobs or download the CSV report.

Limits: 10,000 CSV data rows, 5 MB of UTF-8 CSV, 250,000 activities per date job. Duplicates are processed once. Invalid rows or incomplete discovery block the plan. Previews must be confirmed within 30 minutes; confirmed jobs can finish or resume after that window. Changed dates are rejected unless already equal to the requested dates. Availability modes and unrelated activity settings are preserved.

Read-only discovery and the single-activity preview/apply form remain available for troubleshooting. All three activity writers and the CSV date workflow have been validated live by the user.

## 2. Source Course replication

Upload a second CSV with headers `SourceOrgUnitId,ReplicaOrgUnitId`. Both IDs are required on each row. Repeat the source ID for multiple replicas. Sources must be actual Source Course org units; replicas must already exist as Course Offerings. Replicas may initially be active or inactive.

1. Validate deployment mappings performs reads only and saves a plan.
2. Confirm Prepare and deploy. Each batch is validated, deactivated and read back immediately before its deployment is submitted. Other batches remain untouched until their turn. Brightspace resets the target content as part of deployment. Submission IDs and results are saved.
3. Wait for copying to finish in Brightspace. You can close the browser. Submitted means accepted, not finished; the app does not poll copy completion or activate after a timer.
4. Return through My deployment jobs. Check every copy, resolve failures/uncertain outcomes, and confirm Activate replicas. All mapped replicas are activated, including those originally inactive, with read-back verification.

Limit: 10,000 rows / 5 MB. Each source is split into batches of at most 100 replicas per deployment request. Duplicate mappings are processed once. Conflicting sources for a replica, self-deployment and source/replica overlap block the preview. If preparation fails, already-deactivated replicas remain inactive with saved results. Inspect them before restoring service; there is no automatic rollback. Activation retry checks current state and does not redeploy.

Finish source date changes before replication. Saved unresolved deployments reserve involved courses against overlapping bulk jobs in this application. Live Source Course deployment/activation acceptance is still pending; no live replication was executed during the file reorganization.

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

The folders separate features, not deployments. There is no second Render app, database or LTI installation to create. Keep `test/`, package.json and package-lock.json. README describes operation; TECHNICAL describes implementation; PLAN records remaining work.

## Configuration and deployment

Use Node.js 22. Run `npm ci`, `npm test`, `npm run check`, then `npm start`. Upload the entire current project source to the existing Render service. Do not upload `.env`, private keys, `.local-tools` or node_modules. Do not overlay only selected renamed files: use this complete source layout.

The existing `.env` is unchanged; no MONGODB_URL entry was found locally. For new environments use `.env.example`. MONGODB_URL must explicitly select `brightspace_source_courses_tools`. Keep LTI_KEY and the OAuth signing key/key ID stable across restarts. BS_CLIENT_ID and BS_DEPLOYMENT_ID must match the existing Brightspace installation. LTI controls who launches the app; API requests use the configured Service User's permissions through Client Credentials with Private Key JWT.

Existing endpoints stay the same: `/login` for OIDC login, `/` for target link, `/keys` for LTI public keys, `/.well-known/brightspace-jwks.json` for OAuth public keys, and `/ping` for health checks. No public endpoint writes Brightspace data.

D2L_LE_VERSION must be supported (at least 1.90). Source replication needs D2L_LP_VERSION=1.53 or later. Date writes need `dropbox:folders:write`, `quizzing:quizzes:write` and `discussions:topics:manage`; replication needs `manageCourses:deploy:manage` and `orgunits:course:update`, alongside the required read scopes and Service User permissions. Matching resource/action wildcards are supported. LP 1.54+ also requires locale/address-book fields in course read responses for safe status updates.

## Local diagnostic CLI

`npm run activity:dates -- <assignment|quiz|discussionTopic> <courseId> <activityId> <startISO> <dueISO> <endISO> [forumId] [--apply]`

Preview is the default; Discussion Topics require the forum ID. The CLI uses the same writers and OAuth configuration, without an LTI launch or MongoDB. `npm run verify:discovery` runs the discovery verification script. These are development tools; use the saved-job UI for bulk work.

## D2L interface

The workspace has a left sidebar for Bulk Activity Dates Manager, Bulk Source Courses Deployer and Job History. It uses `@brightspace-ui/core` buttons, alerts and loading indicators. Native date inputs use the selected time zone. CSV templates and grouped replica results are included; development tools and the footer are omitted. Deployment submission never implies copy completion.

`npm ci` builds frontend assets automatically through postinstall. `npm start` also builds them before starting the server. For manual builds use `npm run build`. Render may continue using the existing service; no separate frontend hosting or database is needed. Commit package.json, package-lock.json, src/ui, the updated source and scripts/build-ui.js. Generated public/assets files are ignored by Git and rebuilt during deployment. Browser assets are served locally; no CDN is required.

The frontend was checked locally with synthetic jobs and no Brightspace writes. Verify it through a real LTI launch after deployment, including the LMS frame size and platform browser restrictions.

### Large date jobs

Date-job records use immutable chunks in `bulk_date_chunks`, publishing checkpoint references only after chunks are stored. Planning checkpoints every 50 work items; execution saves before and after each activity. A restarted worker resumes resolution/discovery and skips saved results. An in-flight write is flagged as uncertain, never automatically repeated. Systemic API failures still stop writes. Replication supports 10,000 mappings / 5 MB and retains its existing recovery rules.

Result tables show 100 records per page; the CSV report includes all records. Processing remains sequential to bound API traffic. The complete job is loaded into worker memory, so size the server for the activity ceiling; chunking removes the single MongoDB document limit but is not a streaming worker. Historical immutable chunks are retained and need a retention policy before sustained high-volume production use. Large jobs have been tested locally with synthetic data, not at 10,000-course scale against a live Brightspace tenant.

## Application identity

Display name: **Brightspace Source Courses Tools**. Package name: `brightspace-source-courses-tools`. Project folder: `Brightspace Source Courses Tools`. The two tools retain their feature names. This branding change does not rename the existing Render service URL, LTI registration, environment variables, collections or job namespace. The database configuration is described below.

## Fresh database setup

The app now requires `brightspace_source_courses_tools`. No data is migrated from `brightspace_activity_date_manager`, and the old database is not deleted. The new database is created on the first successful write.

Before deploying, change the database path in Render's `MONGODB_URL` to `/brightspace_source_courses_tools`. Preserve the credentials, cluster host and query options. The MongoDB user needs access to the new database. For local execution, set MONGODB_URL using `.env.example`; the existing local `.env` has no MONGODB_URL entry.

Keep LTI_KEY, OAuth credentials and Brightspace settings unchanged. This fresh database has no old job history, sessions or LTI records. The app registers its configured Brightspace platform at startup. Verify a fresh LTI launch after deployment; database-backed signing keys may be regenerated, so pinned platform keys may need updating. Render configuration and live database creation have not been performed by this source change.

Deployment execution continues after isolated validation, preparation, rejection, partial-success, or uncertain outcomes. Uncertain POSTs are never retried. Authentication failure (401), exhausted rate-limit retries (429), or three consecutive service/permission failures stop further batches. Explicit 429 responses allow two retries respecting Retry-After up to 60 seconds; longer waits stop rather than retry early. Persistence and lease failures always interrupt processing. The results screen and CSV distinguish submitted, failed, uncertain and not-attempted replicas. Activation excludes failed/not-attempted replicas; any left inactive during preparation require inspection. Submission still requires manual copy-completion confirmation in Brightspace.

Deployment errors retain HTTP status, selected sanitized Brightspace error messages, and request/correlation identifiers when returned. These appear in replica results and dedicated CSV columns. Raw responses, request configuration, authorization headers, and cookies are not stored. Existing jobs retain only previously captured diagnostics.
