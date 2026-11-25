import { z } from "zod";

/** Validation boundary only: no process spawning, Docker access, or repository writes. */
const uuid = z.string().uuid();
const revision = z.string().regex(/^[a-f0-9]{40}$/i);
const repository = z.string().regex(/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,99}$/)
  .refine((v) => v.split("/").every((part) => !part.includes("..") && !part.endsWith(".")));
const artifactPath = z.string().min(1).max(240).refine((v) => {
  if (v.includes("\\") || v.includes(String.fromCharCode(0)) || v.startsWith("/") || /^[A-Za-z]:/.test(v)) return false;
  return v.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
});
const profiles = {
  node_test: ["npm", ["test"]],
  node_typecheck: ["npm", ["run", "typecheck"]],
  node_build: ["npm", ["run", "build"]],
  android_unit_tests: ["./gradlew", ["testDebugUnitTest"]],
  android_debug_apk: ["./gradlew", ["assembleDebug"]],
  android_lint: ["./gradlew", ["lint"]],
} as const;
export const executionRequestSchema = z.object({
  taskId: uuid, projectId: uuid, repository, revision,
  profile: z.enum(["node_test", "node_typecheck", "node_build", "android_unit_tests", "android_debug_apk", "android_lint"]),
  artifactPaths: z.array(artifactPath).max(32).default([]),
}).strict();
export const EXECUTION_LIMITS = Object.freeze({
  cpuMillis: 2000, memoryBytes: 2147483648, processCount: 128,
  diskBytes: 4294967296, wallClockMillis: 900000, artifactBytes: 524288000,
});
export function validateExecutionRequest(input: unknown) {
  const request = executionRequestSchema.parse(input);
  const [executable, argv] = profiles[request.profile];
  return Object.freeze({
    request: Object.freeze({ ...request, artifactPaths: Object.freeze([...request.artifactPaths]) }),
    executable, argv: Object.freeze([...argv]), limits: EXECUTION_LIMITS,
  });
}
export function isSafeArtifactPath(value: string): boolean {
  return artifactPath.safeParse(value).success;
}
