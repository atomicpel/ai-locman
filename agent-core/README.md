# Agent Core — planned execution engine

The v0.2.0 mobile MVP uses the backend's direct OpenRouter chat path. The autonomous tool loop is intentionally not enabled yet.

Planned design:
1. Task planner creates a structured plan and risk classification.
2. Policy engine validates every requested tool and its arguments.
3. Tool executor runs only approved, task-scoped operations.
4. Reviewer checks the patch independently and tests run in a disposable worker.
5. Task state, logs, approvals and artifacts are persisted for resume/reconnect.

Never implement a generic unrestricted shell endpoint on the public API. Build workers must be isolated and short-lived.
