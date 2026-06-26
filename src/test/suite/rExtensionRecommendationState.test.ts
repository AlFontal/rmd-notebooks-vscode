import { strict as assert } from "node:assert";
import {
  isPositronHost,
  shouldRecommendRExtension
} from "../../../src/integration/rExtensionRecommendationState";

describe("rExtensionRecommendationState", () => {
  it("detects Positron hosts by app name or URI scheme", () => {
    assert.equal(isPositronHost({ appName: "Positron", uriScheme: "vscode" }), true);
    assert.equal(isPositronHost({ appName: "Code", uriScheme: "positron" }), true);
    assert.equal(isPositronHost({ appName: "Visual Studio Code", uriScheme: "vscode" }), false);
  });

  it("recommends vscode-R only for non-Positron hosts without a stored choice", () => {
    const host = { appName: "VSCodium", uriScheme: "vscode" };

    assert.equal(shouldRecommendRExtension(host, false, undefined), true);
    assert.equal(shouldRecommendRExtension(host, true, undefined), false);
    assert.equal(shouldRecommendRExtension(host, false, "dismissed"), false);
    assert.equal(shouldRecommendRExtension(host, false, "never"), false);
    assert.equal(shouldRecommendRExtension({ appName: "Positron", uriScheme: "positron" }, false, undefined), false);
  });
});
