import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { PythonLaunchDescriptor } from "../execution/pythonRuntimeTypes";

const execFileAsync = promisify(execFile);

interface KernelspecListPayload {
  kernelspecs?: Record<string, {
    resource_dir?: string;
    spec?: {
      argv?: unknown[];
      display_name?: unknown;
      language?: unknown;
      env?: Record<string, unknown>;
      metadata?: {
        vscode?: {
          interpreter?: {
            path?: unknown;
          };
        };
      };
    };
  }>;
}

export async function discoverPythonKernelspecs(): Promise<PythonLaunchDescriptor[]> {
  try {
    const { stdout } = await execFileAsync("jupyter", ["kernelspec", "list", "--json"], {
      timeout: 15000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true
    });
    const parsed = parsePythonKernelspecs(stdout);
    return Promise.all(parsed.map(async (runtime) => {
      const executable = await resolveExecutable(runtime.executable);
      return {
        ...runtime,
        executable,
        renderPythonPath: executable
      };
    }));
  } catch {
    return [];
  }
}

async function resolveExecutable(executable: string): Promise<string> {
  try {
    if (path.isAbsolute(executable)) {
      return await realpath(executable);
    }
    const command = process.platform === "win32" ? "where" : "which";
    const { stdout } = await execFileAsync(command, [executable], {
      timeout: 5000,
      windowsHide: true
    });
    const resolved = stdout.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim();
    return resolved ? await realpath(resolved).catch(() => resolved) : executable;
  } catch {
    return executable;
  }
}

export function parsePythonKernelspecs(raw: string): PythonLaunchDescriptor[] {
  let payload: KernelspecListPayload;
  try {
    payload = JSON.parse(raw) as KernelspecListPayload;
  } catch {
    return [];
  }

  const runtimes: PythonLaunchDescriptor[] = [];
  for (const [name, entry] of Object.entries(payload.kernelspecs ?? {})) {
    const spec = entry.spec;
    const argv = Array.isArray(spec?.argv) ? spec.argv.filter((value): value is string => typeof value === "string") : [];
    if (String(spec?.language ?? "").toLowerCase() !== "python" || argv.length === 0) {
      continue;
    }

    const metadataPath = spec?.metadata?.vscode?.interpreter?.path;
    const interpreterPath = typeof metadataPath === "string" && metadataPath.trim().length > 0
      ? metadataPath
      : argv[0];
    const prefixEnd = argv.findIndex((value) => value === "-m" || value === "-f" || value.includes("{connection_file}"));
    const prefixArgs = prefixEnd > 1 ? argv.slice(1, prefixEnd) : [];
    const environmentVariables = Object.fromEntries(
      Object.entries(spec?.env ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string")
    );

    runtimes.push({
      id: `kernelspec:${name}:${entry.resource_dir ?? ""}`,
      label: typeof spec?.display_name === "string" ? spec.display_name : name,
      description: "Jupyter kernelspec",
      detail: entry.resource_dir,
      source: "kernelspec",
      executable: interpreterPath,
      prefixArgs,
      renderPythonPath: interpreterPath,
      environmentVariables,
      kernelspecNames: [name]
    });
  }
  return runtimes;
}
