# Brightspace Source Courses Tools — Delivery Status

## Implemented locally

- Application branding, sidebar navigation, and simplified date and deployment forms.
- 10,000-row / 5 MB CSV support for both workflows; deployment requests contain up to 100 replicas per source batch.
- Named time zones and date conversion validation; bulk date discovery, updates, read-back checks and CSV reports.
- Three deployment steps: Upload Mappings → Review & Confirm → Deploy & Check Copy.
- Just-in-time batch deactivation, deployment submission, and automatic reactivation of accepted replicas.
- Isolated failures continue; authentication, exhausted rate-limit retries and repeated service failures stop further batches.
- Sanitized deployment diagnostics in stored results, screens and reports.
- No historical job reservations or manual copy-completion requirement.
- On-demand “Check copy results now” inside job details (opened through View job in Job History); signed owner-scoped requests, duplicate prevention, bounded batches, durable progress and lease recovery.
- Reports retain saved copy-log snapshots, timestamps, and pending-current-check indicators. History access and CSV download do not trigger API checks.
- Previous automatic 24-hour monitoring removed. A worker dispatch timer processes only explicitly queued checks; completed checks do not repeat.
- Latest full local test run: 201 tests passed.

## Confirmed by the user in Brightspace

- Live activity date updates and read-back behavior.
- Source Course deployments succeeded after enabling missing course-copy permissions for the OAuth-linked Service User. OAuth scopes alone were insufficient.

## Remaining live validation

1. Redeploy subsequent UI changes to Render and verify the current labels and compact layout. Two-replica automatic reactivation and successful copy checking have been observed in user-provided reports/screenshots.
2. Use a tenant-supported LE version of at least 1.91 and grant the Service User permission to read course-copy logs.
3. Broaden live validation of copy-log matching, including other languages, missing/ambiguous logs, and error outcomes. The observed Portuguese full-copy message is now recognized only with matching IDs and an unambiguous single-page response.
4. Test restart recovery and representative large workloads. Local synthetic tests include 3,000 sources and 5,000 replicas; this scale has not been validated live.

Copy logs expose text messages and copy-job IDs, not a structured result directly correlated to the deployment ID. Missing or ambiguous logs remain unconfirmed. Monitoring neither blocks deployment nor automatically re-submits copies.

Each Brightspace tenant uses its own Render service and the application database selected by MONGODB_URL. Queued background checks require the service to be running.

- Current UI: consistent four counters, inline copy-check progress, no popup or replica tables; details in CSV. History has View job only and copy-progress/completion badges.

## Localization completed

- Added English, Latin American Spanish, and Brazilian Portuguese catalogs and a persistent header language selector.
- Localized application text, dynamic summaries, validation messages, and report headings; preserved CSV input schemas and original report data/logs.
- Verified Portuguese/Spanish switching, retained date input values, and language persistence across workflow navigation in an isolated local preview.
- All 206 automated tests pass. Live Render/LTI verification remains a deployment check.

Copy-check optimization: new manual checks query only submitted or uncertain replicas without saved successful-copy confirmation. Confirmed results and CSV evidence are retained per job. Each run snapshots its pending replica IDs and checks batches of 10, keeping progress stable as results arrive. Already queued legacy checks finish their original scan; new deployment jobs have independent results. When nothing remains to check, no API work is queued.

Each independently deployed tenant can now select a dedicated database through the existing MONGODB_URL path. Both LTI storage and job storage use that URI. Explicit application names are required; system names, missing names, and dbName query overrides are rejected. Existing connection strings remain valid. Database creation occurs on first write, subject to MongoDB permissions. This does not migrate data or change any live Render configuration.

Environment setup is documented in [ENVIRONMENT.md](ENVIRONMENT.md), with all 17 variables, their sources/defaults, key generation, LTI versus OAuth key URLs, database isolation, scopes, and installation troubleshooting. Use [.env.example](.env.example) as the placeholder-only server configuration template.

API rate safeguards and actual-cost reporting are described in ENVIRONMENT.md under “API pacing and measured costs”. The shared durable gate covers server tenant API traffic. Use `node scripts/api-cost-report.js` after a representative live test; no live measurements have been collected by local tests. Full-scale production capacity and interrupted deployment recovery remain operational validation items.

Pacing tuning: the shared gate now targets 30,000 measured credits/minute with a 10,000-credit reserve, adaptive reset-aware spacing and a conservative 250 ms fallback when costs are missing. At 10 credits, start-to-start spacing is 20 ms; response latency counts toward it. Requests remain serialized and ambiguous writes are never replayed. This reduces artificial delay, but does not guarantee job completion during outages or make interrupted deployments automatically resumable.

CSV templates: the date template downloads as `date-manager-template.csv`. Deployment accepts `SourceOrgUnitId,SourceOrgUnitCode,ReplicaOrgUnitId,ReplicaOrgUnitCode`; provide an ID, code, or matching pair for each side. Codes must resolve to exactly one accessible org unit, followed by source/replica type validation. Aliases are deduplicated after resolution; conflicting targets and source/target overlap block deployment. All four headers are required, even when code cells are empty. Legacy two-column CSV files are rejected; download the new template. Code lookup requires orgstructure read access.
