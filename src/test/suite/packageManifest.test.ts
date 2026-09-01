import { strict as assert } from "node:assert";
import packageJson from "../../../package.json";

describe("package manifest", () => {
  it("targets the global Python Environments API baseline", () => {
    assert.equal(packageJson.engines.vscode, "^1.110.0");
  });

  it("keeps vscode-R as a Marketplace extension dependency", () => {
    assert.ok(packageJson.extensionDependencies.includes("REditorSupport.r"));
  });

  it("offers the Python extension for automatic environment discovery", () => {
    assert.ok(packageJson.extensionPack.includes("ms-python.python"));
    assert.ok(packageJson.extensionDependencies.includes("ms-python.vscode-python-envs"));
  });

  it("makes Rmd Notebooks the default editor for contributed notebook files", () => {
    assert.equal(packageJson.contributes.notebooks[0].priority, "default");
  });

  it("contributes an inline R execution command", () => {
    assert.ok(packageJson.contributes.commands.some((entry) => entry.command === "rmdNotebooks.runInlineCell"));
  });

  it("contributes Python interpreter settings", () => {
    const properties = packageJson.contributes.configuration.properties;
    assert.ok(properties["rmdNotebooks.python.path"]);
    assert.deepEqual(properties["rmdNotebooks.python.args"].default, ["-u"]);
    assert.equal(properties["rmdNotebooks.python.startupTimeoutMs"].default, 30000);
  });

  it("keeps Python environment selection visible in qmd notebooks", () => {
    assert.ok(packageJson.contributes.commands.some((entry) => entry.command === "rmdNotebooks.selectPythonEnvironment"));
    assert.ok(packageJson.contributes.commands.some((entry) => entry.command === "rmdNotebooks.refreshPythonEnvironments"));
    assert.ok(
      packageJson.contributes.menus["notebook/toolbar"].some(
        (entry) => entry.command === "rmdNotebooks.selectPythonEnvironment" && entry.when.endsWith("resourceExtname == .qmd")
      )
    );
  });

  it("contributes HTML preview for both Rmd and qmd notebooks", () => {
    assert.ok(packageJson.contributes.commands.some((entry) => entry.command === "rmdNotebooks.previewHtml"));
    const previewMenus = packageJson.contributes.menus["notebook/toolbar"].filter(
      (entry) => entry.command === "rmdNotebooks.previewHtml"
    );
    assert.equal(previewMenus.length, 2);
    assert.ok(previewMenus.some((entry) => entry.when.includes("resourceExtname =~")));
    assert.ok(previewMenus.some((entry) => entry.when.endsWith("resourceExtname == .qmd")));
  });
});
