import test from "node:test";
import assert from "node:assert/strict";
import {
  createSandboxController,
  SandboxRuntimeUnavailableError,
} from "./sandbox-controller.js";

const validRequest = {
  taskId: "3d594650-3436-4a4e-8f9b-9bfe8fcd4a11",
  projectId: "b9f9f6f0-5d8d-4e47-a8ec-8b3c9f3d3b21",
  repository: "atomicpel/ai-locman",
  revision: "0123456789abcdef0123456789abcdef01234567",
  profile: "node_test",
  artifactPaths: ["artifacts/report.txt"],
};

test("default sandbox controller is explicitly unavailable", () => {
  const controller = createSandboxController();
  assert.equal(controller.available, false);
});

test("valid requests fail closed when no isolated runtime exists", async () => {
  const controller = createSandboxController();
  await assert.rejects(
    controller.run(validRequest),
    (error: unknown) =>
      error instanceof SandboxRuntimeUnavailableError &&
      error.code === "SANDBOX_RUNTIME_UNAVAILABLE",
  );
});

test("malformed requests are rejected before the unavailable-runtime response", async () => {
  const controller = createSandboxController();
  await assert.rejects(
    controller.run({ ...validRequest, revision: "main" }),
    (error: unknown) => error instanceof Error && error.name === "ZodError",
  );
});

test("sandbox controller rejects artifact traversal even while disabled", async () => {
  const controller = createSandboxController();
  await assert.rejects(
    controller.run({ ...validRequest, artifactPaths: ["../outside.txt"] }),
    (error: unknown) => error instanceof Error && error.name === "ZodError",
  );
});

test("sandbox controller enforces the artifact count limit", async () => {
  const controller = createSandboxController();
  await assert.rejects(
    controller.run({
      ...validRequest,
      artifactPaths: Array.from({ length: 33 }, (_, index) => `artifacts/${index}.txt`),
    }),
    (error: unknown) => error instanceof Error && error.name === "ZodError",
  );
});
