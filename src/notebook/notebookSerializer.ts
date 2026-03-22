import * as vscode from "vscode";
import { deserializeNotebookSource, serializeNotebookSource } from "./notebookSource";

export class InlineChunksNotebookSerializer implements vscode.NotebookSerializer {
  public async deserializeNotebook(content: Uint8Array, _token: vscode.CancellationToken): Promise<vscode.NotebookData> {
    return deserializeNotebookSource(content);
  }

  public async serializeNotebook(data: vscode.NotebookData, _token: vscode.CancellationToken): Promise<Uint8Array> {
    return serializeNotebookSource(data);
  }
}
