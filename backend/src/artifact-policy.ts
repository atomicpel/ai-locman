import { z } from "zod";
import { executionRequestSchema, EXECUTION_LIMITS, isSafeArtifactPath } from "./execution-policy.js";

const MAX_ARTIFACT_COUNT = 32;
const MAX_SINGLE_ARTIFACT_BYTES = 100 * 1024 * 1024;
const sha256 = z.string().regex(/^[a-f0-9]{64}$/i);
const artifactSchema = z.object({
  path: z.string().min(1).max(240),
  bytes: z.number().int().min(0).max(MAX_SINGLE_ARTIFACT_BYTES),
  sha256,
  mediaType: z.string().min(1).max(127)
}).strict();

export type ArtifactDescriptor = z.infer<typeof artifactSchema>;

/**
 * Validate untrusted sandbox metadata before persistence or download.
 * Media types are descriptive only; callers must never use them to execute/open content.
 */
export function validateArtifactManifest(requestInput: unknown, manifestInput: unknown) {
  const request = executionRequestSchema.parse(requestInput);
  const manifest = z.array(artifactSchema).max(MAX_ARTIFACT_COUNT).parse(manifestInput);
  const allowed = new Set(request.artifactPaths);
  const seen = new Set<string>();
  let totalBytes = 0;

  for (const artifact of manifest) {
    if (!isSafeArtifactPath(artifact.path) || !allowed.has(artifact.path)) {
      throw new Error("Artifact path was not requested or is unsafe");
    }
    if (seen.has(artifact.path)) throw new Error("Duplicate artifact path");
    seen.add(artifact.path);
    totalBytes += artifact.bytes;
    if (totalBytes > EXECUTION_LIMITS.artifactBytes) {
      throw new Error("Artifact manifest exceeds the total size limit");
    }
  }

  return Object.freeze({
    artifacts: Object.freeze(manifest.map((item) => Object.freeze({ ...item }))),
    totalBytes
  });
}
