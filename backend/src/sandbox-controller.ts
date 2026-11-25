import { validateExecutionRequest } from "./execution-policy.js";

export class SandboxRuntimeUnavailableError extends Error {
  readonly code = "SANDBOX_RUNTIME_UNAVAILABLE";

  constructor() {
    super("Isolated sandbox runtime is not configured; execution is disabled.");
    this.name = "SandboxRuntimeUnavailableError";
  }
}

export interface SandboxController {
  readonly available: boolean;
  run(input: unknown): Promise<never>;
}

/**
 * Safe default until a separately isolated, rootless runtime is deployed.
 * This controller validates requests but never starts a process or accesses a repository.
 */
export class DisabledSandboxController implements SandboxController {
  readonly available = false;

  async run(input: unknown): Promise<never> {
    validateExecutionRequest(input);
    throw new SandboxRuntimeUnavailableError();
  }
}

export function createSandboxController(): SandboxController {
  return new DisabledSandboxController();
}
