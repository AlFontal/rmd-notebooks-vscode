import * as path from "node:path";
import * as vscode from "vscode";
import { assignChunkIdentities, createIdentitySeed } from "../document/chunkIdentity";
import { ChunkIdentitySeed, ChunkOutputRecord, ExecutableChunk, OutputItem, ParsedExecutableChunk } from "../document/chunkTypes";
import { OutputChannelController } from "../editor/outputChannelController";
import { ExecutorRegistry } from "../execution/executorRegistry";
import {
  ExecutionResult,
  InteractivePromptChoice,
  InteractivePromptRequest,
  InteractivePromptResponse,
  PlotRenderOptions
} from "../execution/executorTypes";
import { CancelledExecutionError, InteractiveExecutionError } from "../execution/executionErrors";
import { RTerminalRunner } from "../execution/rTerminalRunner";
import { PythonExecutor } from "../execution/pythonExecutor";
import {
  filterPythonRuntimes,
  PythonLaunchDescriptor
} from "../execution/pythonRuntimeTypes";
import { PythonEnvironmentDiscovery } from "../integration/pythonEnvironmentDiscovery";
import { OutputStore } from "../persistence/outputStore";
import {
  getInlineChunksMetadata,
  INLINE_CHUNKS_NOTEBOOK_TYPE,
  InlineChunksCodeCellMetadata,
  isInlineChunksNotebook,
  withInlineChunksMetadata
} from "./notebookTypes";
import { applyChunkOptionsToResult, parseChunkOptions } from "./chunkOptions";
import { buildChunkHeader, extractChunkLabel, normalizeChunkHeaderInfo, validateChunkHeaderInfo } from "./chunkHeader";
import { parseJupyterFrontmatter } from "./frontmatter";
import { buildInlineRExecutionCode, parseInlineRExpressions } from "./inlineR";

interface NotebookChunkCell {
  index: number;
  cell: vscode.NotebookCell;
  chunk: ExecutableChunk;
  sourceKind: "chunk" | "inline";
}

interface NotebookSnapshot {
  documentUri: string;
  version: number;
  chunks: NotebookChunkCell[];
  generatedAt: number;
}

type ExecuteCellOutcome = "completed" | "redirected";

export class InlineChunksNotebookRuntime implements vscode.Disposable {
  private readonly snapshots = new Map<string, NotebookSnapshot>();
  private readonly outputsByDocument = new Map<string, Map<string, ChunkOutputRecord>>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly metadataSyncInFlight = new Set<string>();
  private readonly outputSyncInFlight = new Set<string>();
  private readonly outputRestorations = new Map<string, Promise<void>>();
  private readonly notebookInitializations = new Map<string, Promise<void>>();
  private readonly inlineStaleTimers = new Map<string, NodeJS.Timeout>();
  private readonly executionAdmissions = new Map<string, Promise<void>>();
  private readonly collapsedInlineDocuments = new Set<string>();
  // Notebooks whose in-flight Run All / multi-cell run should stop before the next
  // cell. Set by interruptSession ("Stop All"), checked between cells in the run loops.
  private readonly runsToAbort = new Set<string>();
  private testPromptResponses: InteractivePromptResponse[] = [];
  private readonly testPromptRequests: InteractivePromptRequest[] = [];
  private readonly controller: vscode.NotebookController;
  private readonly pythonEnvironmentStatus: vscode.StatusBarItem;

  public constructor(
    private readonly outputStore: OutputStore,
    private readonly executorRegistry: ExecutorRegistry,
    private readonly outputChannelController: OutputChannelController,
    private readonly terminalRunner: RTerminalRunner,
    private readonly pythonExecutor: PythonExecutor,
    private readonly pythonDiscovery: PythonEnvironmentDiscovery,
    private readonly workspaceState: vscode.Memento
  ) {
    this.controller = vscode.notebooks.createNotebookController(
      "rmd-notebooks-vscode-controller",
      INLINE_CHUNKS_NOTEBOOK_TYPE,
      "Rmd Notebooks"
    );
    this.controller.supportedLanguages = ["r", "python", "markdown"];
    this.controller.supportsExecutionOrder = true;
    this.controller.executeHandler = async (cells, notebook) => {
      const documentUri = notebook.uri.toString();
      this.runsToAbort.delete(documentUri);
      for (const cell of cells) {
        if (this.runsToAbort.has(documentUri)) {
          break;
        }
        await this.executeCell(notebook, cell, cell.index);
      }
      this.runsToAbort.delete(documentUri);
    };
    this.pythonEnvironmentStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    this.pythonEnvironmentStatus.name = "Rmd Notebooks Python Environment";
    this.pythonEnvironmentStatus.command = "rmdNotebooks.selectPythonEnvironment";
    // No interruptHandler on purpose: with one, VS Code never fires per-cell
    // cancellation tokens (it would interrupt the whole session instead). Relying on
    // the tokens lets stopping one cell cancel just that cell, while leaving the
    // others running or queued. "Stop All" is offered separately via interruptSession.
  }

  public async initialize(): Promise<void> {
    this.disposables.push(
      this.controller,
      vscode.workspace.onDidOpenNotebookDocument((notebook) => void this.beginNotebookInitialization(notebook)),
      vscode.workspace.onDidChangeNotebookDocument((event) => void this.handleNotebookChanged(event)),
      vscode.workspace.onDidCloseNotebookDocument((notebook) => void this.handleNotebookClosed(notebook)),
      vscode.window.onDidChangeActiveNotebookEditor((editor) => {
        this.updatePythonEnvironmentStatus(editor);
        if (editor && isInlineChunksNotebook(editor.notebook)) {
          if (hasPythonCells(editor.notebook)) {
            void this.ensurePythonRuntimeSelected(editor.notebook);
          }
          void this.restoreOutputsToNotebook(editor.notebook)
            .then(() => this.collapseInlineInputs(editor.notebook))
            .catch((error) => console.error("Unable to restore Rmd notebook outputs", error));
        }
      })
    );
    this.disposables.push(
      this.pythonDiscovery.onDidChangeRuntimes(() => {
        this.logPythonDiscoveryState();
        this.updatePythonEnvironmentStatus(vscode.window.activeNotebookEditor);
      }),
      this.pythonExecutor.onDidUsePythonFallback((event) => void this.handleMissingIPython(event))
    );
    this.disposables.push(this.pythonEnvironmentStatus);
    this.updatePythonEnvironmentStatus(vscode.window.activeNotebookEditor);

    for (const notebook of vscode.workspace.notebookDocuments) {
      await this.beginNotebookInitialization(notebook);
    }
  }

  private logPythonDiscoveryState(): void {
    const state = this.pythonDiscovery.getState();
    const detail = state.error
      ? `Discovery error: ${state.error}`
      : `Found ${state.environments} Python environment(s).`;
    this.outputChannelController.logDiagnostic(detail);
  }

  private updatePythonEnvironmentStatus(editor?: vscode.NotebookEditor): void {
    if (!editor || !isInlineChunksNotebook(editor.notebook)) {
      this.pythonEnvironmentStatus.hide();
      return;
    }
    const hasPythonCells = editor.notebook.getCells().some(
      (cell) =>
        cell.kind === vscode.NotebookCellKind.Code &&
        ["python", "py"].includes(cell.document.languageId.toLowerCase())
    );
    if (!hasPythonCells) {
      this.pythonEnvironmentStatus.hide();
      return;
    }

    const runtime = this.getPersistedPythonRuntime(editor.notebook.uri);
    const state = this.pythonDiscovery.getState();
    this.pythonEnvironmentStatus.text = `$(server-environment) Python: ${runtime?.label ?? "Select Environment"}`;
    this.pythonEnvironmentStatus.tooltip = runtime
      ? `${runtime.renderPythonPath}\nClick to select another Python environment.`
      : `${state.environments} environment(s) discovered. Click to select.`;
    this.pythonEnvironmentStatus.show();
  }

  private getPersistedPythonRuntime(uri: vscode.Uri): PythonLaunchDescriptor | undefined {
    const value = this.workspaceState.get<unknown>(runtimeSelectionKey(uri));
    return isPythonLaunchDescriptor(value) ? value : undefined;
  }

