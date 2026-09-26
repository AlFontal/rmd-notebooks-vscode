import * as vscode from "vscode";
import { InlineChunksNotebookRuntime } from "../notebook/notebookRuntime";
import { INLINE_CHUNKS_NOTEBOOK_TYPE, isInlineChunksNotebook } from "../notebook/notebookTypes";
import { previewActiveNotebookHtml } from "./previewHtml";

export function registerCommands(controller: InlineChunksNotebookRuntime): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("rmdNotebooks.runCurrentChunk", async (documentUri?: string, chunkId?: string) => {
      await controller.runCurrentChunk(documentUri, chunkId);
    }),
    vscode.commands.registerCommand("rmdNotebooks.runAllChunks", async (documentUri?: string) => {
      await controller.runAllChunks(documentUri);
    }),
    vscode.commands.registerCommand(
      "rmdNotebooks.runInlineCell",
      async (documentUri?: string, chunkId?: string, cellIndex?: number) => {
        await controller.runInlineCell(documentUri, chunkId, cellIndex);
      }
    ),
    vscode.commands.registerCommand("rmdNotebooks.interruptSession", async (documentUri?: string) => {
      await controller.interruptSession(documentUri);
    }),
    vscode.commands.registerCommand("rmdNotebooks.clearCurrentOutput", async (documentUri?: string, chunkId?: string) => {
      await controller.clearCurrentOutput(documentUri, chunkId);
    }),
    vscode.commands.registerCommand("rmdNotebooks.clearAllOutputs", async (documentUri?: string) => {
      await controller.clearAllOutputs(documentUri);
    }),
    vscode.commands.registerCommand("rmdNotebooks.restartSession", async (documentUri?: string) => {
      await controller.restartSession(documentUri);
    }),
    vscode.commands.registerCommand("rmdNotebooks.selectPythonEnvironment", async (documentUri?: string) => {
      await controller.selectPythonEnvironment(documentUri);
    }),
    vscode.commands.registerCommand("rmdNotebooks.runCurrentChunkInTerminal", async (documentUri?: string, chunkId?: string) => {
      await controller.runCurrentChunkInTerminal(documentUri, chunkId);
    }),
    vscode.commands.registerCommand("rmdNotebooks.showOutputChannel", () => {
      controller.showOutputChannel();
    }),
    vscode.commands.registerCommand("rmdNotebooks.previewHtml", async () => {
      await previewActiveNotebookHtml(controller.getSelectedPythonRenderPath());
    }),
    vscode.commands.registerCommand(
      "rmdNotebooks.editChunkHeader",
      async (documentUri?: string, chunkId?: string, overrideHeaderInfo?: string) => {
        await controller.editChunkHeader(documentUri, chunkId, overrideHeaderInfo);
      }
    ),
    vscode.commands.registerCommand("rmdNotebooks.viewSource", async () => {
      await toggleSourceView();
    }),
    vscode.commands.registerCommand("rmdNotebooks.toggleSourceView", async () => {
      await toggleSourceView();
    })
  ];
}

async function toggleSourceView(): Promise<void> {
  const activeNotebookEditor = vscode.window.activeNotebookEditor;
  if (activeNotebookEditor && isInlineChunksNotebook(activeNotebookEditor.notebook)) {
    // Save through VS Code rather than writing the file directly, so the notebook is
    // not left dirty with a later save able to overwrite edits made in the raw view.
    const notebook = activeNotebookEditor.notebook;
    if (notebook.isDirty && !(await notebook.save())) {
      void vscode.window.showWarningMessage("Rmd Notebooks: save the notebook before switching to the raw source view.");
      return;
    }

    const document = await vscode.workspace.openTextDocument(activeNotebookEditor.notebook.uri);
    await vscode.window.showTextDocument(document, {
      preview: false,
      viewColumn: activeNotebookEditor.viewColumn
    });
    return;
  }

  const activeTextEditor = vscode.window.activeTextEditor;
  const targetUri = activeTextEditor?.document.uri;
  if (targetUri && isChunkSourceUri(targetUri)) {
    // The notebook view loads from disk, so unsaved raw edits would not appear in it.
    if (activeTextEditor.document.isDirty && !(await activeTextEditor.document.save())) {
      void vscode.window.showWarningMessage("Rmd Notebooks: save the file before switching to the notebook view.");
      return;
    }
    await vscode.commands.executeCommand("vscode.openWith", targetUri, INLINE_CHUNKS_NOTEBOOK_TYPE);
    return;
  }

  void vscode.window.showWarningMessage("Rmd Notebooks: open a .qmd or .Rmd file to switch views.");
}

function isChunkSourceUri(uri: vscode.Uri): boolean {
  const lowerPath = uri.path.toLowerCase();
  return lowerPath.endsWith(".qmd") || lowerPath.endsWith(".rmd");
}
