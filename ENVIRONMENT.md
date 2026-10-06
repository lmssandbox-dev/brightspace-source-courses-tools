# Server environment setup

This guide covers all 17 variables used by the app. Start with `.env.example`. Use one server instance per Brightspace tenant, with its own configuration and database. No real credentials are included in the template.

For local use, copy `.env.example` to `.env` and replace the placeholders. On Render, enter the variables under the service's Environment settings. Render values should not include the surrounding quotes used in a .env file. Do not commit `.env` or private keys. Deploy the current project source before configuring a custom database name.

## Variable reference

| Variable | Required / default | Meaning and where to obtain it |
| --- | --- | --- |
| `MONGODB_URL` | Required | MongoDB connection string from your database provider (Atlas: Connect → Drivers). Use a database user's credentials, not your Atlas website login. Set the database path explicitly, e.g. `/brightspace_prospect_demo`, before `?` options. URL-encode special characters in the username/password. The database user must be allowed to read/write that database and the server must have network access. |
| `LTI_KEY` | Required; generate once | App-owned random secret used by ltijs for cookies and encrypted stored information, and by this app for signed workflow controls. Generate as shown below. It is not a Brightspace client ID, private RSA key, or an LTI 1.1 consumer key. Keep it stable across deployments and restarts. |
| `PORT` | Optional; `3000` | Server listening port. Use `3000` locally; normally allow Render to supply its PORT. This is not the public HTTPS port. |
| `BS_URL` | Required | Brightspace tenant origin/issuer, e.g. `https://institution.brightspace.com`. Copy the issuer from the LTI registration and verify it matches the tenant API origin. Do not append a course path or trailing slash. |
| `BS_NAME` | Optional; `Brightspace` | Friendly platform name you choose, such as `Prospect Brightspace`. Not a credential. |
| `BS_CLIENT_ID` | Required for working LTI launch | Client ID issued by the tenant's **LTI Advantage tool registration**. Copy it from registration details. Do not use the OAuth API application's client ID. |
| `BS_DEPLOYMENT_ID` | Required for working LTI launch | Deployment ID issued when the LTI tool is deployed in External Learning Tools. Copy the deployment associated with the launch link. An empty value blocks launches; it is only useful during initial setup. |
| `BS_AUTH_ENDPOINT` | Required | Brightspace's **OpenID Connect Authentication Endpoint**, copied from LTI registration details. This is the platform endpoint, not this app's `/login`. |
| `BS_TOKEN_ENDPOINT` | Required | **Brightspace OAuth2 Access Token URL** from LTI registration details. Used by the LTI platform configuration. Copy the exact value provided. |
| `BS_KEYSET_URL` | Required | **Brightspace Keyset URL** from LTI registration details. It contains Brightspace's public keys for verifying launches. It is not either of this app's key endpoints. |
| `D2L_OAUTH2_CLIENT_ID` | Required | Client ID issued by a separate OAuth 2.0 application registered with **Client Credentials / Private Key JWT**, linked to a Service User in this tenant. |
| `D2L_OAUTH2_KEY_ID` | Required; choose once per key | Your identifier for the OAuth RSA key, e.g. `prospect-api-2026-01`. This is a label, not a secret or a Brightspace-issued ID. The app uses it as `kid` in both its public JWKS and signed assertions. |
| `D2L_OAUTH2_PRIVATE_KEY` | Required; generate | Entire RSA private key in PEM format, including BEGIN/END lines. Generate an RSA key of at least 2048 bits; instructions below use 3072. The app signs OAuth assertions with it and derives the public JWKS automatically. Do not upload the private key to Brightspace. |
| `D2L_OAUTH2_TOKEN_ENDPOINT` | Optional; `https://auth.brightspace.com/core/connect/token` | API OAuth token endpoint. Confirm the endpoint for the tenant's OAuth service. HTTPS is required. Explicitly setting the standard value is fine; omit the variable rather than setting an empty value to use the default. |
| `D2L_OAUTH2_SCOPES` | Required | Space-separated scopes allowed by the OAuth application and requested by this app. Obtain/approve them with the Brightspace administrator using the endpoint documentation. Scopes alone do not grant Service User permissions. See below. |
| `D2L_LE_VERSION` | Required | Supported Learning Environment API version, entered as `1.91`, not a URL. The app's date operations require at least 1.90; copy-log checks require **1.91 or later**. Confirm tenant support with the Brightspace API version discovery endpoint `/d2l/api/versions/`. |
| `D2L_LP_VERSION` | Optional; `1.53` | Learning Platform API version. Source deployment requires 1.53 or later; verify tenant support. LP 1.54+ course updates require extra locale/address-book fields in the course response. |

