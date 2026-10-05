# Brightspace Source Courses Tools — Delivery Status

## Implemented locally

- Application branding, sidebar navigation, and simplified date and deployment forms.
- 10,000-row / 5 MB CSV support for both workflows; deployment requests contain up to 100 replicas per source batch.
- Named time zones and date conversion validation; bulk date discovery, updates, read-back checks and CSV reports.
- Three deployment steps: Upload Mappings → Review & Deploy → Conclusion.
- Just-in-time batch deactivation, deployment submission, and automatic reactivation of accepted replicas.
- Isolated failures continue; authentication, exhausted rate-limit retries and repeated service failures stop further batches.
- Sanitized deployment diagnostics in stored results, screens and reports.
- No historical job reservations or manual copy-completion requirement.
- On-demand “Check copy results now” in Job History and job details; signed owner-scoped requests, duplicate prevention, bounded batches, durable progress and lease recovery.
- Reports retain saved copy-log snapshots, timestamps, and pending-current-check indicators. History access and CSV download do not trigger API checks.
- Previous automatic 24-hour monitoring removed. A worker dispatch timer processes only explicitly queued checks; completed checks do not repeat.
- Latest full local test run: 201 tests passed.

## Confirmed by the user in Brightspace

- Live activity date updates and read-back behavior.
- Source Course deployments succeeded after enabling missing course-copy permissions for the OAuth-linked Service User. OAuth scopes alone were insufficient.

## Remaining live validation

1. Redeploy the latest project to Render and verify the three-step automatic-reactivation flow with the two test replicas.
2. Use a tenant-supported LE version of at least 1.91 and grant the Service User permission to read course-copy logs.
3. Request one copy check and inspect actual Source Course deployment logs, progress and exported snapshots. Validate matching before treating logs as evidence of copy completion.
4. Test restart recovery and representative large workloads. Local synthetic tests include 3,000 sources and 5,000 replicas; this scale has not been validated live.

Copy logs expose text messages and copy-job IDs, not a structured result directly correlated to the deployment ID. Missing or ambiguous logs remain unconfirmed. Monitoring neither blocks deployment nor automatically re-submits copies.

One Render service and the `brightspace_source_courses_tools` MongoDB database are used. Queued background checks require the service to be running.
