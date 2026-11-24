# AI Locman — implementation roadmap

## Stage 0 — foundation (v0.2.0)
- [x] TypeScript/Fastify API scaffold and PostgreSQL schema.
- [x] OpenRouter-backed project chat endpoint with persisted messages.
- [x] Project create/list endpoints.
- [x] Android Compose client can create a project and send/receive chat messages.
- [ ] Verify Android APK build in CI and run backend integration tests.
- [ ] Add real authentication before any remote deployment.

## Stage 1 — mobile workspace
- Project list/switch, conversation history, attachments, streaming responses.
- Model catalog search and per-project model defaults.
- Connection health, reconnect handling, push notifications.

## Stage 2 — GitHub integration
- GitHub App/OAuth connection with minimum permissions.
- Repository picker, branch/file browser, diffs, commits, PRs and Actions logs.
- Start on feature branches; never push directly to default branch by default.

## Stage 3 — autonomous agent
- Durable task queue and task state machine.
- Planner → implementer → independent reviewer → test/fix loop.
- Tool registry with schemas, permission policy, approvals and audit trail.
- Checkpoints and cancellation/resume.

## Stage 4 — isolated build workers
- Ephemeral non-root workers with CPU/RAM/disk/time limits.
- No Docker socket, host mounts, metadata access or internal network access.
- Workspace scoped to one task; artifact scanning and cleanup.

## Stage 5 — production hardening
- OIDC/device auth, per-user authorization, encrypted credentials, TLS, rate limits.
- WebSocket event delivery plus push notifications.
- Backups, observability, quotas and disaster recovery.
