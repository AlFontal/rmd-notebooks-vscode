import { TextDecoder, TextEncoder } from "node:util";
import * as vscode from "vscode";
import { parseExecutableChunks } from "../document/chunkParser";
import { parseChunkOptions } from "./chunkOptions";
import { getInlineChunksMetadata, withInlineChunksMetadata } from "./notebookTypes";

const DECODER = new TextDecoder();
const ENCODER = new TextEncoder();

export function deserializeNotebookSource(content: Uint8Array): vscode.NotebookData {
  const source = DECODER.decode(content);
  const normalized = source.replace(/\r\n/g, "\n");
  const lines = normalized.length === 0 ? [] : normalized.split("\n");
  const chunks = parseExecutableChunks("", normalized);
  const cells: vscode.NotebookCellData[] = [];
  let cursor = 0;

  for (const chunk of chunks) {
    const before = lines.slice(cursor, chunk.startLine).join("\n");
    pushMarkupCell(cells, before);

    const codeCell = new vscode.NotebookCellData(vscode.NotebookCellKind.Code, chunk.body, chunk.language);
    codeCell.metadata = withInlineChunksMetadata(codeCell.metadata, {
      kind: "code",
      header: chunk.header,
      headerInfo: chunk.headerInfo,
      language: chunk.language,
      label: chunk.label,
      options: parseChunkOptions(chunk.headerInfo),
      fenceLength: chunk.fenceLength,
      isClosed: chunk.isClosed
    });
    cells.push(codeCell);
    cursor = chunk.isClosed ? chunk.endLine + 1 : lines.length;
  }

  pushMarkupCell(cells, lines.slice(cursor).join("\n"));

  if (cells.length === 0) {
    cells.push(new vscode.NotebookCellData(vscode.NotebookCellKind.Markup, normalized, "markdown"));
  }

  return new vscode.NotebookData(cells);
}

export function serializeNotebookSource(data: vscode.NotebookData): Uint8Array {
  const blocks: string[] = [];

  for (const cell of data.cells) {
    if (cell.kind === vscode.NotebookCellKind.Markup) {
      const markup = normalizeMarkupSource(cell.value);
      if (markup.length > 0) {
        blocks.push(markup);
      }
      continue;
    }

    const metadata = getInlineChunksMetadata(cell.metadata ?? {});
    const header = buildHeader(cell.languageId, metadata);
    const closingFence = "`".repeat(Math.max(3, metadata?.kind === "code" ? metadata.fenceLength : 3));
    const body = cell.value.replace(/\r\n/g, "\n").replace(/\n+$/g, "");
    const codeBlock = body.length > 0 ? `${header}\n${body}\n${closingFence}` : `${header}\n${closingFence}`;
    blocks.push(codeBlock);
  }

  return ENCODER.encode(blocks.join("\n\n"));
}

function pushMarkupCell(cells: vscode.NotebookCellData[], value: string): void {
  if (value.trim().length === 0) {
    return;
  }

  const markupCell = new vscode.NotebookCellData(vscode.NotebookCellKind.Markup, value, "markdown");
  markupCell.metadata = withInlineChunksMetadata(markupCell.metadata, { kind: "markup" });
  cells.push(markupCell);
}

function normalizeMarkupSource(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\n+$/g, "");
}

function buildHeader(languageId: string, metadata: ReturnType<typeof getInlineChunksMetadata>): string {
  if (metadata?.kind === "code") {
    if (metadata.language === languageId && metadata.header.trim().length > 0) {
      return metadata.header;
    }

    return metadata.label ? `\`\`\`{${languageId} ${metadata.label}}` : `\`\`\`{${languageId}}`;
  }

  return `\`\`\`{${languageId}}`;
}
