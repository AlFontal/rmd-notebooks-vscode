import { OutputItem } from "../document/chunkTypes";

export interface PlotRenderOptions {
  widthInches?: number;
  heightInches?: number;
  dpi?: number;
}

export type InteractivePromptKind = "select" | "input" | "confirm";

export interface InteractivePromptChoice {
  label: string;
  value: string;
  description?: string;
}

export interface InteractivePromptRequest {
  kind: InteractivePromptKind;
  title?: string;
  prompt: string;
  placeHolder?: string;
  defaultValue?: string;
  allowEmpty?: boolean;
  choices?: InteractivePromptChoice[];
}

export interface InteractivePromptResponse {
  cancelled: boolean;
  value?: string;
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
  prompt?: (request: InteractivePromptRequest) => Promise<InteractivePromptResponse>;
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
