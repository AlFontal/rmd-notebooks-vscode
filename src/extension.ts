import * as vscode from "vscode";
import { registerCommands } from "./commands/registerCommands";
import { OutputChannelController } from "./editor/outputChannelController";
import { ExecutorRegistry } from "./execution/executorRegistry";
import { RExecutor } from "./execution/rExecutor";
import { RTerminalRunner } from "./execution/rTerminalRunner";
import { InlineChunksCellStatusBarProvider } from "./notebook/cellStatusBarProvider";
import { InlineChunksNotebookRuntime } from "./notebook/notebookRuntime";
import { InlineChunksNotebookSerializer } from "./notebook/notebookSerializer";
import { INLINE_CHUNKS_NOTEBOOK_TYPE } from "./notebook/notebookTypes";
import { OutputStore } from "./persistence/outputStore";

export interface InlineChunksExtensionApi {
  getDocumentState(documentUri: string): Promise<{
    snapshot: {
      documentUri: string;
      version: number;
      chunkIds: string[];
    } | undefined;
    outputs: Array<{
      chunkId: string;
      status: string;
      stale: boolean;
      outputTypes: string[];
    }>;
    outputChannelText: string;
  }>;
}

export async function activate(context: vscode.ExtensionContext): Promise<InlineChunksExtensionApi> {
  const outputChannelController = new OutputChannelController();
  const outputStore = new OutputStore(context);
  const executorRegistry = new ExecutorRegistry();
  const rExecutor = new RExecutor(context.extensionUri);
  const terminalRunner = new RTerminalRunner();
  executorRegistry.register(rExecutor);
  const cellStatusBarProvider = new InlineChunksCellStatusBarProvider();

  const notebookRuntime = new InlineChunksNotebookRuntime(outputStore, executorRegistry, outputChannelController, terminalRunner);

  context.subscriptions.push(
    outputChannelController,
    terminalRunner,
    vscode.workspace.registerNotebookSerializer(INLINE_CHUNKS_NOTEBOOK_TYPE, new InlineChunksNotebookSerializer(), {
      transientOutputs: true,
      transientCellMetadata: {
        rmdNotebooks: true
      }
    }),
    vscode.notebooks.registerNotebookCellStatusBarItemProvider(INLINE_CHUNKS_NOTEBOOK_TYPE, cellStatusBarProvider),
    notebookRuntime,
    ...registerCommands(notebookRuntime),
    new vscode.Disposable(() => void rExecutor.disposeAll())
  );

  await notebookRuntime.initialize();

  return {
    getDocumentState: async (documentUri: string) => notebookRuntime.getDocumentState(documentUri)
  };
}

export function deactivate(): void {}
