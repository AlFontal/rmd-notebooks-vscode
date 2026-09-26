import { TextDecoder, TextEncoder } from "node:util";
import * as vscode from "vscode";
import { parseNotebookSource, renderNotebookSource, SourceCell } from "./notebookSourceFormat";
import { getInlineChunksDocumentLayout, getInlineChunksMetadata } from "./notebookTypes";

const DECODER = new TextDecoder();
const ENCODER = new TextEncoder();

export function deserializeNotebookSource(content: Uint8Array): vscode.NotebookData {
  const parsed = parseNotebookSource(DECODER.decode(content));
  const cells = parsed.cells.map((sourceCell) => {
    const kind = sourceCell.kind === "code" ? vscode.NotebookCellKind.Code : vscode.NotebookCellKind.Markup;
    const cell = new vscode.NotebookCellData(kind, sourceCell.value, sourceCell.languageId);
    cell.metadata = sourceCell.metadata;
    if (getInlineChunksMetadata(sourceCell.metadata)?.kind === "inline") {
      cell.outputs = [
        new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.text(sourceCell.value, "text/markdown")])
      ];
    }
    return cell;
  });

  const data = new vscode.NotebookData(cells);
  data.metadata = { rmdNotebooksLayout: parsed.layout };
  return data;
}

export function serializeNotebookSource(data: vscode.NotebookData): Uint8Array {
  const cells: SourceCell[] = data.cells.map((cell) => ({
    kind: cell.kind === vscode.NotebookCellKind.Markup ? "markup" : "code",
    value: cell.value,
    languageId: cell.languageId,
    metadata: cell.metadata ?? {}
  }));
  return ENCODER.encode(renderNotebookSource(cells, getInlineChunksDocumentLayout(data.metadata)));
}
