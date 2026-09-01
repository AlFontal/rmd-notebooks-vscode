import * as vscode from "vscode";
import { Environment, PythonExtension, ResolvedEnvironment } from "@vscode/python-extension";
import { INLINE_CHUNKS_NOTEBOOK_TYPE } from "../notebook/notebookTypes";

export interface PythonEnvironmentDescriptor {
  id: string;
  interpreterPath: string;
  label: string;
  description?: string;
  detail?: string;
}

export interface PythonEnvironmentControllerHost {
  syncPythonEnvironments(environments: readonly PythonEnvironmentDescriptor[]): void;
  setPreferredPythonEnvironment(notebook: vscode.NotebookDocument, environmentId?: string): void;
}

export class PythonEnvironmentDiscovery implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private environments: PythonEnvironmentDescriptor[] = [];
  private refreshTimer: NodeJS.Timeout | undefined;
  private pythonApi: Awaited<ReturnType<typeof PythonExtension.api>> | undefined;

  public constructor(private readonly host: PythonEnvironmentControllerHost) {}

  public async initialize(): Promise<void> {
    try {
      this.pythonApi = await PythonExtension.api();
      await this.pythonApi.ready;
      await this.pythonApi.environments.refreshEnvironments();
    } catch (error) {
      console.info("Rmd Notebooks: Python environment discovery is unavailable", error);
      this.host.syncPythonEnvironments([]);
      return;
    }

    this.disposables.push(
      this.pythonApi.environments.onDidChangeEnvironments(() => this.scheduleRefresh()),
      this.pythonApi.environments.onDidChangeActiveEnvironmentPath(() => this.refreshPreferences()),
      vscode.workspace.onDidOpenNotebookDocument((notebook) => this.refreshPreference(notebook)),
      vscode.workspace.onDidChangeNotebookDocument((event) => {
        if (event.contentChanges.length > 0 || event.cellChanges.some((change) => change.document !== undefined)) {
          this.refreshPreference(event.notebook);
        }
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("rmdNotebooks.python.path")) {
          this.refreshPreferences();
        }
      })
    );

    await this.refreshEnvironments();
  }

  public dispose(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.disposables.forEach((disposable) => disposable.dispose());
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refreshEnvironments();
    }, 100);
  }

  private async refreshEnvironments(): Promise<void> {
    if (!this.pythonApi) {
      return;
    }

    const resolved = await Promise.all(
      this.pythonApi.environments.known.map((environment) => this.resolveEnvironment(environment))
    );
    const seenPaths = new Set<string>();
    this.environments = resolved
      .filter((environment): environment is ResolvedEnvironment => environment !== undefined)
      .map(toDescriptor)
      .filter((environment) => {
        const normalizedPath = normalizePath(environment.interpreterPath);
        if (seenPaths.has(normalizedPath)) {
          return false;
        }
        seenPaths.add(normalizedPath);
        return true;
      })
      .sort((left, right) => left.label.localeCompare(right.label));

    this.host.syncPythonEnvironments(this.environments);
    this.refreshPreferences();
  }

  private async resolveEnvironment(environment: Environment): Promise<ResolvedEnvironment | undefined> {
    if (!this.pythonApi) {
      return undefined;
    }
    const resolved = await this.pythonApi.environments.resolveEnvironment(environment);
    return resolved?.executable.uri ? resolved : undefined;
  }

  private refreshPreferences(): void {
    for (const notebook of vscode.workspace.notebookDocuments) {
      this.refreshPreference(notebook);
    }
  }

  private refreshPreference(notebook: vscode.NotebookDocument): void {
    if (!this.pythonApi || notebook.notebookType !== INLINE_CHUNKS_NOTEBOOK_TYPE) {
      return;
    }

    const hasPythonCells = notebook.getCells().some(
      (cell) =>
        cell.kind === vscode.NotebookCellKind.Code &&
        ["python", "py"].includes(cell.document.languageId.toLowerCase())
    );
    if (!hasPythonCells) {
      this.host.setPreferredPythonEnvironment(notebook);
      return;
    }

    const configuredPath = vscode.workspace
      .getConfiguration("rmdNotebooks", notebook.uri)
      .get<string>("python.path", "")
      .trim();
    if (configuredPath) {
      this.host.setPreferredPythonEnvironment(notebook);
      return;
    }

    const active = this.pythonApi.environments.getActiveEnvironmentPath(notebook.uri);
    const match = this.environments.find(
      (environment) => environment.id === active.id || normalizePath(environment.interpreterPath) === normalizePath(active.path)
    );
    this.host.setPreferredPythonEnvironment(notebook, match?.id);
  }
}

function toDescriptor(environment: ResolvedEnvironment): PythonEnvironmentDescriptor {
  const interpreterPath = environment.executable.uri?.fsPath ?? environment.path;
  const version = formatVersion(environment);
  const name = environment.environment?.name?.trim();
  const label = name ? `${version} (${name})` : version;
  const tool = environment.tools[0] ?? environment.environment?.type;

  return {
    id: environment.id,
    interpreterPath,
    label,
    description: tool ? String(tool) : "Python",
    detail: interpreterPath
  };
}

function formatVersion(environment: ResolvedEnvironment): string {
  const version = environment.version;
  if (!version) {
    return "Python";
  }
  return `Python ${version.major}.${version.minor}.${version.micro}`;
}

function normalizePath(value: string): string {
  return process.platform === "win32" ? value.toLowerCase().replace(/\\/g, "/") : value;
}
