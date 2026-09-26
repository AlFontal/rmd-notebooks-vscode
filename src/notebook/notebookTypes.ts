import * as vscode from "vscode";
import { ChunkOptions } from "./chunkOptions";

export const INLINE_CHUNKS_NOTEBOOK_TYPE = "rmd-notebooks-vscode-notebook";

export interface InlineChunksCodeCellMetadata {
  kind: "code";
  header: string;
  headerInfo: string;
  language: string;
  label?: string;
  options?: ChunkOptions;
  fenceLength: number;
  isClosed: boolean;
}

export interface InlineChunksMarkupCellMetadata {
  kind: "markup";
}

export interface InlineChunksFrontmatterCellMetadata {
  kind: "frontmatter";
  openingFence: "---";
  closingFence: "---" | "...";
}

export interface InlineChunksInlineCellMetadata {
  kind: "inline";
  expressionCount: number;
}

export type InlineChunksCellMetadata =
  | InlineChunksCodeCellMetadata
  | InlineChunksMarkupCellMetadata
  | InlineChunksFrontmatterCellMetadata
  | InlineChunksInlineCellMetadata;

export interface InlineChunksCellMetadataEnvelope {
  rmdNotebooks?: InlineChunksCellMetadata;
  rmdNotebooksLayout?: InlineChunksCellLayout;
}

// Source layout is kept apart from rmdNotebooks so that rewriting a cell's chunk
// metadata (header edits, language changes) never drops the recorded spacing.
export interface InlineChunksCellLayout {
  // Whitespace-only source lines between the previous block and this cell, or the
  // lines before the first block. Absent means the default single blank line.
  gapBefore?: string[];
  // Trailing newlines of a code or front matter body in the source (blank lines
  // before the closing fence). At most this many are written back, so untouched
  // cells stay byte-identical while newly typed trailing newlines are dropped.
  trailingNewlines?: number;
}

export interface InlineChunksDocumentLayout {
  eol: "\n" | "\r\n";
  // Source text after the last block, including the final newline.
  trailing: string;
}

export function getInlineChunksCellLayout(metadata: { [key: string]: any } | undefined): InlineChunksCellLayout | undefined {
  const candidate = metadata?.rmdNotebooksLayout;
  if (!candidate || typeof candidate !== "object") {
    return undefined;
  }
  return {
    gapBefore: isStringArray(candidate.gapBefore) ? candidate.gapBefore : undefined,
    trailingNewlines: Number.isInteger(candidate.trailingNewlines) && candidate.trailingNewlines > 0
      ? candidate.trailingNewlines
      : undefined
  };
}

export function getInlineChunksDocumentLayout(
  metadata: { [key: string]: any } | undefined
): InlineChunksDocumentLayout | undefined {
  const candidate = metadata?.rmdNotebooksLayout;
  return candidate && (candidate.eol === "\n" || candidate.eol === "\r\n") && typeof candidate.trailing === "string"
    ? candidate
    : undefined;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

export function getInlineChunksMetadata(metadata: { [key: string]: any }): InlineChunksCellMetadata | undefined {
  const candidate = (metadata as InlineChunksCellMetadataEnvelope).rmdNotebooks;
  return candidate;
}

export function withInlineChunksMetadata(
  metadata: { [key: string]: any } | undefined,
  rmdNotebooks: InlineChunksCellMetadata
): { [key: string]: any } {
  return {
    ...(metadata ?? {}),
    rmdNotebooks
  };
}

export function isInlineChunksNotebook(document: vscode.NotebookDocument): boolean {
  return document.notebookType === INLINE_CHUNKS_NOTEBOOK_TYPE;
}