  private async ensurePythonRuntimeSelected(notebook: vscode.NotebookDocument): Promise<void> {
    if (this.pythonExecutor.getSelectedInterpreter(notebook.uri.toString())) {
      return;
    }
    const persisted = this.getPersistedPythonRuntime(notebook.uri);
    if (persisted) {
      await this.pythonExecutor.selectInterpreter(notebook.uri.toString(), toInterpreterSelection(persisted));
      this.updatePythonEnvironmentStatus(vscode.window.activeNotebookEditor);
      return;
    }

    await this.pythonDiscovery.ensureInitialized();
    const runtimes = this.pythonDiscovery.getRuntimes(notebook.uri);
    const activeEnvironmentId = await this.pythonDiscovery.getActiveEnvironmentId(notebook.uri);
    const selected =
      runtimes.find((runtime) => runtime.environmentId === activeEnvironmentId) ??
      runtimes.find((runtime) => runtime.source === "configured") ??
      runtimes.find((runtime) => runtime.source === "environmentVariable") ??
      runtimes.find((runtime) => runtime.source === "fallback");
    if (selected) {
      await this.selectPythonRuntime(notebook, selected);
    }
  }

  public async selectPythonEnvironment(documentUri?: string): Promise<void> {
    const notebook = this.resolveNotebook(documentUri);
    if (!notebook) {
      void vscode.window.showWarningMessage("Rmd Notebooks: open a qmd notebook to select Python.");
      return;
    }
    await this.pythonDiscovery.ensureInitialized();
    const runtimes = this.pythonDiscovery.getRuntimes(notebook.uri);
    const selectedId = this.getPersistedPythonRuntime(notebook.uri)?.id;
    type PickerItem = vscode.QuickPickItem & {
      runtime?: PythonLaunchDescriptor;
      action?: "refresh" | "path";
    };
    const toItems = (filtered: readonly PythonLaunchDescriptor[]): PickerItem[] => [
      ...filtered.map((runtime) => ({
        label: `${runtime.id === selectedId ? "$(check) " : ""}${runtime.label}`,
        description: runtime.description,
        detail: runtime.detail ?? runtime.renderPythonPath,
        runtime
      })),
      { label: "$(refresh) Refresh Python Environments", action: "refresh", alwaysShow: true },
      { label: "$(file-code) Enter Python Executable Path…", action: "path", alwaysShow: true }
    ];
    const picker = vscode.window.createQuickPick<PickerItem>();
    picker.title = "Select Python Environment";
    picker.placeholder = "Type an environment name, version, manager, or path";
    picker.matchOnDescription = true;
    picker.matchOnDetail = true;
    picker.items = toItems(runtimes);
    const pickerDisposables: vscode.Disposable[] = [];
    const picked = await new Promise<PickerItem | undefined>((resolve) => {
      pickerDisposables.push(
        picker.onDidChangeValue((value) => {
          picker.items = toItems(filterPythonRuntimes(runtimes, value));
        }),
        picker.onDidAccept(() => {
          resolve(picker.selectedItems[0]);
          picker.hide();
        }),
        picker.onDidHide(() => resolve(undefined))
      );
      picker.show();
    });
    pickerDisposables.forEach((disposable) => disposable.dispose());
    picker.dispose();
    if (picked?.runtime) {
      await this.selectPythonRuntime(notebook, picked.runtime);
    } else if (picked?.action === "refresh") {
      await this.pythonDiscovery.refresh(true);
      this.logPythonDiscoveryState();
      await this.selectPythonEnvironment(notebook.uri.toString());
    } else if (picked?.action === "path") {
      const executable = await vscode.window.showInputBox({
        title: "Python Executable Path",
        prompt: "Enter an absolute Python executable path.",
        value: vscode.workspace.getConfiguration("rmdNotebooks", notebook.uri).get<string>("python.path", "")
      });
      if (executable?.trim()) {
        const manual: PythonLaunchDescriptor = {
          id: `manual:${notebook.uri.toString()}:${executable.trim()}`,
          label: path.basename(executable.trim()) || "Manual Python",
          description: "Manual executable",
          detail: executable.trim(),
          source: "manual",
          executable: executable.trim(),
          prefixArgs: [],
          renderPythonPath: executable.trim(),
          environmentVariables: undefined
        };
        await this.selectPythonRuntime(notebook, manual);
      }
    }
  }

  public getSelectedPythonRenderPath(documentUri?: string): string | undefined {
    const notebook = this.resolveNotebook(documentUri);
    if (!notebook) {
      return undefined;
    }
    const selected = this.pythonExecutor.getSelectedInterpreter(notebook.uri.toString());
    if (selected?.renderPythonPath) {
      return selected.renderPythonPath;
    }
    return this.getPersistedPythonRuntime(notebook.uri)?.renderPythonPath;
  }

  private async selectPythonRuntime(
    notebook: vscode.NotebookDocument,
    runtime: PythonLaunchDescriptor
  ): Promise<void> {
    await this.workspaceState.update(runtimeSelectionKey(notebook.uri), runtime);
    await this.pythonExecutor.selectInterpreter(notebook.uri.toString(), toInterpreterSelection(runtime));
    this.updatePythonEnvironmentStatus(vscode.window.activeNotebookEditor);
  }

  private async handleMissingIPython(event: {
    documentUri: string;
    selection?: { id: string; path: string; prefixArgs?: string[] };
  }): Promise<void> {
    const choice = await vscode.window.showInformationMessage(
      "This Python environment does not include IPython. Basic execution works, but magics and full rich output are unavailable.",
      "Install IPython",
      "Continue with Basic Python"
    );
    if (choice !== "Install IPython") {
      return;
    }

    const installed = event.selection
      ? await this.pythonDiscovery.installIPython(event.selection.id).catch(() => false)
      : false;
    if (!installed) {
      const executable = event.selection?.path ?? (process.platform === "win32" ? "python" : "python3");
      const args = [...(event.selection?.prefixArgs ?? []), "-m", "pip", "install", "ipython"];
      const terminal = vscode.window.createTerminal("Install IPython");
      terminal.show(true);
      terminal.sendText([executable, ...args].map(quoteShellArgument).join(" "));
      return;
    }

    await this.pythonExecutor.disposeSession(event.documentUri);
    void vscode.window.showInformationMessage(
      "IPython was installed. Run the cell again to start an enhanced notebook session."
    );
  }

  public async runCurrentChunk(documentUri?: string, chunkId?: string): Promise<void> {
    const notebook = this.resolveNotebook(documentUri);
    const selection = notebook ? this.getNotebookSelection(notebook) : undefined;
    if (notebook) {
      await this.promoteSelectedInlineMarkup(notebook);
    }
    const resolved = await this.resolveCodeCell(documentUri, chunkId, selection);
    if (!resolved) {
      void vscode.window.showWarningMessage("Rmd Notebooks: select an R code cell to run it.");
      return;
    }

    await this.executeCell(resolved.notebook, resolved.cell, resolved.cellIndex);
    if (getInlineChunksMetadata(resolved.cell.metadata)?.kind === "inline") {
      await this.collapseInlineInputs(resolved.notebook, [resolved.cellIndex], true);
    }
  }

  public async runInlineCell(documentUri?: string, chunkId?: string, cellIndex?: number): Promise<void> {
    const notebook = this.resolveNotebook(documentUri);
    if (!notebook) {
      return;
    }

    if (typeof cellIndex === "number") {
      await this.promoteInlineMarkupCells(notebook, [cellIndex]);
      const cell = notebook.cellAt(cellIndex);
      if (getInlineChunksMetadata(cell.metadata)?.kind === "inline") {
        await this.executeCell(notebook, cell, cellIndex);
        await this.collapseInlineInputs(notebook, [cell.index], true);
        return;
      }
    } else {
      await this.promoteSelectedInlineMarkup(notebook);
    }
    const resolved = await this.resolveCodeCell(documentUri, chunkId);
    if (!resolved || getInlineChunksMetadata(resolved.cell.metadata)?.kind !== "inline") {
      void vscode.window.showWarningMessage("Rmd Notebooks: select prose containing inline R to run it.");
      return;
    }
    await this.executeCell(resolved.notebook, resolved.cell, resolved.cellIndex);
    await this.collapseInlineInputs(resolved.notebook, [resolved.cellIndex], true);
  }

  public async runAllChunks(documentUri?: string): Promise<void> {
    const notebook = this.resolveNotebook(documentUri);
    if (!notebook) {
      return;
    }

    await this.promoteInlineMarkupCells(notebook);
    const uri = notebook.uri.toString();
    this.runsToAbort.delete(uri);
    const snapshot = await this.refreshNotebook(notebook);
    for (const entry of snapshot.chunks) {
      if (this.runsToAbort.has(uri)) {
        break;
      }
      const outcome = await this.executeCell(notebook, entry.cell, entry.index);
      if (outcome === "redirected") {
        break;
      }
    }
    this.runsToAbort.delete(uri);
    await this.collapseInlineInputs(notebook, undefined, true);
  }

