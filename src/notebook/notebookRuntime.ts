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

interface NotebookChunkCell {
  index: number;
  cell: vscode.NotebookCell;
  chunk: ExecutableChunk;
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
  private readonly executionAdmissions = new Map<string, Promise<void>>();
  // Notebooks whose in-flight Run All / multi-cell run should stop before the next
  // cell. Set by interruptSession ("Stop All"), checked between cells in the run loops.
  private readonly runsToAbort = new Set<string>();
  private testPromptResponses: InteractivePromptResponse[] = [];
  private readonly testPromptRequests: InteractivePromptRequest[] = [];
  private executionOrder = 0;
  private readonly controller: vscode.NotebookController;

  public constructor(
    private readonly outputStore: OutputStore,
    private readonly executorRegistry: ExecutorRegistry,
    private readonly outputChannelController: OutputChannelController,
    private readonly terminalRunner: RTerminalRunner
  ) {
    this.controller = vscode.notebooks.createNotebookController(
      "rmd-notebooks-vscode-controller",
      INLINE_CHUNKS_NOTEBOOK_TYPE,
      "Rmd Notebooks"
    );
    this.controller.supportedLanguages = ["r"];
    this.controller.supportsExecutionOrder = true;
    this.controller.executeHandler = async (cells, notebook) => {
      const documentUri = notebook.uri.toString();
      this.runsToAbort.delete(documentUri);
      for (const cell of cells) {
        if (this.runsToAbort.has(documentUri)) {
          break;
        }
        await this.executeCell(notebook, cell);
      }
      this.runsToAbort.delete(documentUri);
    };
    // No interruptHandler on purpose: with one, VS Code never fires per-cell
    // cancellation tokens (it would interrupt the whole session instead). Relying on
    // the tokens lets stopping one cell cancel just that cell, while leaving the
    // others running or queued. "Stop All" is offered separately via interruptSession.
  }

  public async initialize(): Promise<void> {
    this.disposables.push(
      this.controller,
      vscode.workspace.onDidOpenNotebookDocument((notebook) => void this.handleNotebookOpened(notebook)),
      vscode.workspace.onDidChangeNotebookDocument((event) => void this.handleNotebookChanged(event)),
      vscode.workspace.onDidCloseNotebookDocument((notebook) => void this.handleNotebookClosed(notebook)),
      vscode.window.onDidChangeActiveNotebookEditor((editor) => {
        if (editor && isInlineChunksNotebook(editor.notebook)) {
          void this.restoreOutputsToNotebook(editor.notebook);
        }
      })
    );

    for (const notebook of vscode.workspace.notebookDocuments) {
      await this.handleNotebookOpened(notebook);
    }
  }

  public async runCurrentChunk(documentUri?: string, chunkId?: string): Promise<void> {
    const resolved = await this.resolveCodeCell(documentUri, chunkId);
    if (!resolved) {
      void vscode.window.showWarningMessage("Rmd Notebooks: select an R code cell to run it.");
      return;
    }

    await this.executeCell(resolved.notebook, resolved.cell);
  }

