import { strict as assert } from "node:assert";
import packageJson from "../../../package.json";

describe("package manifest", () => {
  it("keeps vscode-R as a Marketplace extension dependency", () => {
    assert.ok(packageJson.extensionDependencies.includes("REditorSupport.r"));
  });

  it("makes Rmd Notebooks the default editor for contributed notebook files", () => {
    assert.equal(packageJson.contributes.notebooks[0].priority, "default");
  });

  it("contributes an inline R execution command", () => {
    assert.ok(packageJson.contributes.commands.some((entry) => entry.command === "rmdNotebooks.runInlineCell"));
  });

  it("contributes HTML preview without duplicating Quarto's notebook button", () => {
    assert.ok(packageJson.contributes.commands.some((entry) => entry.command === "rmdNotebooks.previewHtml"));
    const previewMenus = packageJson.contributes.menus["notebook/toolbar"].filter(
      (entry) => entry.command === "rmdNotebooks.previewHtml"
    );
    assert.equal(previewMenus.length, 2);
    assert.ok(previewMenus.some((entry) => entry.when.includes("resourceExtname =~")));
    assert.ok(previewMenus.some((entry) => entry.when.includes("!rmdNotebooks.quartoExtensionInstalled")));
  });
});