  // Stops the whole run at once: interrupts the chunk currently running, cancels every
  // chunk still queued, and breaks any in-flight Run All / multi-cell loop so the
  // remaining cells never start. The notebook-wide counterpart to cancelling a single
  // cell from its stop button.
  public async interruptSession(documentUri?: string): Promise<void> {
    const notebook = this.resolveNotebook(documentUri);
    if (!notebook) {
      return;
    }

    // A Run All / Run Selected loop executes cells one at a time, so only the running
    // chunk is ever in the session queue; failQueue + SIGINT alone would stop that one
    // cell and let the loop march on. This flag makes the loop bail out too.
    this.runsToAbort.add(notebook.uri.toString());
    await Promise.all(
      this.executorRegistry.all().map((executor) => executor.interruptSession?.(notebook.uri.toString()))
    );
  }

  public async clearCurrentOutput(documentUri?: string, chunkId?: string): Promise<void> {
    const resolved = await this.resolveCodeCell(documentUri, chunkId);
    if (!resolved) {
      void vscode.window.showWarningMessage("Rmd Notebooks: select a code cell to clear its output.");
      return;
    }

    const snapshot = await this.refreshNotebook(resolved.notebook);
    const entry = snapshot.chunks.find((candidate) => candidate.index === resolved.cell.index);
    if (!entry) {
      return;
    }

    const outputs = await this.ensureOutputsLoaded(resolved.notebook.uri.toString());
    outputs.delete(entry.chunk.identity.chunkId);
    await this.outputStore.saveDocumentOutputs(resolved.notebook.uri.toString(), outputs);
    const selectedController = await this.ensureControllerSelected(resolved.notebook);
    if (!selectedController) {
      return;
    }
    await this.withOutputSync(resolved.notebook.uri.toString(), async () => {
      const execution = selectedController.createNotebookCellExecution(resolved.notebook.cellAt(entry.index));
      execution.start(Date.now());
      if (entry.sourceKind === "inline") {
        await execution.replaceOutput(createInlineSourceOutputs(resolved.cell.document.getText()));
      } else {
        await execution.clearOutput();
      }
      execution.end(undefined, Date.now());
    });
  }

  public async clearAllOutputs(documentUri?: string): Promise<void> {
    const notebook = this.resolveNotebook(documentUri);
    if (!notebook) {
      return;
    }

    const snapshot = await this.refreshNotebook(notebook);
    const outputs = await this.ensureOutputsLoaded(notebook.uri.toString());
    outputs.clear();
    await this.outputStore.clearDocumentOutputs(notebook.uri.toString());
    const selectedController = await this.ensureControllerSelected(notebook);
    if (!selectedController) {
      return;
    }

    await this.withOutputSync(notebook.uri.toString(), async () => {
      for (const entry of snapshot.chunks) {
        const execution = selectedController.createNotebookCellExecution(notebook.cellAt(entry.index));
        execution.start(Date.now());
        if (entry.sourceKind === "inline") {
          await execution.replaceOutput(createInlineSourceOutputs(entry.cell.document.getText()));
        } else {
          await execution.clearOutput();
        }
        execution.end(undefined, Date.now());
      }
    });
  }

  public getChunkIdForCell(documentUri: string, cellIndex: number): string | undefined {
    const snapshot = this.snapshots.get(documentUri);
    return snapshot?.chunks.find((entry) => entry.index === cellIndex)?.chunk.identity.chunkId;
  }

  public getPythonEnvironmentState(documentUri: string): {
    environments: Array<{ id: string; path: string; label: string }>;
    selectedPath?: string;
  } {
    const notebook = vscode.workspace.notebookDocuments.find((candidate) => candidate.uri.toString() === documentUri);
    return {
      environments: this.pythonDiscovery.getRuntimes(notebook?.uri).map((runtime) => ({
          id: runtime.id,
          path: runtime.renderPythonPath,
          label: runtime.label
        })),
      selectedPath: this.pythonExecutor.getSelectedInterpreter(documentUri)?.renderPythonPath
    };
  }

  public async selectTestPythonInterpreter(documentUri: string, executable: string): Promise<void> {
    const notebook = this.resolveNotebook(documentUri);
    if (!notebook) {
      return;
    }
    await this.selectPythonRuntime(notebook, {
      id: `manual:test:${executable}`,
      label: "Test Python",
      source: "manual",
      executable,
      prefixArgs: [],
      renderPythonPath: executable
    });
  }

  public async getDocumentState(documentUri: string): Promise<{
    snapshot: { documentUri: string; version: number; chunkIds: string[] } | undefined;
    outputs: Array<{ chunkId: string; status: string; stale: boolean; outputTypes: string[] }>;
    outputChannelText: string;
  }> {
    const notebook = vscode.workspace.notebookDocuments.find((candidate) => candidate.uri.toString() === documentUri);
    if (notebook) {
      await this.refreshNotebook(notebook);
    }

    const snapshot = this.snapshots.get(documentUri);
    const outputs = await this.ensureOutputsLoaded(documentUri);

    return {
      snapshot: snapshot
        ? {
            documentUri: snapshot.documentUri,
            version: snapshot.version,
            chunkIds: snapshot.chunks.map((chunk) => chunk.chunk.identity.chunkId)
          }
        : undefined,
      outputs: [...outputs.values()].map((record) => ({
        chunkId: record.chunkId,
        status: record.status,
        stale: record.stale,
        outputTypes: record.outputs.map((output) => output.type)
      })),
      outputChannelText: this.outputChannelController.getTranscript()
    };
  }

  public showOutputChannel(): void {
    this.outputChannelController.reveal();
  }

  public setTestPromptResponses(responses: InteractivePromptResponse[]): void {
    this.testPromptResponses = [...responses];
    this.testPromptRequests.length = 0;
  }

  public clearTestPromptResponses(): void {
    this.testPromptResponses = [];
    this.testPromptRequests.length = 0;
  }

  public takeTestPromptRequests(): InteractivePromptRequest[] {
    const requests = [...this.testPromptRequests];
    this.testPromptRequests.length = 0;
    return requests;
  }

  public async editChunkHeader(documentUri?: string, chunkId?: string, overrideHeaderInfo?: string): Promise<void> {
    const resolved = await this.resolveCodeCell(documentUri, chunkId);
    if (!resolved) {
      void vscode.window.showWarningMessage("Rmd Notebooks: select a code cell to edit its chunk header.");
      return;
    }

    const metadata = getInlineChunksMetadata(resolved.cell.metadata);
    if (metadata?.kind !== "code") {
      return;
    }

    const currentLanguage = resolved.cell.document.languageId;
    const nextHeaderInfo = overrideHeaderInfo ?? await vscode.window.showInputBox({
      title: "Edit Chunk Header",
      prompt: "Edit the contents inside the chunk header braces.",
      placeHolder: "r my-label, echo=FALSE",
      value: metadata.headerInfo,
      validateInput: (value) => validateChunkHeaderInfo(value, currentLanguage)
    });

    if (nextHeaderInfo === undefined) {
      return;
    }

    const normalizedHeaderInfo = normalizeChunkHeaderInfo(nextHeaderInfo);
    const validationError = validateChunkHeaderInfo(normalizedHeaderInfo, currentLanguage);
    if (validationError) {
      void vscode.window.showErrorMessage(`Rmd Notebooks: ${validationError}`);
      return;
    }

    const nextMetadata = withInlineChunksMetadata(resolved.cell.metadata, {
      ...metadata,
      language: currentLanguage,
      label: extractChunkLabel(normalizedHeaderInfo),
      options: parseChunkOptions(normalizedHeaderInfo),
      headerInfo: normalizedHeaderInfo,
      header: buildChunkHeader(normalizedHeaderInfo, metadata.fenceLength)
    } satisfies InlineChunksCodeCellMetadata);

    await this.withMetadataSync(resolved.notebook.uri.toString(), async () => {
      const edit = new vscode.WorkspaceEdit();
      edit.set(resolved.notebook.uri, [vscode.NotebookEdit.updateCellMetadata(resolved.cell.index, nextMetadata)]);
      await vscode.workspace.applyEdit(edit);
    });

    await this.refreshNotebook(resolved.notebook);
    void vscode.window.setStatusBarMessage(`Rmd Notebooks: updated chunk header for ${metadata.label ?? "cell"}`, 2000);
  }

