import { strict as assert } from "node:assert";
import {
  createEnvironmentRuntime,
  filterPythonRuntimes,
  normalizePythonPath,
  PythonLaunchDescriptor
} from "../../execution/pythonRuntimeTypes";

describe("Python runtime selection", () => {
  it("normalizes Windows paths only for comparison", () => {
    assert.equal(normalizePythonPath("C:\\Env\\python.exe", "win32"), "c:/env/python.exe");
  });

  it("preserves the environment manager executable and venv render path verbatim", () => {
    const runtime = createEnvironmentRuntime({
      id: "environment:venv",
      label: "Project venv",
      executable: "/tmp/project/.venv/bin/python",
      renderPythonPath: "/tmp/project/.venv/bin/python"
    });
    assert.equal(runtime.executable, "/tmp/project/.venv/bin/python");
    assert.equal(runtime.renderPythonPath, "/tmp/project/.venv/bin/python");

    const activated = createEnvironmentRuntime({
      id: "environment:conda",
      label: "Conda",
      executable: "conda",
      prefixArgs: ["run", "-p", "/tmp/conda", "python"],
      renderPythonPath: "/tmp/conda/bin/python"
    });
    assert.equal(activated.executable, "conda");
    assert.deepEqual(activated.prefixArgs, ["run", "-p", "/tmp/conda", "python"]);
    assert.equal(activated.renderPythonPath, "/tmp/conda/bin/python");
  });

  it("fuzzy-filters by environment name, version, manager, and path", () => {
    const rapid = runtime("rapid", "/Users/me/miniconda3/envs/rapid-e/bin/python", "Python 3.10.12 (rapid-e)");
    rapid.description = "Conda";
    const spatial = runtime("spatial", "/Users/me/miniconda3/envs/geospatial/bin/python", "Python 3.11.13 (geospatial-stuff)");
    spatial.description = "Conda";
    assert.deepEqual(filterPythonRuntimes([rapid, spatial], "rapid").map((entry) => entry.id), ["rapid"]);
    assert.deepEqual(filterPythonRuntimes([rapid, spatial], "rpd").map((entry) => entry.id), ["rapid"]);
    assert.deepEqual(filterPythonRuntimes([rapid, spatial], "3.11 conda").map((entry) => entry.id), ["spatial"]);
    assert.deepEqual(filterPythonRuntimes([rapid, spatial], "geospatial/bin").map((entry) => entry.id), ["spatial"]);
  });
});

function runtime(id: string, executable: string, label: string): PythonLaunchDescriptor {
  return {
    id,
    label,
    source: "environment",
    executable,
    prefixArgs: [],
    renderPythonPath: executable,
    environmentId: id
  };
}
