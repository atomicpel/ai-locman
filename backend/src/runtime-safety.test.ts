import test from "node:test";
import assert from "node:assert/strict";
import { assertDevelopmentOnlyRuntime } from "./runtime-safety.js";

test("allows local development and test environments", () => {
  assert.doesNotThrow(() => assertDevelopmentOnlyRuntime(undefined));
  assert.doesNotThrow(() => assertDevelopmentOnlyRuntime("development"));
  assert.doesNotThrow(() => assertDevelopmentOnlyRuntime("test"));
});

test("refuses production while the API uses a shared development owner identity", () => {
  assert.throws(
    () => assertDevelopmentOnlyRuntime("production"),
    /development-only: authenticated owner identity is not configured/
  );
});