  public dispose(): void {
    for (const timer of this.inlineStaleTimers.values()) {
      clearTimeout(timer);
    }
    this.inlineStaleTimers.clear();
    this.disposables.forEach((disposable) => disposable.dispose());
  }

  private async handleNotebookOpened(notebook: vscode.NotebookDocument): Promise<void> {
    if (!isInlineChunksNotebook(notebook)) {
      return;
    }

    this.controller.updateNotebookAffinity(notebook, vscode.NotebookControllerAffinity.Preferred);
    await this.refreshNotebook(notebook);
    await this.restoreOutputsToNotebook(notebook);
    await this.collapseInlineInputs(notebook);
  }

  private beginNotebookInitialization(notebook: vscode.NotebookDocument): Promise<void> {
    const documentUri = notebook.uri.toString();
    const existing = this.notebookInitializations.get(documentUri);
    if (existing) {
      return existing;
    }

    const current = this.handleNotebookOpened(notebook);
    this.notebookInitializations.set(documentUri, current);
    const cleanup = (): void => {
      if (this.notebookInitializations.get(documentUri) === current) {
        this.notebookInitializations.delete(documentUri);
      }
    };
    void current.then(cleanup, cleanup);
    return current;
  }

  private async handleNotebookChanged(event: vscode.NotebookDocumentChangeEvent): Promise<void> {
    const notebook = event.notebook;
    const documentUri = notebook.uri.toString();
    if (!isInlineChunksNotebook(notebook) || this.metadataSyncInFlight.has(documentUri) || this.outputSyncInFlight.has(documentUri)) {
      return;
    }

    const clearedCells = event.cellChanges
      .filter((change) => change.outputs !== undefined && change.outputs.length === 0)
      .map((change) => change.cell);
    if (clearedCells.length > 0) {
      let snapshot = this.snapshots.get(documentUri);
      let outputs = this.outputsByDocument.get(documentUri);
      if (!snapshot) {
        snapshot = await this.refreshNotebook(notebook);
      }
      if (!outputs) {
        outputs = await this.ensureOutputsLoaded(documentUri);
      }
      let changed = false;
      for (const cell of clearedCells) {
        const entry = snapshot.chunks.find((candidate) => candidate.index === cell.index);
        if (entry) {
          changed = outputs.delete(entry.chunk.identity.chunkId) || changed;
        }
      }
      if (changed) {
        await this.outputStore.saveDocumentOutputs(documentUri, outputs);
      }
      const inlineCleared = clearedCells.filter(
        (cell) => getInlineChunksMetadata(cell.metadata)?.kind === "inline"
      );
      const selectedController = inlineCleared.length > 0
        ? await this.ensureControllerSelected(notebook)
        : undefined;
      if (inlineCleared.length > 0 && selectedController) {
        await this.withOutputSync(documentUri, async () => {
          for (const cell of inlineCleared) {
            const execution = selectedController.createNotebookCellExecution(notebook.cellAt(cell.index));
            execution.start();
            await execution.replaceOutput(createInlineSourceOutputs(cell.document.getText()));
            execution.end(undefined);
          }
        });
      }
    }

    await this.refreshNotebook(notebook);
    if (event.cellChanges.some(
      (change) => change.document !== undefined && getInlineChunksMetadata(change.cell.metadata)?.kind === "inline"
    )) {
      this.scheduleInlineOutputRestore(notebook);
    }
  }

  private async handleNotebookClosed(notebook: vscode.NotebookDocument): Promise<void> {
    if (!isInlineChunksNotebook(notebook)) {
      return;
    }

    this.snapshots.delete(notebook.uri.toString());
    this.notebookInitializations.delete(notebook.uri.toString());
    this.collapsedInlineDocuments.delete(notebook.uri.toString());
    this.outputRestorations.delete(notebook.uri.toString());
    const staleTimer = this.inlineStaleTimers.get(notebook.uri.toString());
    if (staleTimer) {
      clearTimeout(staleTimer);
      this.inlineStaleTimers.delete(notebook.uri.toString());
    }
    await this.pythonExecutor.selectInterpreter(notebook.uri.toString());
    await Promise.all(
      this.executorRegistry.all().map((executor) => executor.disposeSession?.(notebook.uri.toString()))
    );
  }

  private async executeCell(
    notebook: vscode.NotebookDocument,
    cell: vscode.NotebookCell,
    targetIndex = cell.index
  ): Promise<ExecuteCellOutcome> {
    const cellIndex = targetIndex;
    await this.notebookInitializations.get(notebook.uri.toString())?.catch(() => undefined);

    // Output restoration can cause VS Code to replace NotebookCell objects while a
    // command is being resolved. Re-read the cell by index so a stale object cannot
    // make an executable code cell look like markup and silently skip the run.
    if (cellIndex < 0 || cellIndex >= notebook.cellCount) {
      return "completed";
    }
    const currentCell = notebook.cellAt(cellIndex);
    if (!isExecutableChunkCell(currentCell)) {
      return "completed";
    }

    await this.outputRestorations.get(notebook.uri.toString())?.catch(() => undefined);

    const releaseAdmission = await this.acquireExecutionAdmission(notebook.uri.toString());
    try {
      return await this.executeAdmittedCell(notebook, currentCell, releaseAdmission);
    } finally {
      releaseAdmission();
    }
  }

