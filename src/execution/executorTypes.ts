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

// Structural subset of vscode.CancellationToken so executor types stay free of a
// direct vscode dependency. A vscode.CancellationToken is assignable to this.
export interface ExecutionCancellationToken {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): unknown;
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
  // Invoked when the chunk leaves the queue and actually begins running in its
  // session, so the caller can flip the cell from "queued" to "running" only then.
  // Receives this run's execution count: a per-language-session, 1-based number, so
  // it is scoped to the notebook and resets to 1 when that session restarts (the
  // [1] [2] [3] badge VS Code shows next to each cell).
  onStart?: (executionOrder: number) => void;
  // Cancels just this chunk: if it is still queued it is dropped from the queue; if
  // it is the one currently running it is interrupted. Other chunks are unaffected.
  token?: ExecutionCancellationToken;
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
  disposeAll?(): Promise<void>;
}
