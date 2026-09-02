import * as vscode from "vscode";
import { registerCommands } from "./commands/registerCommands";
import { OutputChannelController } from "./editor/outputChannelController";
import { ExecutorRegistry } from "./execution/executorRegistry";
import { PythonExecutor } from "./execution/pythonExecutor";
import { RExecutor } from "./execution/rExecutor";
import { RTerminalRunner } from "./execution/rTerminalRunner";
import { PythonEnvironmentDiscovery } from "./integration/pythonEnvironmentDiscovery";
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
  getPythonEnvironmentState(documentUri: string): {
    environments: Array<{ id: string; path: string; label: string }>;
    selectedPath?: string;
  };
  selectTestPythonInterpreter(documentUri: string, executable: string): Promise<void>;
}

export async function activate(context: vscode.ExtensionContext): Promise<InlineChunksExtensionApi> {
  const outputChannelController = new OutputChannelController();
  const outputStore = new OutputStore(context);
  const executorRegistry = new ExecutorRegistry();
  const rExecutor = new RExecutor(context.extensionUri);
  const pythonExecutor = new PythonExecutor(context.extensionUri);
  const terminalRunner = new RTerminalRunner();
  executorRegistry.register(rExecutor);
  executorRegistry.register(pythonExecutor);

  const pythonEnvironmentDiscovery = new PythonEnvironmentDiscovery();
  const notebookRuntime = new InlineChunksNotebookRuntime(
    outputStore,
    executorRegistry,
    outputChannelController,
    terminalRunner,
    pythonExecutor,
    pythonEnvironmentDiscovery,
    context.workspaceState
  );
  const cellStatusBarProvider = new InlineChunksCellStatusBarProvider(notebookRuntime);

  context.subscriptions.push(
    outputChannelController,
    terminalRunner,
    vscode.workspace.registerNotebookSerializer(INLINE_CHUNKS_NOTEBOOK_TYPE, new InlineChunksNotebookSerializer(), {
      transientOutputs: true
    }),
    vscode.notebooks.registerNotebookCellStatusBarItemProvider(INLINE_CHUNKS_NOTEBOOK_TYPE, cellStatusBarProvider),
    notebookRuntime,
    pythonEnvironmentDiscovery,
    ...registerCommands(notebookRuntime),
    new vscode.Disposable(() => void Promise.all(executorRegistry.all().map((executor) => executor.disposeAll?.())))
  );

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
    takeTestPromptRequests: () => notebookRuntime.takeTestPromptRequests(),
    getPythonEnvironmentState: (documentUri) => notebookRuntime.getPythonEnvironmentState(documentUri),
    selectTestPythonInterpreter: (documentUri, executable) =>
      notebookRuntime.selectTestPythonInterpreter(documentUri, executable)
  };
}

export function deactivate(): void {}
