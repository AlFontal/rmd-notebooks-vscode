import * as vscode from "vscode";
import { ChunkDocumentService } from "../document/chunkDocumentService";
import { createIdentitySeed } from "../document/chunkIdentity";
import { ChunkDocumentSnapshot, ChunkOutputRecord, ExecutableChunk } from "../document/chunkTypes";
import { OutputDecorationController } from "./outputDecorationController";
import { ExecutorRegistry } from "../execution/executorRegistry";
import { ExecutionResult } from "../execution/executorTypes";
import { OutputStore } from "../persistence/outputStore";
import { isSupportedDocument } from "../util/documentMatchers";
import { ChunkCodeLensProvider } from "./chunkCodeLensProvider";
import { OutputChannelController } from "./outputChannelController";

export class EditorController implements vscode.Disposable {
  private readonly loadedDocuments = new Set<string>();
  private readonly outputsByDocument = new Map<string, Map<string, ChunkOutputRecord>>();
  private readonly disposables: vscode.Disposable[] = [];

  public constructor(
    private readonly chunkDocumentService: ChunkDocumentService,
    private readonly outputDecorationController: OutputDecorationController,
    private readonly outputChannelController: OutputChannelController,
    private readonly outputStore: OutputStore,
    private readonly executorRegistry: ExecutorRegistry,
    private readonly codeLensProvider: ChunkCodeLensProvider
  ) {}

  public async initialize(): Promise<void> {
    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument((document) => void this.refreshDocument(document)),
      vscode.workspace.onDidChangeTextDocument((event) => void this.refreshDocument(event.document)),
      vscode.workspace.onDidCloseTextDocument((document) => void this.handleDocumentClosed(document)),
      vscode.window.onDidChangeVisibleTextEditors((editors) => {
        for (const editor of editors) {
          void this.refreshDocument(editor.document);
        }
      })
    );

