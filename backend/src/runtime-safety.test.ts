import test from "node:test";
import assert from "node:assert/strict";
import { assertDevelopmentOnlyRuntime } from "./runtime-safety.js";

test("allows only explicitly declared local development and test environments", () => {
  assert.doesNotThrow(() => assertDevelopmentOnlyRuntime("development"));
  assert.doesNotThrow(() => assertDevelopmentOnlyRuntime("test"));
});

test("refuses production and an unset environment", () => {
  for (const value of ["production", "staging", ""]) {
    assert.throws(
      () => assertDevelopmentOnlyRuntime(value),
      /development-only/
    );
  }
  assert.throws(() => assertDevelopmentOnlyRuntime(undefined), /development-only/);
});
