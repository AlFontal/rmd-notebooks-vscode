export interface ChunkLineRange {
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
}

export interface ParsedExecutableChunk {
  documentUri: string;
  language: string;
  header: string;
  headerInfo: string;
  label?: string;
  body: string;
  isClosed: boolean;
  fenceLength: number;
  startLine: number;
  endLine: number;
  headerRange: ChunkLineRange;
  bodyRange: ChunkLineRange;
  fullRange: ChunkLineRange;
}

export interface ChunkIdentity {
  chunkId: string;
  contentHash: string;
  headerHash: string;
  bodyHash: string;
}

export interface ExecutableChunk extends ParsedExecutableChunk {
  identity: ChunkIdentity;
}

export interface ChunkIdentitySeed {
  chunkId: string;
  contentHash: string;
  headerHash: string;
  bodyHash: string;
  language: string;
  label?: string;
  startLine: number;
  header: string;
  body?: string;
}

export interface ChunkDocumentSnapshot {
  documentUri: string;
  version: number;
  chunks: ExecutableChunk[];
  generatedAt: number;
}

export interface TextOutputItem {
  type: "text";
  text: string;
}

export interface ErrorOutputItem {
  type: "error";
  text: string;
}

export interface ImageOutputItem {
  type: "image";
  path: string;
  mimeType: string;
  width?: number;
  height?: number;
}

export interface HtmlOutputItem {
  type: "html";
  html: string;
}

export type OutputItem =
  | TextOutputItem
  | ErrorOutputItem
  | ImageOutputItem
  | HtmlOutputItem;

export type ChunkOutputStatus = "running" | "success" | "error";

export interface ChunkOutputRecord {
  documentUri: string;
  chunkId: string;
  language: string;
  header: string;
  label?: string;
  contentHash: string;
  headerHash: string;
  bodyHash: string;
  startLine: number;
  capturedAt?: number;
  stale: boolean;
  status: ChunkOutputStatus;
  outputs: OutputItem[];
}