  private async executeAdmittedCell(
    notebook: vscode.NotebookDocument,
    cell: vscode.NotebookCell,
    releaseAdmission: () => void
  ): Promise<ExecuteCellOutcome> {
    const snapshot = await this.refreshNotebook(notebook);
    const entry = snapshot.chunks.find((candidate) => candidate.index === cell.index);
    if (!entry) {
      return "completed";
    }
    cell = notebook.cellAt(entry.index);

    const outputs = await this.ensureOutputsLoaded(notebook.uri.toString());
    const executor = this.executorRegistry.get(entry.chunk.language);
    if (["python", "py"].includes(entry.chunk.language.toLowerCase())) {
      await this.ensurePythonRuntimeSelected(notebook);
    }
    const chunkOptions = getChunkOptions(cell);
    const isInline = entry.sourceKind === "inline";
    const selectedController = await this.ensureControllerSelected(notebook);
    if (!selectedController) {
      return "completed";
    }
    const execution = selectedController.createNotebookCellExecution(notebook.cellAt(entry.index));
    // Leave the cell in the "queued" (pending clock) state until the chunk actually
    // begins running in its language session, instead of marking it running the
    // moment it is enqueued.
    // That way every cell's reported duration is its own run time, not the time since
    // the first queued chunk started, and cells waiting their turn show the queued
    // badge rather than a spinner, exactly like Run All. start() must precede end(),
    // so paths that never reach an executor still call this before ending the execution.
    let executionStarted = false;
    // The execution order (the [N] badge) is the language session's own per-notebook
    // count, delivered through onStart when the chunk actually starts running. Chunks
    // that never reach an executor (eval=FALSE, no executor) leave it undefined and
    // so show no number, the way a chunk that did not run has no count.
    const beginExecutionDisplay = (startTime?: number, executionOrder?: number): void => {
      if (executionStarted) {
        return;
      }
      executionStarted = true;
      if (executionOrder !== undefined) {
        execution.executionOrder = executionOrder;
      }
      execution.start(startTime);
    };

    if (chunkOptions?.eval === false) {
      beginExecutionDisplay(Date.now());
      const skippedRecord = createRecord(entry.chunk, "success", [], entry.sourceKind);
      outputs.set(entry.chunk.identity.chunkId, skippedRecord);
      await this.outputStore.saveDocumentOutputs(notebook.uri.toString(), outputs);
      await this.withOutputSync(notebook.uri.toString(), async () => {
        await execution.clearOutput();
      });
      execution.end(true, Date.now());
      void vscode.window.setStatusBarMessage(`Rmd Notebooks: skipped ${entry.chunk.label ?? "cell"} because eval=FALSE`, 2500);
      return "completed";
    }

    if (!executor) {
      beginExecutionDisplay(Date.now());
      const record = createRecord(entry.chunk, "error", [
        ...(isInline ? inlineSourceOutputItems(cell.document.getText()) : []),
        {
          type: "error",
          text: `No executor registered for language "${entry.chunk.language}".`
        }
      ], entry.sourceKind);
      outputs.set(entry.chunk.identity.chunkId, record);
      await this.outputStore.saveDocumentOutputs(notebook.uri.toString(), outputs);
      await this.withOutputSync(notebook.uri.toString(), async () => {
        await execution.replaceOutput(await createNotebookOutputs(record));
      });
      execution.end(false, Date.now());
      this.outputChannelController.logRunCompleted(cell.document, entry.chunk, record);
      return "completed";
    }

    const runningRecord = createRecord(entry.chunk, "running", [], entry.sourceKind);
    outputs.set(entry.chunk.identity.chunkId, runningRecord);
    await this.outputStore.saveDocumentOutputs(notebook.uri.toString(), outputs);
    this.outputChannelController.logRunStarted(cell.document, entry.chunk);

    try {
      const resultPromise = executor.executeChunk({
        documentUri: notebook.uri.toString(),
        workspaceFolder: vscode.workspace.getWorkspaceFolder(notebook.uri)?.uri.fsPath,
        chunkId: entry.chunk.identity.chunkId,
        language: entry.chunk.language,
        code: isInline ? buildInlineRExecutionCode(cell.document.getText()) : cell.document.getText(),
        header: entry.chunk.header,
        artifactDirectory: await this.outputStore.getArtifactDirectory(notebook.uri.toString()),
        plot: isInline ? undefined : resolvePlotRenderOptions(chunkOptions),
        prompt: (request) => this.promptForChunkInput(notebook, cell, entry.chunk, request),
        onStart: (executionOrder) => beginExecutionDisplay(Date.now(), executionOrder),
        token: execution.token
      });
      releaseAdmission();
      const result = await resultPromise;

      const filteredResult = isInline ? result : applyChunkOptionsToResult(result, chunkOptions);
      const displayedResult = isInline && !filteredResult.success && !filteredResult.items.some((item) => item.type === "markdown")
        ? { ...filteredResult, items: [...inlineSourceOutputItems(cell.document.getText()), ...filteredResult.items] }
        : filteredResult;
      // onStart always fires (in the session's beginExecution) before any result can
      // arrive, so the cell is already marked running here; this call is only a
      // fallback for the impossible case where onStart was skipped, and is a no-op
      // otherwise. The displayed start time therefore comes from onStart (Date.now at
      // dequeue), not from filteredResult.startedAt.
      beginExecutionDisplay(displayedResult.startedAt);
      const record = createRecordFromResult(entry.chunk, displayedResult, entry.sourceKind);
      outputs.set(entry.chunk.identity.chunkId, record);
      await this.outputStore.saveDocumentOutputs(notebook.uri.toString(), outputs);
      await this.withOutputSync(notebook.uri.toString(), async () => {
        if (record.outputs.length === 0) {
          await execution.clearOutput();
        } else {
          await execution.replaceOutput(await createNotebookOutputs(record));
        }
      });
      execution.end(displayedResult.success, displayedResult.finishedAt);
      this.outputChannelController.logRunCompleted(cell.document, entry.chunk, record);
      return "completed";
    } catch (error) {
      if (error instanceof InteractiveExecutionError) {
        // The chunk did start running (it timed out mid-execution), so the cell is
        // already showing as running by now; this only matters as a safeguard.
        beginExecutionDisplay(Date.now());
        if (isInline) {
          const record = createRecord(entry.chunk, "error", [
            ...inlineSourceOutputItems(cell.document.getText()),
            { type: "error", text: error.message }
          ], "inline");
          outputs.set(entry.chunk.identity.chunkId, record);
          await this.outputStore.saveDocumentOutputs(notebook.uri.toString(), outputs);
          await this.withOutputSync(notebook.uri.toString(), async () => {
            await execution.replaceOutput(await createNotebookOutputs(record));
          });
          execution.end(false, Date.now());
          this.outputChannelController.logRunCompleted(cell.document, entry.chunk, record);
          return "completed";
        }
        const fallback = await this.handleInteractiveFallback(notebook, cell, entry.chunk, outputs, execution, error.message);
        this.outputChannelController.logRunCompleted(cell.document, entry.chunk, fallback.record);
        return fallback.launchedTerminal ? "redirected" : "completed";
      }

      if (error instanceof CancelledExecutionError) {
        // The chunk was interrupted while still waiting in the queue, so it never
        // ran. End the still-pending execution without assigning a run order or a
        // duration (start() must be called before end(), but with no start time so
        // no clock is shown), and clear it without flagging it as a failure.
        beginExecutionDisplay(undefined);
        const cancelledRecord = createRecord(
          entry.chunk,
          "cancelled",
          isInline ? inlineSourceOutputItems(cell.document.getText()) : [],
          entry.sourceKind
        );
        outputs.set(entry.chunk.identity.chunkId, cancelledRecord);
        await this.outputStore.saveDocumentOutputs(notebook.uri.toString(), outputs);
        await this.withOutputSync(notebook.uri.toString(), async () => {
          if (isInline) {
            await execution.replaceOutput(await createNotebookOutputs(cancelledRecord));
          } else {
            await execution.clearOutput();
          }
        });
        execution.end(undefined, Date.now());
        this.outputChannelController.logRunCompleted(cell.document, entry.chunk, cancelledRecord);
        return "completed";
      }

      beginExecutionDisplay(Date.now());
      const record = createRecord(entry.chunk, "error", [
        ...(isInline ? inlineSourceOutputItems(cell.document.getText()) : []),
        {
          type: "error",
          text: error instanceof Error ? error.message : String(error)
        }
      ], entry.sourceKind);
      outputs.set(entry.chunk.identity.chunkId, record);
      await this.outputStore.saveDocumentOutputs(notebook.uri.toString(), outputs);
      await this.withOutputSync(notebook.uri.toString(), async () => {
        await execution.replaceOutput(await createNotebookOutputs(record));
      });
      execution.end(false, Date.now());
      this.outputChannelController.logRunCompleted(cell.document, entry.chunk, record);
      return "completed";
    }
  }

