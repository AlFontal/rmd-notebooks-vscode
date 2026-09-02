import * as vscode from "vscode";
import { PythonEnvironment, PythonEnvironmentApi, PythonEnvironments } from "@vscode/python-environments";
import { createEnvironmentRuntime, PythonLaunchDescriptor } from "../execution/pythonRuntimeTypes";

export interface PythonRuntimeCatalogState {
  initialized: boolean;
  available: boolean;
  environments: number;
  error?: string;
}

export class PythonEnvironmentDiscovery implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly environmentByRuntimeId = new Map<string, PythonEnvironment>();
  private api: PythonEnvironmentApi | undefined;
  private runtimes: PythonLaunchDescriptor[] = [];
  private initializationPromise: Promise<void> | undefined;
  private refreshPromise: Promise<void> | undefined;
  private state: PythonRuntimeCatalogState = {
    initialized: false,
    available: false,
    environments: 0
  };

  public readonly onDidChangeRuntimes = this.changeEmitter.event;

  public ensureInitialized(): Promise<void> {
    if (!this.initializationPromise) {
      this.initializationPromise = this.initializeOnce();
    }
    return this.initializationPromise;
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
      additions.push(runtimeForPath("configured", configuredPath, "Configured Python", "rmdNotebooks.python.path"));
    }
    const quartoPython = process.env.QUARTO_PYTHON?.trim();
    if (quartoPython) {
      additions.push(runtimeForPath("environmentVariable", quartoPython, "Quarto Python", "QUARTO_PYTHON"));
    }
    const fallbackExecutable = process.platform === "win32" ? "python" : "python3";
    additions.push(runtimeForPath("fallback", fallbackExecutable, `Default ${fallbackExecutable}`, "PATH fallback"));
    return [...this.runtimes, ...additions];
  }

  public async getActiveEnvironmentId(resource?: vscode.Uri): Promise<string | undefined> {
    if (!this.state.initialized) {
      return undefined;
    }
    const environment = await this.api?.getEnvironment(resource);
    return environment ? environmentRuntimeId(environment) : undefined;
  }

  public async refresh(force = false): Promise<void> {
    await this.ensureInitialized();
    if (!force && this.refreshPromise) {
      return this.refreshPromise;
    }
    if (!this.refreshPromise) {
      this.refreshPromise = this.performRefresh(force).finally(() => {
        this.refreshPromise = undefined;
      });
    }
    return this.refreshPromise;
  }

  public async installIPython(runtimeId: string): Promise<boolean> {
    await this.ensureInitialized();
    const environment = this.environmentByRuntimeId.get(runtimeId);
    if (!this.api || !environment) {
      return false;
    }
    await this.api.managePackages(environment, { install: ["ipython"], showSkipOption: true });
    return true;
  }

  private async initializeOnce(): Promise<void> {
    try {
      this.api = await PythonEnvironments.api();
      this.disposables.push(
        this.api.onDidChangeEnvironments(() => void this.refresh(true)),
        this.api.onDidChangeEnvironment(() => this.changeEmitter.fire())
      );
      this.state = { initialized: true, available: true, environments: 0 };
      await this.performRefresh(false);
    } catch (error) {
      this.state = {
        initialized: true,
        available: false,
        environments: 0,
        error: error instanceof Error ? error.message : String(error)
      };
      this.changeEmitter.fire();
    }
  }

  private async performRefresh(force: boolean): Promise<void> {
    if (!this.api) {
      return;
    }
    try {
      if (force) {
        await this.api.refreshEnvironments(undefined);
      }
      const discovered = await this.api.getEnvironments("all");
      const resolved = await Promise.all(
        discovered.map(async (environment) =>
          (await this.api?.resolveEnvironment(environment.environmentPath)) ?? environment
        )
      );
      this.environmentByRuntimeId.clear();
      this.runtimes = resolved.flatMap((environment) => {
        const runtime = toRuntimeDescriptor(environment);
        if (!runtime) {
          return [];
        }
        this.environmentByRuntimeId.set(runtime.id, environment);
        return [runtime];
      }).sort((left, right) => left.label.localeCompare(right.label));
      this.state = {
        initialized: true,
        available: true,
        environments: this.runtimes.length
      };
      this.changeEmitter.fire();
    } catch (error) {
      this.state = {
        initialized: true,
        available: true,
        environments: 0,
        error: error instanceof Error ? error.message : String(error)
      };
      this.changeEmitter.fire();
    }
  }
}

export function toRuntimeDescriptor(environment: PythonEnvironment): PythonLaunchDescriptor | undefined {
  const run = environment.execInfo.activatedRun ?? environment.execInfo.run;
  const renderPythonPath = environment.execInfo.run.executable;
  if (!run?.executable || !renderPythonPath) {
    return undefined;
  }
  return createEnvironmentRuntime({
    id: environmentRuntimeId(environment),
    label: environment.displayName || environment.name || "Python",
    description: environment.description ?? formatGroup(environment.group),
    detail: environment.displayPath || renderPythonPath,
    executable: run.executable,
    prefixArgs: [...(run.args ?? [])],
    renderPythonPath
  });
}

function runtimeForPath(
  source: "configured" | "environmentVariable" | "fallback",
  executable: string,
  label: string,
  description: string
): PythonLaunchDescriptor {
  return {
    id: `${source}:${executable}`,
    label,
    description,
    detail: executable,
    source,
    executable,
    prefixArgs: [],
    renderPythonPath: executable
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
