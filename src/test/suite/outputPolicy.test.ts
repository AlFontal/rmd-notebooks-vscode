import { strict as assert } from "node:assert";
import { getOutputPolicy, RevealMode } from "../../editor/outputPolicy";

describe("outputPolicy", () => {
  it("never reveals or shows generic error messages for notebook execution", () => {
    for (const mode of ["always", "errors", "never"] satisfies RevealMode[]) {
      assert.deepEqual(getOutputPolicy("notebook", mode, "started"), {
        reveal: false,
        showGenericError: false
      });
      assert.deepEqual(getOutputPolicy("notebook", mode, "error"), {
        reveal: false,
        showGenericError: false
      });
    }
  });

  it("preserves editor reveal modes and generic error messages", () => {
    assert.equal(getOutputPolicy("editor", "always", "started").reveal, true);
    assert.equal(getOutputPolicy("editor", "always", "success").reveal, true);
    assert.equal(getOutputPolicy("editor", "errors", "success").reveal, false);
    assert.equal(getOutputPolicy("editor", "errors", "error").reveal, true);
    assert.equal(getOutputPolicy("editor", "never", "error").reveal, false);
    assert.equal(getOutputPolicy("editor", "never", "error").showGenericError, true);
  });
});
