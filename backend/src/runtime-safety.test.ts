import test from "node:test";
import assert from "node:assert/strict";
import { assertDevelopmentOnlyRuntime } from "./runtime-safety.js";

test("allows only explicitly declared local development", () => {
  assert.doesNotThrow(() => assertDevelopmentOnlyRuntime("development"));
});

test("refuses production, test, staging, and an unset environment", () => {
  for (const value of ["production", "test", "staging", ""]) {
    assert.throws(
      () => assertDevelopmentOnlyRuntime(value),
      /development-only/
    );
  }
  assert.throws(() => assertDevelopmentOnlyRuntime(undefined), /development-only/);
});
