import * as vscode from "vscode";
import { registerCommands } from "./commands/registerCommands";
import { updatePreviewIntegrationContexts } from "./commands/previewHtml";
import { OutputChannelController } from "./editor/outputChannelController";
import { ExecutorRegistry } from "./execution/executorRegistry";
import { RExecutor } from "./execution/rExecutor";
import { RTerminalRunner } from "./execution/rTerminalRunner";
import { maybeRecommendRExtension } from "./integration/rExtensionRecommendation";
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
  setTestPromptResponses(responses: Array<{ cancelled?: boolean; value?: string }>): void;
  clearTestPromptResponses(): void;
  takeTestPromptRequests(): Array<{
    kind: string;
    title?: string;
    prompt: string;
    placeHolder?: string;
    defaultValue?: string;
    allowEmpty?: boolean;
    choices?: Array<{
      label: string;
      value: string;
      description?: string;
    }>;
  }>;
}

export async function activate(context: vscode.ExtensionContext): Promise<InlineChunksExtensionApi> {
  const outputChannelController = new OutputChannelController();
  const outputStore = new OutputStore(context);
  const executorRegistry = new ExecutorRegistry();
  const rExecutor = new RExecutor(context.extensionUri);
  const terminalRunner = new RTerminalRunner();
  executorRegistry.register(rExecutor);

  const notebookRuntime = new InlineChunksNotebookRuntime(outputStore, executorRegistry, outputChannelController, terminalRunner);
  const cellStatusBarProvider = new InlineChunksCellStatusBarProvider(notebookRuntime);

  context.subscriptions.push(
    outputChannelController,
    terminalRunner,
    vscode.workspace.registerNotebookSerializer(INLINE_CHUNKS_NOTEBOOK_TYPE, new InlineChunksNotebookSerializer(), {
      transientOutputs: true
    }),
    vscode.notebooks.registerNotebookCellStatusBarItemProvider(INLINE_CHUNKS_NOTEBOOK_TYPE, cellStatusBarProvider),
    notebookRuntime,
    ...registerCommands(notebookRuntime),
    vscode.extensions.onDidChange(() => void updatePreviewIntegrationContexts()),
    new vscode.Disposable(() => void rExecutor.disposeAll())
  );

  await updatePreviewIntegrationContexts();
  await notebookRuntime.initialize();
  const recommendationTimer = setTimeout(() => void maybeRecommendRExtension(context), 2000);
  context.subscriptions.push(new vscode.Disposable(() => clearTimeout(recommendationTimer)));

  return {
    getDocumentState: async (documentUri: string) => notebookRuntime.getDocumentState(documentUri),
    setTestPromptResponses: (responses) =>
      notebookRuntime.setTestPromptResponses(
        responses.map((response) => ({
          cancelled: response.cancelled ?? false,
          value: response.value
        }))
      ),
    clearTestPromptResponses: () => notebookRuntime.clearTestPromptResponses(),
    takeTestPromptRequests: () => notebookRuntime.takeTestPromptRequests()
  };
}

export function deactivate(): void {}