The application accepts database names of 1–63 letters, digits, underscores or hyphens. `admin`, `local`, `config`, missing database paths and `dbName` query overrides are rejected. MongoDB creates the selected database on the first successful write if permissions allow it. Connecting does not migrate or copy existing data. Both LTI records and application jobs use the configured database. A dedicated database user per installation is recommended; sharing a user works if it has the necessary access, but gives less isolation.

## Generate the application secrets

Run these commands on your trusted workstation, in a private directory outside the repository. They write secrets to files rather than printing them. Do not regenerate them on every deploy.

```sh
umask 077
openssl rand -hex 32 > lti-key.txt
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out oauth-private-key.pem
```

Copy the single line from `lti-key.txt` into `LTI_KEY`. Copy the complete contents of `oauth-private-key.pem` into `D2L_OAUTH2_PRIVATE_KEY`. Choose a corresponding `D2L_OAUTH2_KEY_ID` label. These are separate values; there is no additional `OAUTHKEY` variable or OAuth client secret in this authentication flow.

For a .env file, the PEM can be represented inside double quotes with literal `\n` separators, as in the template. In Render, paste the complete multiline PEM without wrapping quotes; the app also accepts literal `\n` separators. Keep a secure backup of the key and LTI secret. A key change requires coordinating the new public key with the OAuth registration; changing LTI_KEY can invalidate existing encrypted information and sessions.

## Which URL goes where?

Replace `https://YOUR-APP` with this installation's public HTTPS server URL.

| Brightspace registration field | Value |
| --- | --- |
| LTI tool OpenID Connect login URL | `https://YOUR-APP/login` |
| LTI tool redirect URL / target link URI | `https://YOUR-APP/` |
| LTI tool keyset URL | `https://YOUR-APP/keys` (managed by ltijs) |
| OAuth Client Credentials application JWKS URL | `https://YOUR-APP/.well-known/brightspace-jwks.json` (derived from your OAuth RSA key) |

`BS_KEYSET_URL` goes the opposite direction: it points to **Brightspace's** keys. The two app key endpoints and the Brightspace keyset are not interchangeable. Only public keys are served by the JWKS routes.

## Scopes and Service User access

Configure matching scopes in the Brightspace OAuth registration and `D2L_OAUTH2_SCOPES`. The app explicitly checks these write scopes:

- Assignment dates: `dropbox:folders:write`
- Quiz dates: `quizzing:quizzes:write`
- Discussion topic dates: `discussions:topics:manage`
- Source deployment: `manageCourses:deploy:manage`
- Replica activation: `orgunits:course:update`

Also grant the documented read scopes for course lookup, assignment folders, quizzes, discussion forums/topics, and course-copy logs. The existing discovery configuration includes `dropbox:folders:read`, `quizzing:quizzes:read`, `discussions:forums:readonly`, and `discussions:topics:readonly`. Review the complete endpoint requirements for the tenant/API versions; this list is not a certified minimum-permission profile. The template deliberately requires an administrator-supplied full scope string rather than granting broad wildcards.

The Service User must have access to the source and replica org units and permissions for the same operations, including course copying and viewing copy logs. Its username/password are not environment variables: Brightspace associates it with the OAuth application. API actions use that Service User, not the person launching the LTI tool. In the original installation, HTTP 403 on deployment was resolved by enabling course-copy permissions for the Service User; the exact minimum permission combination was not isolated.

## Installation sequence

