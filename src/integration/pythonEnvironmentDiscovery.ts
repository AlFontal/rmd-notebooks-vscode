import * as vscode from "vscode";
import { realpath } from "node:fs/promises";
import * as path from "node:path";
import { PythonEnvironment, PythonEnvironmentApi, PythonEnvironments } from "@vscode/python-environments";
import { mergePythonRuntimes, PythonLaunchDescriptor } from "../execution/pythonRuntimeTypes";
import { discoverPythonKernelspecs } from "./jupyterKernelspecDiscovery";

export interface PythonRuntimeCatalogState {
  available: boolean;
  environments: number;
  kernelspecs: number;
  error?: string;
}

export class PythonEnvironmentDiscovery implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly environmentByRuntimeId = new Map<string, PythonEnvironment>();
  private api: PythonEnvironmentApi | undefined;
  private runtimes: PythonLaunchDescriptor[] = [];
  private refreshPromise: Promise<void> | undefined;
  private state: PythonRuntimeCatalogState = {
    available: false,
    environments: 0,
    kernelspecs: 0
  };

  public readonly onDidChangeRuntimes = this.changeEmitter.event;

  public async initialize(): Promise<void> {
    try {
      this.api = await PythonEnvironments.api();
      this.disposables.push(
        this.api.onDidChangeEnvironments(() => void this.refresh()),
        this.api.onDidChangeEnvironment(() => this.changeEmitter.fire())
      );
    } catch (error) {
      this.state = {
        available: false,
        environments: 0,
        kernelspecs: 0,
        error: toErrorMessage(error)
      };
    }
    await this.refresh();
  }

  public dispose(): void {
    this.disposables.forEach((disposable) => disposable.dispose());
    this.changeEmitter.dispose();
  }

  public getState(): PythonRuntimeCatalogState {
    return { ...this.state };
  }

  public getRuntimes(resource?: vscode.Uri): PythonLaunchDescriptor[] {
    const additions: PythonLaunchDescriptor[] = [];
    const configuredPath = vscode.workspace
      .getConfiguration("rmdNotebooks", resource)
      .get<string>("python.path", "")
      .trim();
    if (configuredPath) {
      additions.push({
        id: `configured:${configuredPath}`,
        label: "Configured Python",
        description: "rmdNotebooks.python.path",
        detail: configuredPath,
        source: "configured",
        executable: configuredPath,
        prefixArgs: [],
        renderPythonPath: configuredPath,
        kernelspecNames: []
      });
    }

    const fallbackExecutable = process.platform === "win32" ? "python" : "python3";
    additions.push({
      id: `fallback:${fallbackExecutable}`,
      label: `Default ${fallbackExecutable}`,
      description: "PATH fallback",
      detail: fallbackExecutable,
      source: "fallback",
      executable: fallbackExecutable,
      prefixArgs: [],
      renderPythonPath: fallbackExecutable,
      kernelspecNames: []
    });
    return [...this.runtimes, ...additions];
  }

  public async getActiveEnvironmentId(resource?: vscode.Uri): Promise<string | undefined> {
    const environment = await this.api?.getEnvironment(resource);
    return environment ? environmentRuntimeId(environment) : undefined;
  }

  public async refresh(): Promise<void> {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }
    this.refreshPromise = this.performRefresh().finally(() => {
      this.refreshPromise = undefined;
    });
    return this.refreshPromise;
  }

  public async installIPython(runtimeId: string): Promise<boolean> {
    const environment = this.environmentByRuntimeId.get(runtimeId);
    if (!this.api || !environment) {
      return false;
    }
    await this.api.managePackages(environment, {
      install: ["ipython"],
      showSkipOption: true
    });
    return true;
  }

  private async performRefresh(): Promise<void> {
    let environments: PythonLaunchDescriptor[] = [];
    let environmentError: string | undefined;
    this.environmentByRuntimeId.clear();

    if (this.api) {
      try {
        await this.api.refreshEnvironments(undefined);
        const discovered = await this.api.getEnvironments("all");
        const resolved = await Promise.all(
          discovered.map(async (environment) =>
            (await this.api?.resolveEnvironment(environment.environmentPath)) ?? environment
          )
        );
        const environmentRuntimes = await Promise.all(resolved.map((environment) => toRuntimeDescriptor(environment)));
        environments = environmentRuntimes.flatMap((runtime, index) => {
          if (!runtime) {
            return [];
          }
          this.environmentByRuntimeId.set(runtime.id, resolved[index]);
          return [runtime];
        });
      } catch (error) {
        environmentError = toErrorMessage(error);
      }
    }

    const kernelspecs = await discoverPythonKernelspecs();
    this.runtimes = mergePythonRuntimes(environments, kernelspecs);
    this.state = {
      available: Boolean(this.api) || kernelspecs.length > 0,
      environments: environments.length,
      kernelspecs: kernelspecs.length,
      error: environmentError ?? (this.api ? undefined : this.state.error)
    };
    this.changeEmitter.fire();
  }
}

async function toRuntimeDescriptor(environment: PythonEnvironment): Promise<PythonLaunchDescriptor | undefined> {
  const run = environment.execInfo.activatedRun ?? environment.execInfo.run;
  if (!run?.executable) {
    return undefined;
  }
  const rawRenderPythonPath = environment.execInfo.run.executable;
  const renderPythonPath = path.isAbsolute(rawRenderPythonPath)
    ? await realpath(rawRenderPythonPath).catch(() => rawRenderPythonPath)
    : rawRenderPythonPath;
  const executable = run.executable === rawRenderPythonPath ? renderPythonPath : run.executable;
  return {
    id: environmentRuntimeId(environment),
    label: environment.displayName || environment.name || "Python",
    description: environment.description ?? formatGroup(environment.group),
    detail: environment.displayPath || renderPythonPath,
    source: "environment",
    executable,
    prefixArgs: [...(run.args ?? [])],
    renderPythonPath,
    environmentId: environmentRuntimeId(environment),
    kernelspecNames: []
  };
}

function environmentRuntimeId(environment: PythonEnvironment): string {
  return `environment:${environment.envId.managerId}:${environment.envId.id}`;
}

function formatGroup(group: PythonEnvironment["group"]): string | undefined {
  if (!group) {
    return undefined;
  }
  return typeof group === "string" ? group : group.description ?? group.name;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