  private async acquireExecutionAdmission(documentUri: string): Promise<() => void> {
    // Preserve request order through asynchronous notebook preparation. The caller
    // releases this gate as soon as the request reaches the executor's own queue.
    const previous = this.executionAdmissions.get(documentUri) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.executionAdmissions.set(documentUri, tail);

    await previous;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      release();
      if (this.executionAdmissions.get(documentUri) === tail) {
        this.executionAdmissions.delete(documentUri);
      }
    };
  }

  public async runCurrentChunkInTerminal(documentUri?: string, chunkId?: string): Promise<void> {
    const resolved = await this.resolveCodeCell(documentUri, chunkId);
    if (!resolved || getInlineChunksMetadata(resolved.cell.metadata)?.kind !== "code") {
      void vscode.window.showWarningMessage("Rmd Notebooks: select an R code cell to run it in the terminal.");
      return;
    }

    if (resolved.cell.document.languageId.toLowerCase() !== "r") {
      void vscode.window.showWarningMessage("Rmd Notebooks: terminal fallback is currently available only for R chunks.");
      return;
    }

    await this.terminalRunner.runChunk(
      resolved.cell.document.getText(),
      vscode.workspace.getWorkspaceFolder(resolved.notebook.uri)?.uri.fsPath
    );
  }

  public async restartSession(documentUri?: string): Promise<void> {
    const notebook = this.resolveNotebook(documentUri);
    if (!notebook) {
      void vscode.window.showWarningMessage("Rmd Notebooks: open a notebook to restart its execution sessions.");
      return;
    }

    const restartableExecutors = this.executorRegistry.all().filter((executor) => executor.disposeSession);
    if (restartableExecutors.length === 0) {
      void vscode.window.showWarningMessage("Rmd Notebooks: no restartable execution session is available.");
      return;
    }

    await Promise.all(restartableExecutors.map((executor) => executor.disposeSession?.(notebook.uri.toString())));
    void vscode.window.setStatusBarMessage("Rmd Notebooks: restarted execution sessions", 2500);
  }

  private async promptForChunkInput(
    notebook: vscode.NotebookDocument,
    cell: vscode.NotebookCell,
    chunk: ExecutableChunk,
    request: InteractivePromptRequest
  ): Promise<InteractivePromptResponse> {
    this.testPromptRequests.push(request);
    const queuedTestResponse = this.testPromptResponses.shift();
    if (queuedTestResponse) {
      return queuedTestResponse;
    }

    const label = chunk.label ?? `cell ${cell.index + 1}`;
    const title = request.title?.trim() || `Rmd Notebooks: ${label}`;

    if (request.kind === "input") {
      const value = await vscode.window.showInputBox({
        title,
        prompt: request.prompt,
        placeHolder: request.placeHolder,
        value: request.defaultValue,
        ignoreFocusOut: true
      });

      return value === undefined
        ? { cancelled: true }
        : { cancelled: false, value };
    }

    const choiceItems = buildPromptQuickPickItems(request.choices);
    const picked = await vscode.window.showQuickPick(choiceItems, {
      title,
      placeHolder: request.prompt,
      ignoreFocusOut: true,
      matchOnDescription: true
    });

    if (!picked) {
      return { cancelled: true };
    }

    return {
      cancelled: false,
      value: picked.value
    };
  }

  private async refreshNotebook(notebook: vscode.NotebookDocument): Promise<NotebookSnapshot> {
    const outputs = await this.ensureOutputsLoaded(notebook.uri.toString());
    const previousSnapshot = this.snapshots.get(notebook.uri.toString());
    let snapshot = buildNotebookSnapshot(notebook, outputs, previousSnapshot);
    this.snapshots.set(notebook.uri.toString(), snapshot);
    reconcileOutputs(snapshot, outputs);
    await this.outputStore.saveDocumentOutputs(notebook.uri.toString(), outputs);
    const metadataChanged = await this.applyChunkMetadata(notebook, snapshot);
    if (metadataChanged) {
      snapshot = buildNotebookSnapshot(notebook, outputs, snapshot);
      this.snapshots.set(notebook.uri.toString(), snapshot);
      reconcileOutputs(snapshot, outputs);
      await this.outputStore.saveDocumentOutputs(notebook.uri.toString(), outputs);
    }
    return snapshot;
  }

  private async applyChunkMetadata(notebook: vscode.NotebookDocument, snapshot: NotebookSnapshot): Promise<boolean> {
    const edits: vscode.NotebookEdit[] = [];

    for (const entry of snapshot.chunks) {
      const existing = getInlineChunksMetadata(entry.cell.metadata);
      if (entry.sourceKind === "inline" && existing?.kind === "inline") {
        continue;
      }

      const targetSource: InlineChunksCodeCellMetadata = {
        kind: "code",
        header: existing?.kind === "code" ? existing.header : entry.chunk.header,
        headerInfo: existing?.kind === "code" ? existing.headerInfo : entry.chunk.headerInfo,
        language: entry.chunk.language,
        label: entry.chunk.label,
        options: existing?.kind === "code" ? existing.options : parseChunkOptions(entry.chunk.headerInfo),
        fenceLength: existing?.kind === "code" ? existing.fenceLength : entry.chunk.fenceLength,
        isClosed: existing?.kind === "code" ? existing.isClosed : entry.chunk.isClosed
      };

      if (existing && JSON.stringify(existing) === JSON.stringify(targetSource)) {
        continue;
      }

      const next = withInlineChunksMetadata(entry.cell.metadata, targetSource);
      edits.push(vscode.NotebookEdit.updateCellMetadata(entry.index, next));
    }

    if (edits.length === 0) {
      return false;
    }

    await this.withMetadataSync(notebook.uri.toString(), async () => {
      const edit = new vscode.WorkspaceEdit();
      edit.set(notebook.uri, edits);
      await vscode.workspace.applyEdit(edit);
    });

    return true;
  }

  private restoreOutputsToNotebook(notebook: vscode.NotebookDocument, refreshAfterCurrent = false): Promise<void> {
    const documentUri = notebook.uri.toString();
    const existing = this.outputRestorations.get(documentUri);
    if (existing && !refreshAfterCurrent) {
      return existing;
    }

    // Opening a notebook and making it active can request the same restore twice.
    // Coalesce those calls so VS Code never gets overlapping controller executions
    // for the same cells. Inline-source edits opt into one follow-up pass instead.
    const current = existing
      ? existing.catch(() => undefined).then(() => this.performOutputRestore(notebook))
      : this.performOutputRestore(notebook);
    this.outputRestorations.set(documentUri, current);
    const cleanup = (): void => {
      if (this.outputRestorations.get(documentUri) === current) {
        this.outputRestorations.delete(documentUri);
      }
    };
    void current.then(cleanup, cleanup);
    return current;
  }

  private scheduleInlineOutputRestore(notebook: vscode.NotebookDocument): void {
    const documentUri = notebook.uri.toString();
    const existing = this.inlineStaleTimers.get(documentUri);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      this.inlineStaleTimers.delete(documentUri);
      if (vscode.workspace.notebookDocuments.some((candidate) => candidate.uri.toString() === documentUri)) {
        void this.restoreOutputsToNotebook(notebook, true).catch((error) =>
          console.error("Unable to refresh stale inline R output", error)
        );
      }
    }, 250);
    this.inlineStaleTimers.set(documentUri, timer);
  }

  private async performOutputRestore(notebook: vscode.NotebookDocument): Promise<void> {
    // On a window reload a notebook can become the active editor before its
    // snapshot has been built (the active-editor event races with initialize),
    // so build it on demand instead of bailing out and never restoring.
    const snapshot = this.snapshots.get(notebook.uri.toString()) ?? (await this.refreshNotebook(notebook));
    if (!snapshot) {
      return;
    }

    const outputs = await this.ensureOutputsLoaded(notebook.uri.toString());
    if (outputs.size === 0) {
      return;
    }

    const pending = snapshot.chunks.filter((entry) => {
      const record = outputs.get(entry.chunk.identity.chunkId);
      if (!record || record.status === "running") {
        return false;
      }
      return entry.sourceKind === "inline" || notebook.cellAt(entry.index).outputs.length === 0;
    });
    if (pending.length === 0) {
      return;
    }

    const selectedController = await this.ensureControllerSelected(notebook);
    if (!selectedController) {
      return;
    }
    await this.withOutputSync(notebook.uri.toString(), async () => {
      for (const entry of pending) {
        const record = outputs.get(entry.chunk.identity.chunkId);
        if (!record) {
          continue;
        }

        const execution = selectedController.createNotebookCellExecution(notebook.cellAt(entry.index));
        // Restoring previously captured output is not a real run, so omit the
        // timestamps: passing capturedAt (in the past) as the end time made
        // VS Code render a negative duration like "-50.-4s".
        execution.start();
        await execution.replaceOutput(await createNotebookOutputs(record));
        execution.end(record.status === "success");
      }
    });
  }

  private async promoteSelectedInlineMarkup(notebook: vscode.NotebookDocument): Promise<void> {
    const editor = vscode.window.activeNotebookEditor;
    if (!editor || editor.notebook.uri.toString() !== notebook.uri.toString()) {
      return;
    }
    const indices: number[] = [];
    for (let index = editor.selection.start; index < editor.selection.end; index += 1) {
      indices.push(index);
    }
    await this.promoteInlineMarkupCells(notebook, indices);
  }

  private async promoteInlineMarkupCells(notebook: vscode.NotebookDocument, indices?: number[]): Promise<void> {
    const allowed = indices ? new Set(indices) : undefined;
    const edits: vscode.NotebookEdit[] = [];

    for (const cell of notebook.getCells()) {
      if (cell.kind !== vscode.NotebookCellKind.Markup || (allowed && !allowed.has(cell.index))) {
        continue;
      }
      const expressions = parseInlineRExpressions(cell.document.getText());
      if (expressions.length === 0) {
        continue;
      }
      const replacement = createInlineCellData(cell.document.getText(), expressions.length);
      edits.push(vscode.NotebookEdit.replaceCells(new vscode.NotebookRange(cell.index, cell.index + 1), [replacement]));
    }

    if (edits.length === 0) {
      return;
    }
    await this.withMetadataSync(notebook.uri.toString(), async () => {
      const edit = new vscode.WorkspaceEdit();
      edit.set(notebook.uri, edits);
      await vscode.workspace.applyEdit(edit);
    });
    await this.refreshNotebook(notebook);
  }

  private async collapseInlineInputs(
    notebook: vscode.NotebookDocument,
    indices?: number[],
    force = false
  ): Promise<void> {
    const documentUri = notebook.uri.toString();
    if (!force && this.collapsedInlineDocuments.has(documentUri)) {
      return;
    }
    if (!vscode.window.visibleNotebookEditors.some((editor) => editor.notebook.uri.toString() === documentUri)) {
      return;
    }
    const allowed = indices ? new Set(indices) : undefined;
    const ranges = notebook.getCells()
      .filter((cell) => getInlineChunksMetadata(cell.metadata)?.kind === "inline" && (!allowed || allowed.has(cell.index)))
      .map((cell) => ({ start: cell.index, end: cell.index + 1 }));
    if (ranges.length === 0) {
      return;
    }
    await vscode.commands.executeCommand("notebook.cell.collapseCellInput", {
      document: notebook.uri,
      ranges
    });
    if (!indices) {
      this.collapsedInlineDocuments.add(documentUri);
    }
  }

  private resolveNotebook(documentUri?: string): vscode.NotebookDocument | undefined {
    // Toolbar/menu commands are invoked with a context object (e.g. { notebookEditor })
    // rather than a string URI, so a non-string argument means "no URI given": fall
    // back to the active/visible notebook instead of comparing a string against an
    // object (which never matches and would silently resolve nothing).
    if (typeof documentUri !== "string") {
      documentUri = undefined;
    }

    if (!documentUri) {
      return (
        vscode.window.activeNotebookEditor?.notebook ??
        vscode.window.visibleNotebookEditors.find((editor) => isInlineChunksNotebook(editor.notebook))?.notebook ??
        vscode.workspace.notebookDocuments.find((notebook) => isInlineChunksNotebook(notebook))
      );
    }

    return (
      vscode.window.visibleNotebookEditors.find((editor) => editor.notebook.uri.toString() === documentUri)?.notebook ??
      vscode.workspace.notebookDocuments.find((notebook) => notebook.uri.toString() === documentUri)
    );
  }

  private async resolveCodeCell(
    documentUri?: string,
    chunkId?: string,
    preferredSelection?: vscode.NotebookRange
  ): Promise<{ notebook: vscode.NotebookDocument; cell: vscode.NotebookCell; cellIndex: number } | undefined> {
    const notebook = this.resolveNotebook(documentUri);
    if (!notebook) {
      return undefined;
    }

    // Capture the user's target before refresh/restore work yields. Restoring saved
    // outputs can move VS Code's notebook selection while a command is starting;
    // reading it afterward can silently run (or reject) a different cell.
    const selection = preferredSelection ?? this.getNotebookSelection(notebook);
    const snapshot = await this.refreshNotebook(notebook);
    if (chunkId) {
      const entry = snapshot.chunks.find((candidate) => candidate.chunk.identity.chunkId === chunkId);
      return entry ? { notebook, cell: notebook.cellAt(entry.index), cellIndex: entry.index } : undefined;
    }

    for (let index = selection.start; index < selection.end; index += 1) {
      const cell = notebook.cellAt(index);
      if (isExecutableChunkCell(cell)) {
        return { notebook, cell, cellIndex: index };
      }
    }

    const activeCell = notebook.cellAt(Math.min(selection.start, Math.max(notebook.cellCount - 1, 0)));
    return isExecutableChunkCell(activeCell)
      ? { notebook, cell: activeCell, cellIndex: activeCell.index }
      : undefined;
  }

  private getNotebookSelection(notebook: vscode.NotebookDocument): vscode.NotebookRange {
    const activeEditor = vscode.window.activeNotebookEditor;
    return activeEditor?.notebook.uri.toString() === notebook.uri.toString()
      ? activeEditor.selection
      : new vscode.NotebookRange(0, 1);
  }

  private async ensureOutputsLoaded(documentUri: string): Promise<Map<string, ChunkOutputRecord>> {
    const existing = this.outputsByDocument.get(documentUri);
    if (existing) {
      return existing;
    }

    const loaded = await this.outputStore.loadDocumentOutputs(documentUri);
    this.outputsByDocument.set(documentUri, loaded);
    return loaded;
  }

  private async withMetadataSync(documentUri: string, action: () => Promise<void>): Promise<void> {
    this.metadataSyncInFlight.add(documentUri);
    try {
      await action();
    } finally {
      this.metadataSyncInFlight.delete(documentUri);
    }
  }

  private async withOutputSync(documentUri: string, action: () => Promise<void>): Promise<void> {
    this.outputSyncInFlight.add(documentUri);
    try {
      await action();
    } finally {
      this.outputSyncInFlight.delete(documentUri);
    }
  }

  private async ensureControllerSelected(
    notebook: vscode.NotebookDocument
  ): Promise<vscode.NotebookController | undefined> {
    const activeEditor = vscode.window.activeNotebookEditor;
    if (!activeEditor || activeEditor.notebook.uri.toString() !== notebook.uri.toString()) {
      return undefined;
    }

    await vscode.commands.executeCommand("_notebook.selectKernel", {
      id: this.controller.id,
      extension: "AlFontal.rmd-notebooks-vscode"
    });
    return this.controller;
  }

  private async handleInteractiveFallback(
    notebook: vscode.NotebookDocument,
    cell: vscode.NotebookCell,
    chunk: ExecutableChunk,
    outputs: Map<string, ChunkOutputRecord>,
    execution: vscode.NotebookCellExecution,
    message: string
  ): Promise<{ record: ChunkOutputRecord; launchedTerminal: boolean }> {
    const behavior = vscode.workspace.getConfiguration("rmdNotebooks").get<"prompt" | "terminal" | "error">(
      "execution.interactiveFallbackBehavior",
      "prompt"
    );
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(notebook.uri)?.uri.fsPath;

    let launchedTerminal = false;
    if (behavior === "terminal") {
      await this.terminalRunner.runChunk(cell.document.getText(), workspaceFolder);
      launchedTerminal = true;
    } else if (behavior === "prompt") {
      const choice = await vscode.window.showWarningMessage(
        "This chunk appears to need interactive input. Run it in an R terminal instead?",
        { modal: false },
        "Run in R Terminal"
      );
      if (choice === "Run in R Terminal") {
        await this.terminalRunner.runChunk(cell.document.getText(), workspaceFolder);
        launchedTerminal = true;
      }
    }

    const record = createRecord(chunk, launchedTerminal ? "redirected" : "error", [
      {
        type: launchedTerminal ? "text" : "error",
        text: launchedTerminal
          ? "Inline execution was stopped because the chunk appears interactive. The chunk was sent to the R terminal."
          : `${message} Run this chunk in an R terminal instead.`
      }
    ]);

    outputs.set(chunk.identity.chunkId, record);
    await this.outputStore.saveDocumentOutputs(notebook.uri.toString(), outputs);
    await this.withOutputSync(notebook.uri.toString(), async () => {
      await execution.replaceOutput(await createNotebookOutputs(record));
    });
    execution.end(launchedTerminal, Date.now());
    return { record, launchedTerminal };
  }
}