  public async runAllChunks(documentUri?: string): Promise<void> {
    const notebook = this.resolveNotebook(documentUri);
    if (!notebook) {
      return;
    }

    const uri = notebook.uri.toString();
    this.runsToAbort.delete(uri);
    const snapshot = await this.refreshNotebook(notebook);
    for (const entry of snapshot.chunks) {
      if (this.runsToAbort.has(uri)) {
        break;
      }
      const outcome = await this.executeCell(notebook, entry.cell);
      if (outcome === "redirected") {
        break;
      }
    }
    this.runsToAbort.delete(uri);
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
    const executor = this.executorRegistry.get("r");
    await executor?.interruptSession?.(notebook.uri.toString());
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
    const selected = await this.ensureControllerSelected(resolved.notebook);
    if (!selected) {
      return;
    }
    await this.withOutputSync(resolved.notebook.uri.toString(), async () => {
      const execution = this.controller.createNotebookCellExecution(resolved.notebook.cellAt(entry.index));
      execution.start(Date.now());
      await execution.clearOutput();
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
    const selected = await this.ensureControllerSelected(notebook);
    if (!selected) {
      return;
    }

    await this.withOutputSync(notebook.uri.toString(), async () => {
      for (const entry of snapshot.chunks) {
        const execution = this.controller.createNotebookCellExecution(notebook.cellAt(entry.index));
        execution.start(Date.now());
        await execution.clearOutput();
        execution.end(undefined, Date.now());
      }
    });
  }

  public getChunkIdForCell(documentUri: string, cellIndex: number): string | undefined {
    const snapshot = this.snapshots.get(documentUri);
    return snapshot?.chunks.find((entry) => entry.index === cellIndex)?.chunk.identity.chunkId;
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
    this.disposables.forEach((disposable) => disposable.dispose());
  }

  private async handleNotebookOpened(notebook: vscode.NotebookDocument): Promise<void> {
    if (!isInlineChunksNotebook(notebook)) {
      return;
    }

    this.controller.updateNotebookAffinity(notebook, vscode.NotebookControllerAffinity.Preferred);
    await this.refreshNotebook(notebook);
    await this.restoreOutputsToNotebook(notebook);
  }

  private async handleNotebookChanged(event: vscode.NotebookDocumentChangeEvent): Promise<void> {
    const notebook = event.notebook;
    const documentUri = notebook.uri.toString();
    if (!isInlineChunksNotebook(notebook) || this.metadataSyncInFlight.has(documentUri) || this.outputSyncInFlight.has(documentUri)) {
      return;
    }

    await this.refreshNotebook(notebook);
  }

  private async handleNotebookClosed(notebook: vscode.NotebookDocument): Promise<void> {
    if (!isInlineChunksNotebook(notebook)) {
      return;
    }

    this.snapshots.delete(notebook.uri.toString());
    const executor = this.executorRegistry.get("r");
    await executor?.disposeSession?.(notebook.uri.toString());
  }

  private async executeCell(notebook: vscode.NotebookDocument, cell: vscode.NotebookCell): Promise<ExecuteCellOutcome> {
    if (cell.kind !== vscode.NotebookCellKind.Code) {
      return "completed";
    }

    const releaseAdmission = await this.acquireExecutionAdmission(notebook.uri.toString());
    try {
      return await this.executeAdmittedCell(notebook, cell, releaseAdmission);
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

    const outputs = await this.ensureOutputsLoaded(notebook.uri.toString());
    const executor = this.executorRegistry.get(entry.chunk.language);
    const chunkOptions = getChunkOptions(cell);
    const selected = await this.ensureControllerSelected(notebook);
    if (!selected) {
      return "completed";
    }
    const execution = this.controller.createNotebookCellExecution(notebook.cellAt(entry.index));
    // Leave the cell in the "queued" (pending clock) state until the chunk actually
    // begins running in R, instead of marking it running the moment it is enqueued.
    // That way every cell's reported duration is its own run time, not the time since
    // the first queued chunk started, and cells waiting their turn show the queued
    // badge rather than a spinner, exactly like Run All. start() must precede end(),
    // so paths that never reach R still call this before ending the execution.
    let executionStarted = false;
    const beginExecutionDisplay = (startTime?: number, assignOrder = true): void => {
      if (executionStarted) {
        return;
      }
      executionStarted = true;
      if (assignOrder) {
        execution.executionOrder = ++this.executionOrder;
      }
      execution.start(startTime);
    };

    if (chunkOptions?.eval === false) {
      beginExecutionDisplay(Date.now());
      const skippedRecord = createRecord(entry.chunk, "success", []);
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
        {
          type: "error",
          text: `No executor registered for language "${entry.chunk.language}".`
        }
      ]);
      outputs.set(entry.chunk.identity.chunkId, record);
      await this.outputStore.saveDocumentOutputs(notebook.uri.toString(), outputs);
      await this.withOutputSync(notebook.uri.toString(), async () => {
        await execution.replaceOutput(await createNotebookOutputs(record));
      });
      execution.end(false, Date.now());
      this.outputChannelController.logRunCompleted(cell.document, entry.chunk, record);
      return "completed";
    }

    const runningRecord = createRecord(entry.chunk, "running", []);
    outputs.set(entry.chunk.identity.chunkId, runningRecord);
    await this.outputStore.saveDocumentOutputs(notebook.uri.toString(), outputs);
    this.outputChannelController.logRunStarted(cell.document, entry.chunk);

    try {
      const resultPromise = executor.executeChunk({
        documentUri: notebook.uri.toString(),
        workspaceFolder: vscode.workspace.getWorkspaceFolder(notebook.uri)?.uri.fsPath,
        chunkId: entry.chunk.identity.chunkId,
        language: entry.chunk.language,
        code: cell.document.getText(),
        header: entry.chunk.header,
        artifactDirectory: await this.outputStore.getArtifactDirectory(notebook.uri.toString()),
        plot: resolvePlotRenderOptions(chunkOptions),
        prompt: (request) => this.promptForChunkInput(notebook, cell, entry.chunk, request),
        onStart: () => beginExecutionDisplay(Date.now()),
        token: execution.token
      });
      releaseAdmission();
      const result = await resultPromise;

      const filteredResult = applyChunkOptionsToResult(result, chunkOptions);
      // onStart always fires (in the session's beginExecution) before any result can
      // arrive, so the cell is already marked running here; this call is only a
      // fallback for the impossible case where onStart was skipped, and is a no-op
      // otherwise. The displayed start time therefore comes from onStart (Date.now at
      // dequeue), not from filteredResult.startedAt.
      beginExecutionDisplay(filteredResult.startedAt);
      const record = createRecordFromResult(entry.chunk, filteredResult);
      outputs.set(entry.chunk.identity.chunkId, record);
      await this.outputStore.saveDocumentOutputs(notebook.uri.toString(), outputs);
      await this.withOutputSync(notebook.uri.toString(), async () => {
        if (record.outputs.length === 0) {
          await execution.clearOutput();
        } else {
          await execution.replaceOutput(await createNotebookOutputs(record));
        }
      });
      execution.end(filteredResult.success, filteredResult.finishedAt);
      this.outputChannelController.logRunCompleted(cell.document, entry.chunk, record);
      return "completed";
    } catch (error) {
      if (error instanceof InteractiveExecutionError) {
        // The chunk did start running (it timed out mid-execution), so the cell is
        // already showing as running by now; this only matters as a safeguard.
        beginExecutionDisplay(Date.now());
        const fallback = await this.handleInteractiveFallback(notebook, cell, entry.chunk, outputs, execution, error.message);
        this.outputChannelController.logRunCompleted(cell.document, entry.chunk, fallback.record);
        return fallback.launchedTerminal ? "redirected" : "completed";
      }

      if (error instanceof CancelledExecutionError) {
        // The chunk was interrupted while still waiting in the queue, so it never
        // ran. End the still-pending execution without assigning a run order or a
        // duration (start() must be called before end(), but with no start time so
        // no clock is shown), and clear it without flagging it as a failure.
        beginExecutionDisplay(undefined, false);
        const cancelledRecord = createRecord(entry.chunk, "cancelled", []);
        outputs.set(entry.chunk.identity.chunkId, cancelledRecord);
        await this.outputStore.saveDocumentOutputs(notebook.uri.toString(), outputs);
        await this.withOutputSync(notebook.uri.toString(), async () => {
          await execution.clearOutput();
        });
        execution.end(undefined, Date.now());
        this.outputChannelController.logRunCompleted(cell.document, entry.chunk, cancelledRecord);
        return "completed";
      }

      beginExecutionDisplay(Date.now());
      const record = createRecord(entry.chunk, "error", [
        {
          type: "error",
          text: error instanceof Error ? error.message : String(error)
        }
      ]);
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
    if (!resolved) {
      void vscode.window.showWarningMessage("Rmd Notebooks: select an R code cell to run it in the terminal.");
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
      void vscode.window.showWarningMessage("Rmd Notebooks: open a notebook to restart its R session.");
      return;
    }

    const executor = this.executorRegistry.get("r");
    if (!executor?.disposeSession) {
      void vscode.window.showWarningMessage("Rmd Notebooks: no restartable R session is available.");
      return;
    }

    await executor.disposeSession(notebook.uri.toString());
    void vscode.window.setStatusBarMessage("Rmd Notebooks: restarted R session", 2500);
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

  private async restoreOutputsToNotebook(notebook: vscode.NotebookDocument): Promise<void> {
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
      if (!record) {
        return false;
      }
      return notebook.cellAt(entry.index).outputs.length === 0;
    });
    if (pending.length === 0) {
      return;
    }

    const selected = await this.ensureControllerSelected(notebook);
    if (!selected) {
      return;
    }
    await this.withOutputSync(notebook.uri.toString(), async () => {
      for (const entry of pending) {
        const record = outputs.get(entry.chunk.identity.chunkId);
        if (!record) {
          continue;
        }

        const execution = this.controller.createNotebookCellExecution(notebook.cellAt(entry.index));
        // Restoring previously captured output is not a real run, so omit the
        // timestamps: passing capturedAt (in the past) as the end time made
        // VS Code render a negative duration like "-50.-4s".
        execution.start();
        await execution.replaceOutput(await createNotebookOutputs(record));
        execution.end(record.status === "success");
      }
    });
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
    chunkId?: string
  ): Promise<{ notebook: vscode.NotebookDocument; cell: vscode.NotebookCell } | undefined> {
    const notebook = this.resolveNotebook(documentUri);
    if (!notebook) {
      return undefined;
    }

    const snapshot = await this.refreshNotebook(notebook);
    if (chunkId) {
      const entry = snapshot.chunks.find((candidate) => candidate.chunk.identity.chunkId === chunkId);
      return entry ? { notebook, cell: entry.cell } : undefined;
    }

    const selection = vscode.window.activeNotebookEditor?.notebook.uri.toString() === notebook.uri.toString()
      ? vscode.window.activeNotebookEditor.selection
      : new vscode.NotebookRange(0, 1);

    for (let index = selection.start; index < selection.end; index += 1) {
      const cell = notebook.cellAt(index);
      if (cell.kind === vscode.NotebookCellKind.Code) {
        return { notebook, cell };
      }
    }

    const activeCell = notebook.cellAt(Math.min(selection.start, Math.max(notebook.cellCount - 1, 0)));
    return activeCell.kind === vscode.NotebookCellKind.Code ? { notebook, cell: activeCell } : undefined;
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

  private async ensureControllerSelected(notebook: vscode.NotebookDocument): Promise<boolean> {
    const activeEditor = vscode.window.activeNotebookEditor;
    if (!activeEditor || activeEditor.notebook.uri.toString() !== notebook.uri.toString()) {
      return false;
    }

    await vscode.commands.executeCommand("_notebook.selectKernel", {
      id: this.controller.id,
      extension: "AlFontal.rmd-notebooks-vscode"
    });

    return true;
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
    .filter((cell) => cell.kind === vscode.NotebookCellKind.Code)
    .map((cell) => ({
      cell,
      index: cell.index,
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
      chunk: chunks[index]
    })),
    generatedAt: Date.now()
  };
}

function toParsedChunk(notebook: vscode.NotebookDocument, cell: vscode.NotebookCell): ParsedExecutableChunk {
  const metadata = getInlineChunksMetadata(cell.metadata);
  const codeMetadata = metadata?.kind === "code" ? metadata : undefined;
  const header = codeMetadata?.header ?? `\`\`\`{${cell.document.languageId}}`;
  const body = cell.document.getText();
  const startLine = cell.index * 2;
  const bodyLineCount = body.length === 0 ? 0 : body.replace(/\r\n/g, "\n").split("\n").length;
  const endLine = startLine + bodyLineCount + 1;

  return {
    documentUri: notebook.uri.toString(),
    language: cell.document.languageId,
    header,
    headerInfo: codeMetadata?.headerInfo ?? cell.document.languageId,
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
  }

  for (const [chunkId, record] of outputs) {
    if (!liveChunkIds.has(chunkId)) {
      record.stale = true;
    }
  }
}

function createRecord(chunk: ExecutableChunk, status: ChunkOutputRecord["status"], outputs: ChunkOutputRecord["outputs"]): ChunkOutputRecord {
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
    outputs
  };
}

function createRecordFromResult(chunk: ExecutableChunk, result: ExecutionResult): ChunkOutputRecord {
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
    outputs: result.items
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

  const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(item.path));
  return new vscode.NotebookCellOutput([
    new vscode.NotebookCellOutputItem(bytes, item.mimeType),
    vscode.NotebookCellOutputItem.text(path.basename(item.path))
  ]);
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}
