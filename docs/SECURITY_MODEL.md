# Security model

## Current MVP limitation
The v0.2.0 backend uses a fixed development owner (local-dev-user) and does not authenticate callers. It is suitable only for trusted local development. Do not publish port 8080 to the internet.

## Before remote deployment
1. Add OIDC login and device/session tokens; authorize every project, conversation, task and artifact by owner.
2. Store provider credentials encrypted at rest; never return secrets to Android.
3. Enforce TLS, origin allowlists, rate limits, request size limits and audit events.
4. Require explicit approval for deleting repositories, merging PRs, pushing to protected/default branches, changing secrets or deploying production.
5. Run code-execution tasks in disposable non-root sandboxes with strict resource quotas.
6. Deny access to host sockets, host filesystem, metadata endpoints, private/internal networks and unrelated workspaces.
7. Treat repository files, model responses and tool output as untrusted data.

## Approval policy
- Read repository / inspect diff: allowed after repository connection.
- Create feature branch / edit task workspace / run tests: task-scoped permission.
- Push feature branch / create PR: approval required by default.
- Push default branch / merge PR / delete repo / change secrets / deploy production: always require fresh explicit approval.

## Project isolation
Every query must be authorized against the authenticated user and active project. Cross-project context is disabled by default.
