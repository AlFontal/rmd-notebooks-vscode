import * as vscode from "vscode";
import { formatChunkHeaderBadge, formatChunkHeaderTooltip } from "./metadataDisplay";
import { getInlineChunksMetadata, INLINE_CHUNKS_NOTEBOOK_TYPE } from "./notebookTypes";

export class InlineChunksCellStatusBarProvider implements vscode.NotebookCellStatusBarItemProvider {
  public provideCellStatusBarItems(
    cell: vscode.NotebookCell,
    _token: vscode.CancellationToken
  ): vscode.NotebookCellStatusBarItem | vscode.NotebookCellStatusBarItem[] | undefined {
    if (cell.notebook.notebookType !== INLINE_CHUNKS_NOTEBOOK_TYPE || cell.kind !== vscode.NotebookCellKind.Code) {
      return undefined;
    }

    const metadata = getInlineChunksMetadata(cell.metadata);
    if (metadata?.kind !== "code") {
      return undefined;
    }

    const headerItem = new vscode.NotebookCellStatusBarItem(
      `$(code) ${formatChunkHeaderBadge(metadata)}`,
      vscode.NotebookCellStatusBarAlignment.Left
    );
    headerItem.tooltip = formatChunkHeaderTooltip(metadata);
    headerItem.priority = 200;
    headerItem.command = {
      title: "Edit Chunk Header",
      command: "rmdNotebooks.editChunkHeader",
      arguments: [cell.notebook.uri.toString(), metadata.chunkId]
    };

    return headerItem;
  }
}
