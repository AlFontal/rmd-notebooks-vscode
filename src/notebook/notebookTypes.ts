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
  chunkId?: string;
  contentHash?: string;
  headerHash?: string;
  bodyHash?: string;
}

export interface InlineChunksMarkupCellMetadata {
  kind: "markup";
}

export type InlineChunksCellMetadata = InlineChunksCodeCellMetadata | InlineChunksMarkupCellMetadata;

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
