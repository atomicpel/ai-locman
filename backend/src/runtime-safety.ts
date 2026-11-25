/**
 * This backend still uses a shared development owner identity. Only explicitly
 * declared local development and test environments may start.
 */
export function assertDevelopmentOnlyRuntime(nodeEnv: string | undefined): void {
  if (nodeEnv !== "development" && nodeEnv !== "test") {
    throw new Error(
      "AI Locman backend is development-only: set NODE_ENV=development for local use; production/authenticated runtime is not implemented."
    );
  }
}
