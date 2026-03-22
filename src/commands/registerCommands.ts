import * as vscode from "vscode";
import { InlineChunksNotebookRuntime } from "../notebook/notebookRuntime";
import { serializeNotebookSource } from "../notebook/notebookSource";
import { INLINE_CHUNKS_NOTEBOOK_TYPE, isInlineChunksNotebook } from "../notebook/notebookTypes";

export function registerCommands(controller: InlineChunksNotebookRuntime): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand("rmdNotebooks.runCurrentChunk", async (documentUri?: string, chunkId?: string) => {
      await controller.runCurrentChunk(documentUri, chunkId);
    }),
    vscode.commands.registerCommand("rmdNotebooks.runAllChunks", async (documentUri?: string) => {
      await controller.runAllChunks(documentUri);
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
    vscode.commands.registerCommand("rmdNotebooks.runCurrentChunkInTerminal", async (documentUri?: string, chunkId?: string) => {
      await controller.runCurrentChunkInTerminal(documentUri, chunkId);
    }),
    vscode.commands.registerCommand("rmdNotebooks.showOutputChannel", () => {
      controller.showOutputChannel();
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
    await persistNotebookSource(activeNotebookEditor.notebook);

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
    await vscode.commands.executeCommand("vscode.openWith", targetUri, INLINE_CHUNKS_NOTEBOOK_TYPE);
    return;
  }

  void vscode.window.showWarningMessage("Rmd Notebooks: open a .qmd or .Rmd file to switch views.");
}

function isChunkSourceUri(uri: vscode.Uri): boolean {
  const lowerPath = uri.path.toLowerCase();
  return lowerPath.endsWith(".qmd") || lowerPath.endsWith(".rmd");
}

async function persistNotebookSource(notebook: vscode.NotebookDocument): Promise<void> {
  const cells = notebook.getCells().map((cell) => {
    const cellData = new vscode.NotebookCellData(cell.kind, cell.document.getText(), cell.document.languageId);
    cellData.metadata = cell.metadata;
    return cellData;
  });

  const serialized = serializeNotebookSource(new vscode.NotebookData(cells));
  await vscode.workspace.fs.writeFile(notebook.uri, serialized);
}
