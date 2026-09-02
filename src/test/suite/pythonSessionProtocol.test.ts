import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import * as path from "node:path";

const STARTUP_ERROR_PREFIX = "RMD_NOTEBOOKS_PYTHON_STARTUP_ERROR:";

describe("Python session protocol", () => {
  it("reports missing IPython during startup instead of falling back", () => {
    const python = process.platform === "win32" ? "python" : "python3";
    const helper = path.resolve(process.cwd(), "media", "python", "rmd_notebooks_session.py");
    const result = spawnSync(python, ["-S", "-u", helper], { encoding: "utf8" });

    assert.equal(result.status, 0, result.stderr);
    const line = result.stdout.trim();
    assert.ok(line.startsWith(STARTUP_ERROR_PREFIX));
    const payload = JSON.parse(
      Buffer.from(line.slice(STARTUP_ERROR_PREFIX.length), "base64").toString("utf8")
    ) as { code?: string; message?: string };
    assert.equal(payload.code, "missing_ipython");
    assert.match(payload.message ?? "", /require IPython/i);
  });
});