    for (const document of vscode.workspace.textDocuments) {
      await this.refreshDocument(document);
    }
  }

  public async runCurrentChunk(documentUri?: string, chunkId?: string): Promise<void> {
    const resolved = this.resolveChunkSelection(documentUri, chunkId);
    if (!resolved) {
      void vscode.window.showWarningMessage("Rmd Notebooks: place the cursor inside an executable chunk to run it.");
      return;
    }

    await this.runChunk(resolved.document, resolved.snapshot, resolved.chunk);
  }

  public async runAllChunks(documentUri?: string): Promise<void> {
    const editor = this.resolveEditor(documentUri);
    if (!editor) {
      return;
    }

    const snapshot = await this.refreshDocument(editor.document);
    for (const chunk of snapshot.chunks) {
      await this.runChunk(editor.document, snapshot, chunk);
    }
  }

  public async clearCurrentOutput(documentUri?: string, chunkId?: string): Promise<void> {
    const resolved = this.resolveChunkSelection(documentUri, chunkId);
    if (!resolved) {
      void vscode.window.showWarningMessage("Rmd Notebooks: no executable chunk was found at the current cursor position.");
      return;
    }

    const outputs = await this.ensureOutputsLoaded(resolved.document.uri.toString());
    outputs.delete(resolved.chunk.identity.chunkId);
    await this.outputStore.saveDocumentOutputs(resolved.document.uri.toString(), outputs);
    this.renderDocument(resolved.document.uri, resolved.snapshot, outputs);
  }

  public async clearAllOutputs(documentUri?: string): Promise<void> {
    const editor = this.resolveEditor(documentUri);
    if (!editor) {
      return;
    }

    const outputs = await this.ensureOutputsLoaded(editor.document.uri.toString());
    outputs.clear();
    await this.outputStore.clearDocumentOutputs(editor.document.uri.toString());
    const snapshot = this.chunkDocumentService.getSnapshot(editor.document.uri);
    if (snapshot) {
      this.renderDocument(editor.document.uri, snapshot, outputs);
    }
  }

  public async getDocumentState(documentUri: string): Promise<{
    snapshot: ChunkDocumentSnapshot | undefined;
    outputs: ChunkOutputRecord[];
    outputChannelText: string;
  }> {
    const uri = vscode.Uri.parse(documentUri);
    const snapshot = this.chunkDocumentService.getSnapshot(uri);
    const outputs = await this.ensureOutputsLoaded(documentUri);
    return {
      snapshot,
      outputs: [...outputs.values()],
      outputChannelText: this.outputChannelController.getTranscript()
    };
  }

  public showOutputChannel(): void {
    this.outputChannelController.reveal();
  }

  public dispose(): void {
    this.disposables.forEach((disposable) => disposable.dispose());
  }

  private async refreshDocument(document: vscode.TextDocument): Promise<ChunkDocumentSnapshot> {
    if (!isSupportedDocument(document)) {
      return (
        this.chunkDocumentService.getSnapshot(document.uri) ?? {
          documentUri: document.uri.toString(),
          version: document.version,
          chunks: [],
          generatedAt: Date.now()
        }
      );
    }

    const documentUri = document.uri.toString();
    const existingOutputs = await this.ensureOutputsLoaded(documentUri);
    const previousSnapshot = this.chunkDocumentService.getSnapshot(document.uri);
    const previousSeeds = previousSnapshot
      ? previousSnapshot.chunks.map((chunk) => createIdentitySeed(chunk))
      : this.outputStore.toIdentitySeeds(existingOutputs.values());

    const snapshot = this.chunkDocumentService.buildSnapshot(document, previousSeeds);
    reconcileOutputs(snapshot, existingOutputs);
    await this.outputStore.saveDocumentOutputs(documentUri, existingOutputs);
    this.renderDocument(document.uri, snapshot, existingOutputs);
    this.loadedDocuments.add(documentUri);
    this.codeLensProvider.refresh();
    return snapshot;
  }

  private async handleDocumentClosed(document: vscode.TextDocument): Promise<void> {
    if (!isSupportedDocument(document)) {
      return;
    }

    this.chunkDocumentService.deleteSnapshot(document.uri);
    const executor = this.executorRegistry.get("r");
    if (executor?.disposeSession) {
      await executor.disposeSession(document.uri.toString());
    }
  }

  private renderDocument(uri: vscode.Uri, snapshot: ChunkDocumentSnapshot, outputs: Map<string, ChunkOutputRecord>): void {
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.toString() === uri.toString()) {
        this.outputDecorationController.render(editor, snapshot, outputs);
      }
    }
  }

  private async runChunk(
    document: vscode.TextDocument,
    snapshot: ChunkDocumentSnapshot,
    chunk: ExecutableChunk
  ): Promise<void> {
    const executor = this.executorRegistry.get(chunk.language);
    const outputs = await this.ensureOutputsLoaded(document.uri.toString());

    if (!executor) {
      const unsupportedRecord = createRecord(chunk, "error", [{ type: "error", text: `No executor registered for language "${chunk.language}".` }]);
      outputs.set(chunk.identity.chunkId, unsupportedRecord);
      await this.outputStore.saveDocumentOutputs(document.uri.toString(), outputs);
      this.renderDocument(document.uri, snapshot, outputs);
      this.outputChannelController.logRunCompleted(document, chunk, unsupportedRecord);
      return;
    }

    const runningRecord = createRecord(chunk, "running", []);
    outputs.set(chunk.identity.chunkId, runningRecord);
    await this.outputStore.saveDocumentOutputs(document.uri.toString(), outputs);
    this.renderDocument(document.uri, snapshot, outputs);
    this.outputChannelController.logRunStarted(document, chunk);

    try {
      const result = await executor.executeChunk({
        documentUri: document.uri.toString(),
        workspaceFolder: vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath,
        chunkId: chunk.identity.chunkId,
        language: chunk.language,
        code: chunk.body,
        header: chunk.header,
        artifactDirectory: await this.outputStore.getArtifactDirectory(document.uri.toString())
      });

      const record = createRecordFromResult(chunk, result);
      outputs.set(chunk.identity.chunkId, record);
      this.outputChannelController.logRunCompleted(document, chunk, record);
    } catch (error) {
      const record = createRecord(
        chunk,
        "error",
        [
          {
            type: "error",
            text: error instanceof Error ? error.message : String(error)
          }
        ]
      );
      outputs.set(
        chunk.identity.chunkId,
        record
      );
      this.outputChannelController.logRunCompleted(document, chunk, record);
    }

    await this.outputStore.saveDocumentOutputs(document.uri.toString(), outputs);
    this.renderDocument(document.uri, snapshot, outputs);
  }

  private resolveChunkSelection(
    documentUri?: string,
    chunkId?: string
  ): { document: vscode.TextDocument; snapshot: ChunkDocumentSnapshot; chunk: ExecutableChunk } | undefined {
    const editor = this.resolveEditor(documentUri);
    if (!editor) {
      return undefined;
    }

    const snapshot = this.chunkDocumentService.getSnapshot(editor.document.uri);
    if (!snapshot) {
      return undefined;
    }

    const chunk =
      (chunkId ? snapshot.chunks.find((candidate) => candidate.identity.chunkId === chunkId) : undefined) ??
      this.chunkDocumentService.findChunkAtPosition(editor.document, editor.selection.active);

    if (!chunk) {
      return undefined;
    }

    return { document: editor.document, snapshot, chunk };
  }

  private resolveEditor(documentUri?: string): vscode.TextEditor | undefined {
    if (!documentUri) {
      return vscode.window.activeTextEditor;
    }

    return vscode.window.visibleTextEditors.find((editor) => editor.document.uri.toString() === documentUri);
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
}

function reconcileOutputs(snapshot: ChunkDocumentSnapshot, outputs: Map<string, ChunkOutputRecord>): void {
  const liveChunkIds = new Set(snapshot.chunks.map((chunk) => chunk.identity.chunkId));

  for (const chunk of snapshot.chunks) {
    const record = outputs.get(chunk.identity.chunkId);
    if (!record) {
      continue;
    }

    record.language = chunk.language;
    record.header = chunk.header;
    record.label = chunk.label;
    record.startLine = chunk.startLine;
    record.headerHash = chunk.identity.headerHash;
    record.bodyHash = chunk.identity.bodyHash;
    record.stale = record.contentHash !== chunk.identity.contentHash;
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
