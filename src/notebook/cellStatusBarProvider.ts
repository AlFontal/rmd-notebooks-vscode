import * as vscode from "vscode";
import { formatChunkHeaderBadge, formatChunkHeaderTooltip } from "./metadataDisplay";
import { parseInlineRExpressions } from "./inlineR";
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
    if (cell.notebook.notebookType !== INLINE_CHUNKS_NOTEBOOK_TYPE) {
      return undefined;
    }

    const metadata = getInlineChunksMetadata(cell.metadata);
    const inlineCount = metadata?.kind === "inline" || cell.kind === vscode.NotebookCellKind.Markup
      ? parseInlineRExpressions(cell.document.getText()).length
      : 0;
    if (inlineCount > 0) {
      const chunkId = this.chunkIdLookup.getChunkIdForCell(cell.notebook.uri.toString(), cell.index);
      const item = new vscode.NotebookCellStatusBarItem(
        `$(play) Inline R ×${inlineCount}`,
        vscode.NotebookCellStatusBarAlignment.Left
      );
      item.tooltip = "Run inline R expressions and render this prose cell";
      item.priority = 210;
      item.command = {
        title: "Run Inline R",
        command: "rmdNotebooks.runInlineCell",
        arguments: [cell.notebook.uri.toString(), chunkId, cell.index]
      };
      return item;
    }

    if (cell.kind !== vscode.NotebookCellKind.Code) {
      return undefined;
    }
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
