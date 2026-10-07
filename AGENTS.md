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

Date Manager supports cancellation while Step 2 resolves course identifiers or discovers/previews activities. Cancellation stops new planning work, drains in-flight read-only requests, retains saved progress, and prevents the job from becoming ready or starting writes.

## Conventions and safety constraints

- Follow the existing dependency-injected feature-factory pattern and wire shared clients/services in `index.js`.
- Keep tenant API calls behind the shared guarded, rate-limited transport. Preserve bounded pagination and worker limits.
- Bulk forms and job actions must retain LTI session, owner, signed-ticket, expiry, and workflow-kind checks. Keep writes behind saved-plan confirmation.
- Preserve native Brightspace settings when updating dates or course active state; retain read-back verification and stale-preview checks.
- Never automatically repeat a write with an uncertain outcome. Timeouts, process restarts, or lost responses can occur after Brightspace accepted a request; keep the saved result inspectable and require reconciliation.
- Deployment preparation can leave replicas inactive if it fails. Surface per-replica outcomes and do not add rollback or resubmission assumptions casually. Activation does not establish that copying has completed.
- Treat org-unit code cache hits as snapshots, not live identity checks. Do not resolve ambiguous codes by choosing the first match.
- Escape rendered HTML and spreadsheet CSV values; sanitize API diagnostics and never expose credentials or raw request configuration.
- Visible UI text belongs in all three catalogs under `src/ui/locales/` (English, Latin American Spanish, Brazilian Portuguese). Keep catalog keys/placeholders aligned.
- Do not casually change Brightspace API payloads, minimum API versions, job persistence/checkpoint semantics, tenant/database namespacing, scopes, or retry behavior; inspect the related tests and subsystem docs first.
- Preserve phase-specific persistence semantics: persist read-only resolution at its phase boundary before dependent discovery; discovery plans and write outcomes require durable checkpointing. Keep large MongoDB chunk writes batched rather than issuing high-volume sequential round trips.

## Development checks

- Use Node.js 22. Install with `npm ci`.
- Run `npm test` and `npm run check` for source changes. Run `npm run build` after UI changes; `npm start` also builds assets through `prestart`.
- `npm run activity:dates -- ...` is a preview-first single-activity diagnostic CLI; `npm run verify:discovery` runs discovery verification. Bulk changes should be exercised through saved-job workflows.
- Do not commit `.env`, private keys, `node_modules/`, or generated `public/assets/` bundles. Configure tenant-specific LTI/OAuth credentials and scopes using `.env.example` and `ENVIRONMENT.md`.
