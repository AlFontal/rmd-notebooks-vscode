import * as vscode from "vscode";
import { formatChunkHeaderBadge, formatChunkHeaderTooltip } from "./metadataDisplay";
import { getInlineChunksMetadata, INLINE_CHUNKS_NOTEBOOK_TYPE } from "./notebookTypes";

interface ChunkIdLookup {
  getChunkIdForCell(documentUri: string, cellIndex: number): string | undefined;
}

export class InlineChunksCellStatusBarProvider implements vscode.NotebookCellStatusBarItemProvider {
  constructor(private readonly chunkIdLookup: ChunkIdLookup) {}

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

    // chunkId can be undefined on the initial render before refreshNotebook
    // populates the runtime snapshot. editChunkHeader's active-selection
    // fallback handles it (status-bar clicks activate their cell). Don't fire
    // a refresh here when the snapshot updates — that would re-introduce the
    // dirty-on-open regression this PR fixed (#5).
    const chunkId = this.chunkIdLookup.getChunkIdForCell(cell.notebook.uri.toString(), cell.index);
    const headerItem = new vscode.NotebookCellStatusBarItem(
      `$(code) ${formatChunkHeaderBadge(metadata)}`,
      vscode.NotebookCellStatusBarAlignment.Left
    );
    headerItem.tooltip = formatChunkHeaderTooltip(metadata);
    headerItem.priority = 200;
    headerItem.command = {
      title: "Edit Chunk Header",
      command: "rmdNotebooks.editChunkHeader",
      arguments: [cell.notebook.uri.toString(), chunkId]
    };

    return headerItem;
  }
}
