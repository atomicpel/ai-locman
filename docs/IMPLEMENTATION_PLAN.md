# AI Locman — implementation roadmap

## Stage 0 — foundation (v0.2.0)
- [x] TypeScript/Fastify API scaffold and PostgreSQL schema.
- [x] OpenRouter-backed project chat endpoint with persisted messages.
- [x] Project create/list endpoints.
- [x] Android Compose client can create a project and send/receive chat messages.
- [x] Android debug APK build verified in GitHub Actions.
- [x] Backend and Agent Core TypeScript typechecks verified in GitHub Actions.
- [ ] Backend integration tests and runtime deployment test.
- [ ] Add real authentication before any remote deployment.

## Stage 1 — mobile workspace
- [x] Project list/create/switch in Android (local and Backend modes).
- [x] Conversation history: create/open/rename/delete and restore after app restart.
- [x] Project-scoped memory: architecture, decisions and knowledge; injected into model context.
- [x] OpenRouter model catalog search and per-project model defaults (local and Backend).
- [x] Streaming token display in Local AI mode.
- [x] Backend task list/status/cancellation and open-result flow.
- [ ] File/image attachments and persistence.
- [ ] Streaming delivery for Backend mode and worker tasks.
- [ ] Android connection-health screen, automatic reconnect and offline retry queue.
- [ ] Push notifications for completed/failed background tasks.

## Stage 2 — GitHub integration
- [x] GitHub App installation flow with one-time state and server-side installation validation.
- [x] Server-side installation-token creation; no GitHub token is sent to Android or stored in the database.
- [x] Read-only API for installed repositories, branches, contents, commits, PRs, Actions runs and branch comparison.
- [x] Android repository picker, branch/file browser, commits, Pull requests, Actions runs, branch comparison and project-to-repository binding.
- [ ] Agent-visible repository browser and task-scoped workspace.
- [ ] Feature-branch writes, commits and PR creation with explicit approvals.

## Stage 3 — autonomous agent
- [x] Redis/BullMQ durable queue, PostgreSQL task records, status polling and cancellation.
- [ ] Planner → implementer → independent reviewer → test/fix loop. Current worker performs one OpenRouter completion only; it is not yet an autonomous coding agent.
- [ ] Tool registry with schemas, permission policy, approvals and audit trail.
- [ ] Checkpoints and reliable resume after worker restart.

## Stage 4 — isolated build workers
- Ephemeral non-root workers with CPU/RAM/disk/time limits.
- No Docker socket, host mounts, metadata access or internal network access.
- Workspace scoped to one task; artifact scanning and cleanup.

## Stage 5 — production hardening
- OIDC/device auth, per-user authorization, encrypted credentials, TLS, rate limits.
- WebSocket event delivery plus push notifications.
- Backups, observability, quotas and disaster recovery.