1. Reserve the new server URL and prepare its MongoDB connection/database permissions.
2. Generate the LTI secret and OAuth RSA key; choose the OAuth key ID.
3. Register the LTI tool using the app URLs above; copy Brightspace's issuer, client ID and endpoints. Create its deployment and copy the deployment ID.
4. Create the Service User and OAuth Client Credentials application with the app's OAuth JWKS URL. Copy the OAuth client ID and configure approved scopes. If Brightspace requires a reachable JWKS before saving registration, host the public JWKS derived from the same RSA key/key ID at an HTTPS setup location, then switch the registration to the app endpoint once deployed. Never publish the private PEM.
5. Fill all required variables and deploy the current source. Use Node.js 22, `npm ci` for the build and `npm start` to start. Check `/ping` and both public key endpoints.
6. Launch through the configured Brightspace LTI link. Validate a small CSV and test the three workflows with disposable courses. Check copy results and download the report. Confirm job data is written to the intended MongoDB database.

## Troubleshooting

- Error requiring exactly `/brightspace_source_courses_tools`: the deployed source predates configurable database names. Deploy the updated `src/shared/database.js`; do not change the intended prospect database to work around old code.
- MongoDB authentication/network error: check database-user credentials, URL encoding, database permissions, network access and any `authSource` option supplied by your provider.
- Invalid launch: check the LTI client ID, deployment ID, issuer and platform endpoints belong to this tenant; confirm the launch link uses this service URL.
- Invalid OAuth client/signature: check the separate OAuth client ID, PEM, key ID, token endpoint and publicly reachable OAuth JWKS.
- HTTP 403: check both OAuth scopes and Service User permissions/org-unit access.
- Copy-log monitoring unavailable: check supported LE version (1.91+) and access to copy logs.

## References

