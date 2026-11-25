# Isolated execution worker contract

Status: design contract; no arbitrary command execution is enabled by this document.

## Security boundary

The API process and BullMQ coordinator MUST NOT execute repository code. A task worker may only submit a job to a separate sandbox controller. The controller creates one disposable sandbox per job and destroys it after artifact collection, timeout, cancellation, or failure.

The sandbox runtime MUST be managed outside the application containers. Do not mount /var/run/docker.sock into the API or agent worker. Do not run builds in the existing agent-worker container.

## Job envelope

Every execution request must contain:
- taskId: UUID of the owning agent task.
- projectId: UUID of the project; the controller verifies task/project ownership before provisioning.
- repository: validated owner/name identifier, resolved from the project's saved GitHub binding (never from model-generated arguments).
- revision: immutable commit SHA. Branch names are resolved before sandbox creation.
- commands: explicit argv arrays selected from a server-side allowlist. Never accept a shell command string, shell operators, pipes, redirects, or interpolated environment variables.
- limits: server-defined CPU, memory, process, disk, and wall-clock limits. The model cannot increase them.
- artifactPolicy: allowlisted output paths and maximum aggregate size.

## Required isolation

- Rootless container/VM; unprivileged UID; read-only base image.
- Fresh ephemeral workspace per task; no host mounts and no Docker socket.
- Drop all Linux capabilities; no-new-privileges; seccomp plus AppArmor/SELinux profile.
- PID, CPU, memory, disk, file-size, and wall-clock limits enforced by the runtime.
- Network disabled by default. If dependency installation is enabled, use a controlled proxy/egress allowlist; block loopback, RFC1918, link-local, cloud metadata, and other private destinations.
- No production credentials, GitHub installation private key, database URL, Redis URL, or OpenRouter key inside the sandbox.
- GitHub checkout uses a short-lived, repository-scoped read token injected only for checkout and removed before build commands.
- Artifacts are copied out through a bounded controller API, scanned, hashed, and stored outside the workspace.
- Cancellation terminates the sandbox process tree and destroys the sandbox, not merely the BullMQ job.

## Approval model

The agent may prepare a proposed diff and execution plan without applying it. Any write to a Git branch, PR creation, merge, deployment, or command outside the pre-approved test/build allowlist requires an explicit user approval record bound to:
- task ID;
- exact repository and immutable base revision;
- exact file paths/diff hash or exact argv;
- expiry time;
- one-time approval nonce.

A changed diff, revision, command, or expired approval invalidates the approval. Never interpret a general chat message such as continue as approval for a destructive operation.

## Task lifecycle

queued -> planning -> running -> waiting_approval -> testing -> reviewing -> completed

Failure, timeout, and cancellation are terminal states. Every transition and sandbox event must be appended to the task event journal. A retry gets a new sandbox and a fresh workspace; it must not reuse untrusted filesystem state.

## Implementation gates

1. Add a sandbox-controller interface and strict schemas; keep it unavailable by default.
2. Implement the controller against a rootless runtime on a dedicated host, with deny-by-default networking.
3. Add integration tests proving path traversal rejection, resource limit enforcement, cancellation, cleanup, and artifact size limits.
4. Add approval persistence and Android approval UI before enabling write operations.
5. Only then register write/build tools with the agent.

## Current limitation

The current agent worker is intentionally read-only. Until all gates above pass, it must continue to refuse repository writes, shell execution, and builds. This is a security boundary, not a missing UI toggle.