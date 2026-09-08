import { strict as assert } from "node:assert";
import { describe, it } from "mocha";
import { withCancellation, withTimeout } from "../execution/asyncPreparation";
import { CancelledExecutionError } from "../execution/executionErrors";

describe("Python asynchronous preparation", () => {
  it("bounds a provider that never responds", async () => {
    await assert.rejects(withTimeout(new Promise(() => {}), 10), /timed out/);
  });
  it("propagates provider errors", async () => {
    await assert.rejects(withTimeout(Promise.reject(new Error("provider failed"))), /provider failed/);
  });
  it("cancels without waiting for discovery", async () => {
    let cancel!: () => void;
    const result = withCancellation(new Promise(() => {}), {
      isCancellationRequested: false,
      onCancellationRequested(listener) { cancel = listener; }
    });
    cancel();
    await assert.rejects(result, CancelledExecutionError);
  });
  it("does not accept an already cancelled preparation", async () => {
    await assert.rejects(withCancellation(Promise.resolve(42), {
      isCancellationRequested: true, onCancellationRequested() {}
    }), CancelledExecutionError);
  });
});