function getChunkOptions(cell: vscode.NotebookCell): InlineChunksCodeCellMetadata["options"] {
  const metadata = getInlineChunksMetadata(cell.metadata);
  return metadata?.kind === "code" ? metadata.options : undefined;
}

function getNotebookJupyterKernel(notebook: vscode.NotebookDocument): string | undefined {
  const frontmatter = notebook.getCells().find(
    (cell) => getInlineChunksMetadata(cell.metadata)?.kind === "frontmatter"
  );
  return frontmatter ? parseJupyterFrontmatter(frontmatter.document.getText())?.kernelName : undefined;
}

function runtimeSelectionKey(uri: vscode.Uri): string {
  return `pythonRuntime:${uri.toString()}`;
}

function hasPythonCells(notebook: vscode.NotebookDocument): boolean {
  return notebook.getCells().some(
    (cell) =>
      cell.kind === vscode.NotebookCellKind.Code &&
      ["python", "py"].includes(cell.document.languageId.toLowerCase())
  );
}

function isPythonLaunchDescriptor(value: unknown): value is PythonLaunchDescriptor {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<PythonLaunchDescriptor>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.label === "string" &&
    typeof candidate.executable === "string" &&
    typeof candidate.renderPythonPath === "string" &&
    Array.isArray(candidate.prefixArgs)
  );
}

function toInterpreterSelection(runtime: PythonLaunchDescriptor): {
  id: string;
  path: string;
  prefixArgs: string[];
  renderPythonPath: string;
  environmentVariables?: Record<string, string | undefined>;
} {
  return {
    id: runtime.id,
    path: runtime.executable,
    prefixArgs: [...runtime.prefixArgs],
    renderPythonPath: runtime.renderPythonPath,
    environmentVariables: runtime.environmentVariables
  };
}

function quoteShellArgument(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) {
    return value;
  }
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

function resolvePlotRenderOptions(options: InlineChunksCodeCellMetadata["options"]): PlotRenderOptions | undefined {
  if (!options) {
    return undefined;
  }

  const widthInches = options.figWidth;
  const dpi = options.dpi;
  let heightInches = options.figHeight;

  if (heightInches === undefined && widthInches !== undefined && options.figAsp !== undefined) {
    heightInches = widthInches * options.figAsp;
  }

  if (widthInches === undefined && heightInches === undefined && dpi === undefined) {
    return undefined;
  }

  return {
    widthInches,
    heightInches,
    dpi
  };
}

