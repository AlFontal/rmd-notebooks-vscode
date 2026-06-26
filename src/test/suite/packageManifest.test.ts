import { strict as assert } from "node:assert";
import packageJson from "../../../package.json";

describe("package manifest", () => {
  it("keeps vscode-R as a Marketplace extension dependency", () => {
    assert.ok(packageJson.extensionDependencies.includes("REditorSupport.r"));
  });

  it("makes Rmd Notebooks the default editor for contributed notebook files", () => {
    assert.equal(packageJson.contributes.notebooks[0].priority, "default");
  });
});
