import { strict as assert } from "node:assert";
import {
  controllerIdForRuntime,
  filterPythonRuntimes,
  mergePythonRuntimes,
  normalizePythonPath,
  PythonLaunchDescriptor,
  resolvePythonRuntimePreference
} from "../../execution/pythonRuntimeTypes";
import { parsePythonKernelspecs } from "../../integration/jupyterKernelspecDiscovery";

describe("Python runtime catalog", () => {
  it("normalizes Windows interpreter paths", () => {
    assert.equal(normalizePythonPath("C:\\Env\\python.exe", "win32"), "c:/env/python.exe");
  });

  it("uses stable controller ids", () => {
    assert.equal(controllerIdForRuntime("env:one"), controllerIdForRuntime("env:one"));
    assert.notEqual(controllerIdForRuntime("env:one"), controllerIdForRuntime("env:two"));
  });

  it("fuzzy-filters by environment name, version, manager, and path", () => {
    const rapid = {
      ...runtime("rapid", "/Users/me/miniconda3/envs/rapid-e/bin/python", "environment"),
      label: "Python 3.10.12 (rapid-e)",
      description: "Conda"
    };
    const spatial = {
      ...runtime("spatial", "/Users/me/miniconda3/envs/geospatial/bin/python", "environment"),
      label: "Python 3.11.13 (geospatial-stuff)",
      description: "Conda"
    };
    assert.deepEqual(filterPythonRuntimes([rapid, spatial], "rapid").map((entry) => entry.id), ["rapid"]);
    assert.deepEqual(filterPythonRuntimes([rapid, spatial], "rpd").map((entry) => entry.id), ["rapid"]);
    assert.deepEqual(filterPythonRuntimes([rapid, spatial], "3.11 conda").map((entry) => entry.id), ["spatial"]);
    assert.deepEqual(filterPythonRuntimes([rapid, spatial], "geospatial/bin").map((entry) => entry.id), ["spatial"]);
  });

  it("deduplicates kernelspecs against environments while retaining the kernel name", () => {
    const environment = runtime("environment:one", "/env/bin/python", "environment");
    const kernelspec = {
      ...runtime("kernelspec:python3", "/env/bin/python", "kernelspec"),
      kernelspecNames: ["python3"]
    };
    const merged = mergePythonRuntimes([environment], [kernelspec]);
    assert.equal(merged.length, 1);
    assert.deepEqual(merged[0].kernelspecNames, ["python3"]);
  });

  it("applies persisted, YAML, active, configured, and fallback precedence", () => {
    const persisted = runtime("persisted", "/persisted/python", "environment");
    const yaml = { ...runtime("yaml", "/yaml/python", "kernelspec"), kernelspecNames: ["python3"] };
    const active = { ...runtime("active", "/active/python", "environment"), environmentId: "active-env" };
    const configured = runtime("configured", "/configured/python", "configured");
    const fallback = runtime("fallback", "python3", "fallback");
    const runtimes = [persisted, yaml, active, configured, fallback];

    const mismatch = resolvePythonRuntimePreference(runtimes, {
      persistedId: "persisted",
      yamlKernelName: "python3",
      activeEnvironmentId: "active-env"
    });
    assert.equal(mismatch.runtime?.id, "persisted");
    assert.equal(mismatch.mismatch, true);
    assert.equal(resolvePythonRuntimePreference(runtimes, { yamlKernelName: "python3" }).runtime?.id, "yaml");
    assert.equal(resolvePythonRuntimePreference(runtimes, { activeEnvironmentId: "active-env" }).runtime?.id, "active");
    assert.equal(resolvePythonRuntimePreference([configured, fallback], {}).runtime?.id, "configured");
    assert.equal(resolvePythonRuntimePreference([fallback], {}).runtime?.id, "fallback");
  });

  it("parses Python kernelspecs and ignores other languages", () => {
    const runtimes = parsePythonKernelspecs(JSON.stringify({
      kernelspecs: {
        python3: {
          resource_dir: "/kernels/python3",
          spec: {
            argv: ["/env/bin/python", "-m", "ipykernel_launcher", "-f", "{connection_file}"],
            display_name: "Project Python",
            language: "python"
          }
        },
        ir: {
          spec: { argv: ["R", "--slave"], display_name: "R", language: "R" }
        }
      }
    }));
    assert.equal(runtimes.length, 1);
    assert.equal(runtimes[0].label, "Project Python");
    assert.equal(runtimes[0].executable, "/env/bin/python");
    assert.deepEqual(runtimes[0].kernelspecNames, ["python3"]);
  });
});

function runtime(
  id: string,
  executable: string,
  source: PythonLaunchDescriptor["source"]
): PythonLaunchDescriptor {
  return {
    id,
    label: id,
    source,
    executable,
    prefixArgs: [],
    renderPythonPath: executable,
    kernelspecNames: []
  };
}