function buildPromptQuickPickItems(
  choices?: InteractivePromptChoice[]
): Array<vscode.QuickPickItem & { value: string }> {
  if (!choices || choices.length === 0) {
    return [
      {
        label: "Confirm",
        value: "1"
      }
    ];
  }

  return choices.map((choice) => ({
    label: choice.label,
    description: choice.description,
    value: choice.value
  }));
}


function buildNotebookSnapshot(
  notebook: vscode.NotebookDocument,
  outputs: Map<string, ChunkOutputRecord>,
  previousSnapshot?: NotebookSnapshot
): NotebookSnapshot {
  const codeCells = notebook
    .getCells()
    .filter(isExecutableChunkCell)
    .map((cell) => ({
      cell,
      index: cell.index,
      sourceKind: getInlineChunksMetadata(cell.metadata)?.kind === "inline" ? "inline" as const : "chunk" as const,
      parsed: toParsedChunk(notebook, cell)
    }));

  const metadataSeeds = previousSnapshot
    ? previousSnapshot.chunks.map((entry) => createIdentitySeed(entry.chunk))
    : [];

  const outputSeeds = [...outputs.values()]
    .filter((record) => !metadataSeeds.some((seed) => seed.chunkId === record.chunkId))
    .map((record) => ({
      chunkId: record.chunkId,
      contentHash: record.contentHash,
      headerHash: record.headerHash,
      bodyHash: record.bodyHash,
      language: record.language,
      label: record.label,
      startLine: record.startLine,
      header: record.header
    }));

  const chunks = assignChunkIdentities(
    notebook.uri.toString(),
    codeCells.map((entry) => entry.parsed),
    [...metadataSeeds, ...outputSeeds]
  );

  return {
    documentUri: notebook.uri.toString(),
    version: notebook.version,
    chunks: codeCells.map((entry, index) => ({
      index: entry.index,
      cell: entry.cell,
      chunk: chunks[index],
      sourceKind: entry.sourceKind
    })),
    generatedAt: Date.now()
  };
}

function isExecutableChunkCell(cell: vscode.NotebookCell): boolean {
  if (cell.kind !== vscode.NotebookCellKind.Code) {
    return false;
  }

  return getInlineChunksMetadata(cell.metadata)?.kind !== "frontmatter";
}

function toParsedChunk(notebook: vscode.NotebookDocument, cell: vscode.NotebookCell): ParsedExecutableChunk {
  const metadata = getInlineChunksMetadata(cell.metadata);
  const isInline = metadata?.kind === "inline";
  const codeMetadata = metadata?.kind === "code" ? metadata : undefined;
  const header = isInline ? "inline-r" : codeMetadata?.header ?? `\`\`\`{${cell.document.languageId}}`;
  const body = cell.document.getText();
  const startLine = cell.index * 2;
  const bodyLineCount = body.length === 0 ? 0 : body.replace(/\r\n/g, "\n").split("\n").length;
  const endLine = startLine + bodyLineCount + 1;

  return {
    documentUri: notebook.uri.toString(),
    language: isInline ? "r" : cell.document.languageId,
    header,
    headerInfo: isInline ? "r inline" : codeMetadata?.headerInfo ?? cell.document.languageId,
    label: codeMetadata?.label,
    body,
    isClosed: true,
    fenceLength: codeMetadata?.fenceLength ?? 3,
    startLine,
    endLine,
    headerRange: {
      startLine,
      startCharacter: 0,
      endLine: startLine,
      endCharacter: header.length
    },
    bodyRange: {
      startLine: startLine + 1,
      startCharacter: 0,
      endLine: Math.max(startLine + 1, endLine - 1),
      endCharacter: body.split("\n").at(-1)?.length ?? 0
    },
    fullRange: {
      startLine,
      startCharacter: 0,
      endLine,
      endCharacter: 3
    }
  };
}

function reconcileOutputs(snapshot: NotebookSnapshot, outputs: Map<string, ChunkOutputRecord>): void {
  const liveChunkIds = new Set(snapshot.chunks.map((entry) => entry.chunk.identity.chunkId));

  for (const entry of snapshot.chunks) {
    const record = outputs.get(entry.chunk.identity.chunkId);
    if (!record) {
      continue;
    }

    record.language = entry.chunk.language;
    record.header = entry.chunk.header;
    record.label = entry.chunk.label;
    record.startLine = entry.chunk.startLine;
    record.headerHash = entry.chunk.identity.headerHash;
    record.bodyHash = entry.chunk.identity.bodyHash;
    record.stale = record.contentHash !== entry.chunk.identity.contentHash;
    record.sourceKind = entry.sourceKind;
  }

  for (const [chunkId, record] of outputs) {
    if (!liveChunkIds.has(chunkId)) {
      record.stale = true;
    }
  }
}

function createRecord(
  chunk: ExecutableChunk,
  status: ChunkOutputRecord["status"],
  outputs: ChunkOutputRecord["outputs"],
  sourceKind: "chunk" | "inline" = "chunk"
): ChunkOutputRecord {
  return {
    documentUri: chunk.documentUri,
    chunkId: chunk.identity.chunkId,
    language: chunk.language,
    header: chunk.header,
    label: chunk.label,
    contentHash: chunk.identity.contentHash,
    headerHash: chunk.identity.headerHash,
    bodyHash: chunk.identity.bodyHash,
    startLine: chunk.startLine,
    capturedAt: Date.now(),
    stale: false,
    status,
    outputs,
    sourceKind
  };
}

function createRecordFromResult(
  chunk: ExecutableChunk,
  result: ExecutionResult,
  sourceKind: "chunk" | "inline" = "chunk"
): ChunkOutputRecord {
  return {
    documentUri: chunk.documentUri,
    chunkId: chunk.identity.chunkId,
    language: chunk.language,
    header: chunk.header,
    label: chunk.label,
    contentHash: chunk.identity.contentHash,
    headerHash: chunk.identity.headerHash,
    bodyHash: chunk.identity.bodyHash,
    startLine: chunk.startLine,
    capturedAt: result.finishedAt,
    stale: false,
    status: result.success ? "success" : "error",
    outputs: result.items,
    sourceKind
  };
}

async function createNotebookOutputs(record: ChunkOutputRecord): Promise<vscode.NotebookCellOutput[]> {
  const outputs: vscode.NotebookCellOutput[] = [];

  if (record.stale) {
    outputs.push(
      new vscode.NotebookCellOutput([
        vscode.NotebookCellOutputItem.text("Stale output. Re-run this cell to refresh.", "text/markdown")
      ])
    );
  }

  for (const item of record.outputs) {
    outputs.push(await toNotebookOutput(item));
  }

  return outputs;
}

async function toNotebookOutput(item: OutputItem): Promise<vscode.NotebookCellOutput> {
  if (item.type === "text") {
    return new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.stdout(ensureTrailingNewline(item.text))]);
  }

  if (item.type === "error") {
    return new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.stderr(ensureTrailingNewline(item.text))]);
  }

  if (item.type === "html") {
    return new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.text(item.html, "text/html")]);
  }

  if (item.type === "markdown") {
    return new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.text(item.markdown, "text/markdown")]);
  }

  if (item.type === "mime") {
    const bytes = Buffer.from(item.data, item.encoding === "base64" ? "base64" : "utf8");
    return new vscode.NotebookCellOutput([new vscode.NotebookCellOutputItem(bytes, item.mimeType)]);
  }

  const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(item.path));
  return new vscode.NotebookCellOutput([
    new vscode.NotebookCellOutputItem(bytes, item.mimeType),
    vscode.NotebookCellOutputItem.text(path.basename(item.path))
  ]);
}

function inlineSourceOutputItems(source: string): ChunkOutputRecord["outputs"] {
  return [{ type: "markdown", markdown: source }];
}

function createInlineSourceOutputs(source: string): vscode.NotebookCellOutput[] {
  return [new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.text(source, "text/markdown")])];
}

function createInlineCellData(source: string, expressionCount: number): vscode.NotebookCellData {
  const cell = new vscode.NotebookCellData(vscode.NotebookCellKind.Code, source, "markdown");
  cell.metadata = withInlineChunksMetadata(cell.metadata, { kind: "inline", expressionCount });
  cell.outputs = createInlineSourceOutputs(source);
  return cell;
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}
