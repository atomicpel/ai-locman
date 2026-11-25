/**
 * The current owner identity is a development placeholder. Fail closed rather than
 * accidentally exposing unauthenticated project and GitHub APIs in production.
 */
export function assertDevelopmentOnlyRuntime(nodeEnv: string | undefined): void {
  if (nodeEnv === "production") {
    throw new Error(
      "AI Locman backend is development-only: authenticated owner identity is not configured."
    );
  }
}
