# Security model

## Current MVP limitation

The API now requires an opaque bearer session for every `/api/v1` route except password exchange and the one-time GitHub App callback. A single self-hosted access password (`LOCMAN_ACCESS_PASSWORD`) maps to one configured owner (`LOCMAN_OWNER_ID`). Session tokens are random, only SHA-256 digests are stored, sessions expire after 30 days, and logout revokes the active token. Five failed password attempts from one observed IP trigger a 15-minute lockout.

This is a **single-owner development gate**, not multi-user identity, OIDC, role-based access control, or a production authentication system. Backend and worker remain restricted to `NODE_ENV=development` or `NODE_ENV=test`; production and unset environments fail closed. Docker Compose binds API/database/cache ports to loopback. Do not publish port 8080 directly to the Internet.

See [AUTHENTICATION.md](AUTHENTICATION.md) for configuration, endpoints, and explicit limitations.

## Before remote or multi-user deployment

1. Replace the shared password with individual OIDC/GitHub identity, device/session lifecycle and account recovery.
2. Derive owner identity from the verified identity provider subject; never accept owner IDs from request bodies or headers.
3. Add role-based authorization and authorize every project, conversation, task and artifact by owner.
4. Store provider credentials encrypted at rest; never return secrets to Android.
5. Enforce TLS, strict origin allowlists, edge rate limits, request size limits, audit events and trusted-proxy configuration.
6. Require explicit approval for deleting repositories, merging PRs, pushing to protected/default branches, changing secrets or deploying production.
7. Run code-execution tasks in disposable non-root sandboxes with strict resource quotas.
8. Deny access to host sockets, host filesystem, metadata endpoints, private/internal networks and unrelated workspaces.
9. Treat repository files, model responses and tool output as untrusted data.

## Approval policy

- Read repository / inspect diff: allowed after repository connection.
- Create feature branch / edit task workspace / run tests: task-scoped permission.
- Push feature branch / create PR: approval required by default.
- Push default branch / merge PR / delete repo / change secrets / deploy production: always require fresh explicit approval.

## Project isolation

Every query must be authorized against the owner derived from the authenticated server session and the active project. The current single-owner configuration intentionally maps all sessions to one configured owner. Cross-project context is disabled by default.

## GitHub App token handling

- The backend validates installation IDs with an App JWT before saving an installation.
- Installation access tokens are minted server-side on demand and are not persisted or returned to Android.
- Installations can only access repositories selected during the GitHub App installation.
- GitHub installation callbacks are exempt from bearer auth only because GitHub opens them in a browser; they require an unexpired, one-time state created by an authenticated session.
