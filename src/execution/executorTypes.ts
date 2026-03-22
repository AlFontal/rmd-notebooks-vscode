import { OutputItem } from "../document/chunkTypes";

export interface PlotRenderOptions {
  widthInches?: number;
  heightInches?: number;
  dpi?: number;
}

export interface ExecutionContext {
  documentUri: string;
  workspaceFolder?: string;
  chunkId: string;
  language: string;
  code: string;
  header: string;
  artifactDirectory?: string;
  plot?: PlotRenderOptions;
}

export interface ExecutionResult {
  success: boolean;
  startedAt: number;
  finishedAt: number;
  items: OutputItem[];
}

export interface Executor {
  language: string;
  canHandle(language: string): boolean;
  warmupSession?(documentUri: string): Promise<void>;
  executeChunk(context: ExecutionContext): Promise<ExecutionResult>;
  interruptSession?(documentUri: string): Promise<void>;
  disposeSession?(documentUri: string): Promise<void>;
}
