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

export type InlineChunksCellMetadata =
  | InlineChunksCodeCellMetadata
  | InlineChunksMarkupCellMetadata
  | InlineChunksFrontmatterCellMetadata;

export interface InlineChunksCellMetadataEnvelope {
  rmdNotebooks?: InlineChunksCellMetadata;
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