- [D2L LTI registration, deployment and links](https://community.d2l.com/brightspace/kb/articles/23662-tool-registration-deployment-and-links)
- [D2L OAuth server-to-server registration](https://community.d2l.com/brightspace/kb/articles/33526-register-an-oauth2-0-application-for-server-to-server-authentication)
- [D2L Service Users and server-to-server authentication](https://community.d2l.com/brightspace/kb/articles/34318-service-users-and-server-to-server-authentication)
- [D2L course API reference](https://docs.valence.desire2learn.com/res/course.html)

## API pacing and measured costs

The server now routes tenant API reads, activity PUTs, course status PUTs, deployment POSTs and copy-log reads through one MongoDB-backed gate keyed by tenant origin and OAuth client ID. No new environment variables are needed. Keep instances sharing that OAuth registration on the same database; independently configured databases cannot coordinate the same bucket. Use separate OAuth registrations for independent installations.

Up to four API requests may overlap. MongoDB atomically reserves credits before each request against a 30,000-credit / 60-second local window. The pacing target is 30,000 credits/minute (60% of the stated 50,000-credit allowance): a measured 10-credit request has a 20 ms minimum start-to-start interval. Network time counts toward that interval. Higher observed costs increase spacing proportionally. Remaining credits and reset time can slow requests further to preserve a 10,000-credit reserve; reaching that reserve or the latest request cost triggers a reset wait. Missing cost headers retain a conservative 250 ms interval. MongoDB coordination, network latency and per-job persistence further reduce throughput; this target is not a promised completion time. An explicit 429 triggers at least a 60-second cooldown, or the longer server reset/Retry-After, plus a one-second margin. The cooldown survives restart. MongoDB failures prevent new API requests. Each transport call permits at most five 429 retries; existing bounded caller retries may also apply. Persistent failure stops/flags work rather than retrying forever. Ambiguous writes are not automatically replayed. This controls API submissions, not the speed or concurrency of Brightspace's internal copy queue.

Actual costs are collected from X-Request-Cost without extra Brightspace calls. `api_rate_limits` stores aggregate request count, measured count, total credits, minimum/maximum costs by method and normalized endpoint. Numeric course/activity IDs and query parameters are omitted; no token, request body or API response body is saved. Missing headers remain unknown, not assumed measured costs. Last remaining credits and reset duration are also recorded.

Run `node scripts/api-cost-report.js` with this installation's server environment to print the read-only measurements. First run a small representative date preview/update, source deployment, and copy check. Compare minimum, maximum and average cost for every endpoint; costs can change and should not be assumed permanently equal to 10. The command reads MongoDB only and never triggers Brightspace calls.

Synthetic tests exercise 5,000 concurrent submissions, the four-permit ceiling, atomic reservation expressions, credit-window exhaustion and global cooldown persistence; they do not establish live throughput or the complete workflow request count. Fifty thousand activity updates require additional reads/discovery/verification, and 5,000 deployments require validation and activation calls. Use measured phase timings rather than promising a fixed completion time. Existing activity checkpoints and uncertain-write protections remain in effect; deployment restart recovery still requires reviewing interrupted jobs. No guarantee is made that all jobs complete during repeated outages. Validate live at gradually increasing scale before a full production run, including memory, MongoDB storage, report size and lease recovery. Copy checks renew their lease during long cooldowns.

Deployment CSV uploads require all four headers: `SourceOrgUnitId,SourceOrgUnitCode,ReplicaOrgUnitId,ReplicaOrgUnitCode`. The previous two-column format is rejected. Code-based mapping requires orgstructure read access; use the current downloadable template and leave unused ID/code cells empty.

## Bulk Course Copy to Source Courses configuration and permissions

No additional environment variables or Render services are required. The first sidebar tool uses the existing MONGODB_URL, namespace, OAuth client, service user, LTI session, shared rate limiter, D2L_LP_VERSION and D2L_LE_VERSION. Set D2L_LE_VERSION to a tenant-supported version **at least 1.97** (for example, the tested tenant uses 1.99). Earlier versions do not reliably distinguish COMPLETE from COMPLETE_WITH_ERRORS.

The service user must be able to read the origin Course Offering, resolve codes through org structure, read the existing destination (including Source Course validation where applicable), copy the selected course components, and retrieve native copy-job status. Enable the relevant Brightspace course-copy permissions for both org units and the selected tools. Unlike Source Course Deployer, this tool does not require reset or active-state updates for its copy operation. Other tools still require their documented permissions.

D2L's current [copy-job endpoint documentation](https://docs.valence.desire2learn.com/res/course.html#copying-courses) does not list dedicated OAuth scope strings for these two copy routes. Do not infer them from the separate import-job scopes or Source Course deploy scope. Confirm access using the configured OAuth client and linked service user in a test course; authentication and authorization failures are recorded, stop further submissions, and do not trigger permission escalation.

Tenant acceptance: copy a small Course Offering into an existing test Course Offering and a test Source Course, once with all components and once with selected components. Verify content and native status against Brightspace, including COMPLETE_WITH_ERRORS and dependencies. Test that missing destinations are rejected and no course activation changes occur. Inspect `node scripts/api-cost-report.js` for copy POST and token-status GET costs. Metrics remain server-only and contain normalized token paths. Do not begin a large job until tenant access and selections have been validated.

Copy validation now reuses orgstructure ID/code/name/type metadata. Large code-based jobs may page through the accessible org-unit directory, using the existing `organizations:organization:read` scope and service-user permissions. No new variables are required. If inventory scanning cannot finish within the built-in bounds, exact-code lookup is used instead. Validate the tenant's returned type codes in a small job; unrecognized types use the existing authoritative checks.

See [PERFORMANCE.md](PERFORMANCE.md) for the new preparation modes, durable parallel workers and server-only timing reports. Run `node scripts/job-performance-report.js` alongside the API cost report after a small test. No extra credentials or variables are needed. Deploy after current bulk jobs have finished: restarting active copy/deployment work preserves checkpoints but interrupts that job. Keep all instances sharing an OAuth registration on this version and the same MongoDB database for coordinated limits.

### Database round-trip optimization

Concurrent copy/deployment checkpoints now share a durable write when ready together; no copy is sent before its checkpoint succeeds. Lease renewals are deduplicated and reused briefly within the valid lease, while the heartbeat and worker/status fencing remain. The API gate initializes once and waits on known spacing/reset/budget deadlines without repeated database polling. Concurrency stays at four. The job report distinguishes checkpoint requests from physical saves. Run `node scripts/mongodb-latency-report.js` in Render for a read-only connection/ping report; credentials and hostnames are never printed. See [PERFORMANCE.md](PERFORMANCE.md) for behavior, tests, region checks and the repeat-test procedure. No new environment variables or infrastructure changes are required.

Source Deployer uses the shared lease reuse, gate waiting and checkpoint coalescing improvements. Activation retries now checkpoint only the affected task, and normal execution omits the redundant end-of-batch save after submission/activation results have already been persisted. Pre-write intent checkpoints, course-state verification, the 100-replica batch limit and sequential batches for each source remain intact. Test a small deployment separately: Course Copy timing does not predict deployment timing because deployment also prepares and reactivates replicas.
