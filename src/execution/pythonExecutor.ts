import * as path from "node:path";
import * as readline from "node:readline";
import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import * as vscode from "vscode";
import { ErrorOutputItem, HtmlOutputItem, ImageOutputItem, MarkdownOutputItem, MimeOutputItem, OutputItem, TextOutputItem } from "../document/chunkTypes";
import {
  Executor,
  ExecutionCancellationToken,
  ExecutionContext,
  ExecutionResult,
  InteractivePromptRequest,
  InteractivePromptResponse
} from "./executorTypes";
import { CancelledExecutionError } from "./executionErrors";

const READY_PREFIX = "RMD_NOTEBOOKS_PYTHON_READY:";
const COMMAND_PREFIX = "RMD_NOTEBOOKS_PYTHON_COMMAND:";
const RESULT_PREFIX = "RMD_NOTEBOOKS_PYTHON_RESULT:";
const PROMPT_PREFIX = "RMD_NOTEBOOKS_PYTHON_PROMPT:";
const PROMPT_RESPONSE_PREFIX = "RMD_NOTEBOOKS_PYTHON_PROMPT_RESPONSE:";

interface RawExecutionPayload {
  success: boolean;
  cancelled?: boolean;
  startedAt: number;
  finishedAt: number;
  stdout: string;
  stderr: string;
  html: string;
  markdown: string;
  images: Array<{
    path: string;
    mimeType: string;
  }>;
  richOutputs?: Array<
    | { type: "text"; text: string }
    | { type: "html"; html: string }
    | { type: "markdown"; markdown: string }
    | { type: "image"; path: string; mimeType: string }
    | { type: "mime"; mimeType: string; data: string; encoding?: "utf8" | "base64" }
  >;
}

interface DataFrameRenderOptions {
  render: boolean;
  maxRows: number;
  maxColumns: number;
}

interface ExecutionRequest {
  code: string;
  workingDirectory?: string;
  artifactDirectory?: string;
  plot?: ExecutionContext["plot"];
  dataFrame: DataFrameRenderOptions;
  promptHandler?: (request: InteractivePromptRequest) => Promise<InteractivePromptResponse>;
  onStart?: (executionOrder: number) => void;
}

interface QueuedExecution {
  request: ExecutionRequest;
  resolve: (payload: RawExecutionPayload) => void;
  reject: (error: Error) => void;
}

export interface PythonInterpreterSelection {
  id: string;
  path: string;
  prefixArgs?: string[];
  renderPythonPath?: string;
  environmentVariables?: Record<string, string | undefined>;
}

export type PythonExecutionEngine = "ipython" | "python";

export class PythonExecutor implements Executor {
  public readonly language = "python";
  private readonly sessions = new Map<string, PythonSession>();
  private readonly selections = new Map<string, PythonInterpreterSelection>();
  private readonly fallbackEmitter = new vscode.EventEmitter<{
    documentUri: string;
    selection?: PythonInterpreterSelection;
  }>();
  private readonly reportedFallbacks = new Set<string>();
  public readonly onDidUsePythonFallback = this.fallbackEmitter.event;

  public constructor(private readonly extensionUri: vscode.Uri) {}

  public canHandle(language: string): boolean {
    return ["python", "py"].includes(language.toLowerCase());
  }

  public async warmupSession(documentUri: string): Promise<void> {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.parse(documentUri))?.uri.fsPath;
    await this.getOrCreateSession(documentUri, workspaceFolder).ready();
  }

  public async executeChunk(context: ExecutionContext): Promise<ExecutionResult> {
    const configuration = vscode.workspace.getConfiguration("rmdNotebooks");
    const payload = await this.getOrCreateSession(context.documentUri, context.workspaceFolder).execute(
      {
        code: context.code,
        workingDirectory: context.workspaceFolder,
        artifactDirectory: context.artifactDirectory,
        plot: context.plot,
        dataFrame: {
          render: configuration.get<boolean>("output.dataFrameRender", true),
          maxRows: configuration.get<number>("output.dataFrameMaxRows", 50),
          maxColumns: configuration.get<number>("output.dataFrameMaxColumns", 50)
        },
        promptHandler: context.prompt,
        onStart: context.onStart
      },
      context.token
    );

    const items: OutputItem[] = [];
    if (payload.stdout.trim().length > 0) {
      items.push({ type: "text", text: payload.stdout.trimEnd() } satisfies TextOutputItem);
    }
    if (payload.stderr.trim().length > 0) {
      items.push({ type: "error", text: payload.stderr.trimEnd() } satisfies ErrorOutputItem);
    }
    if (payload.html.trim().length > 0) {
      items.push({ type: "html", html: payload.html.trim() } satisfies HtmlOutputItem);
    }
    if (payload.markdown.trim().length > 0) {
      items.push({ type: "markdown", markdown: payload.markdown.trimEnd() } satisfies MarkdownOutputItem);
    }
    for (const output of payload.richOutputs ?? []) {
      if (output.type === "text") {
        items.push({ type: "text", text: output.text } satisfies TextOutputItem);
      } else if (output.type === "html") {
        items.push({ type: "html", html: output.html } satisfies HtmlOutputItem);
      } else if (output.type === "markdown") {
        items.push({ type: "markdown", markdown: output.markdown } satisfies MarkdownOutputItem);
      } else if (output.type === "image") {
        items.push({ type: "image", path: output.path, mimeType: output.mimeType } satisfies ImageOutputItem);
      } else {
        items.push({
          type: "mime",
          mimeType: output.mimeType,
          data: output.data,
          encoding: output.encoding
        } satisfies MimeOutputItem);
      }
    }
    for (const image of payload.images) {
      items.push({ type: "image", path: image.path, mimeType: image.mimeType } satisfies ImageOutputItem);
    }

    return {
      success: payload.success,
      startedAt: payload.startedAt,
      finishedAt: payload.finishedAt,
      items
    };
  }

  public async disposeSession(documentUri: string): Promise<void> {
    const session = this.sessions.get(documentUri);
    if (!session) {
      return;
    }
    this.sessions.delete(documentUri);
    await session.dispose();
  }

  public async interruptSession(documentUri: string): Promise<void> {
    this.sessions.get(documentUri)?.interrupt();
  }

  public async disposeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((uri) => this.disposeSession(uri)));
    this.fallbackEmitter.dispose();
  }

  public async selectInterpreter(documentUri: string, selection?: PythonInterpreterSelection): Promise<void> {
    const current = this.selections.get(documentUri);
    if (JSON.stringify(current) === JSON.stringify(selection)) {
      return;
    }

    if (selection) {
      this.selections.set(documentUri, selection);
    } else {
      this.selections.delete(documentUri);
    }
    await this.disposeSession(documentUri);
  }

  public getSelectedInterpreter(documentUri: string): PythonInterpreterSelection | undefined {
    return this.selections.get(documentUri);
  }

  private getOrCreateSession(documentUri: string, workspaceFolder?: string): PythonSession {
    const existing = this.sessions.get(documentUri);
    if (existing) {
      return existing;
    }

    const configuration = vscode.workspace.getConfiguration("rmdNotebooks");
    const selection = this.selections.get(documentUri);
    const configuredPath = configuration.get<string>("python.path", "").trim();
    const pythonPath = selection?.path || configuredPath || (process.platform === "win32" ? "python" : "python3");
    const pythonArgs = [
      ...(selection?.prefixArgs ?? []),
      ...configuration.get<string[]>("python.args", ["-u"])
    ];
    const startupTimeoutMs = configuration.get<number>("python.startupTimeoutMs", 30000);
    const scriptPath = path.join(this.extensionUri.fsPath, "media", "python", "rmd_notebooks_session.py");
    const created = new PythonSession(
      pythonPath,
      pythonArgs,
      scriptPath,
      workspaceFolder,
      startupTimeoutMs,
      selection?.environmentVariables
    );
    this.sessions.set(documentUri, created);
    void created.ready().then(
      (engine) => {
        if (engine !== "python") {
          return;
        }
        const reportKey = `${documentUri}::${selection?.id ?? pythonPath}`;
        if (!this.reportedFallbacks.has(reportKey)) {
          this.reportedFallbacks.add(reportKey);
          this.fallbackEmitter.fire({ documentUri, selection });
        }
      },
      () => {
        if (this.sessions.get(documentUri) === created) {
          this.sessions.delete(documentUri);
        }
        void created.dispose(false);
      }
    );
    return created;
  }
}

class PythonSession {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly lineReader: readline.Interface;
  private readonly readyPromise: Promise<PythonExecutionEngine>;
  private readyResolve!: (engine: PythonExecutionEngine) => void;
  private readyReject!: (error: Error) => void;
  private readonly startTimer: NodeJS.Timeout;
  private readonly queue: QueuedExecution[] = [];
  private pending: QueuedExecution | undefined;
  private starting = false;
  private alive = true;
  private sessionReady = false;
  private executionCount = 0;
  private runtimeStdout = "";
  private runtimeStderr = "";

  public constructor(
    pythonPath: string,
    pythonArgs: string[],
    scriptPath: string,
    startupDirectory?: string,
    startupTimeoutMs = 30000,
    environmentVariables?: Record<string, string | undefined>
  ) {
    this.process = spawn(pythonPath, [...pythonArgs, scriptPath], {
      stdio: "pipe",
      cwd: startupDirectory,
      env: {
        ...process.env,
        ...environmentVariables,
        MPLBACKEND: environmentVariables?.MPLBACKEND || process.env.MPLBACKEND || "Agg"
      }
    });
    this.lineReader = readline.createInterface({ input: this.process.stdout });
    this.readyPromise = new Promise<PythonExecutionEngine>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.startTimer = setTimeout(() => {
      this.readyReject(
        new Error(
          `Timed out starting Python session after ${startupTimeoutMs}ms. ` +
          `Increase rmdNotebooks.python.startupTimeoutMs if this environment starts slowly. ${this.runtimeStderr}`.trim()
        )
      );
    }, startupTimeoutMs);

    this.lineReader.on("line", (line) => this.handleStdoutLine(line));
    this.process.stderr.on("data", (chunk) => {
      this.runtimeStderr += chunk.toString();
    });
    this.process.on("error", (error) => this.handleProcessFailure(error));
    this.process.on("exit", (code, signal) => {
      this.handleProcessFailure(
        new Error(`Python session exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"}).`)
      );
    });
  }

  public async ready(): Promise<PythonExecutionEngine> {
    return this.readyPromise;
  }

  public execute(request: ExecutionRequest, token?: ExecutionCancellationToken): Promise<RawExecutionPayload> {
    return new Promise<RawExecutionPayload>((resolve, reject) => {
      const task = { request, resolve, reject } satisfies QueuedExecution;
      this.queue.push(task);
      if (token) {
        if (token.isCancellationRequested) {
          this.cancelTask(task);
        } else {
          token.onCancellationRequested(() => this.cancelTask(task));
        }
      }
      this.drainQueue();
    });
  }

  public interrupt(): void {
    this.failQueue(new CancelledExecutionError());
    if (this.pending) {
      this.interruptProcess();
    }
  }

  public async dispose(cancelExecutions = true): Promise<void> {
    this.alive = false;
    clearTimeout(this.startTimer);
    if (cancelExecutions) {
      this.failQueue(new CancelledExecutionError("Python session was disposed."));
      this.pending?.reject(new CancelledExecutionError("Python session was disposed."));
      this.pending = undefined;
    }
    this.lineReader.close();
    this.process.stdin.end();
    this.process.kill();
  }

  private cancelTask(task: QueuedExecution): void {
    const queueIndex = this.queue.indexOf(task);
    if (queueIndex >= 0) {
      this.queue.splice(queueIndex, 1);
      task.reject(new CancelledExecutionError());
    } else if (this.pending === task) {
      this.interruptProcess();
    }
  }

  private drainQueue(): void {
    if (this.pending || this.starting || this.queue.length === 0) {
      return;
    }
    if (!this.alive) {
      this.failQueue(new Error("Python session is no longer running."));
      return;
    }

    this.starting = true;
    this.ready().then(
      () => {
        this.starting = false;
        const task = this.queue.shift();
        if (task) {
          this.beginExecution(task);
        }
      },
      (error) => {
        this.starting = false;
        this.failQueue(error instanceof Error ? error : new Error(String(error)));
      }
    );
  }

  private beginExecution(task: QueuedExecution): void {
    this.pending = task;
    this.runtimeStdout = "";
    this.runtimeStderr = "";
    this.executionCount += 1;
    task.request.onStart?.(this.executionCount);
    this.process.stdin.write(COMMAND_PREFIX + encodeMessage(task.request) + "\n");
  }

  private handleStdoutLine(line: string): void {
    if (line.startsWith(READY_PREFIX)) {
      this.sessionReady = true;
      clearTimeout(this.startTimer);
      const payload = decodeMessage<{ engine?: string }>(line.slice(READY_PREFIX.length));
      this.readyResolve(payload.engine === "ipython" ? "ipython" : "python");
      return;
    }
    if (line.startsWith(PROMPT_PREFIX)) {
      void this.handlePrompt(decodeMessage<InteractivePromptRequest>(line.slice(PROMPT_PREFIX.length)));
      return;
    }
    if (line.startsWith(RESULT_PREFIX)) {
      const task = this.pending;
      this.pending = undefined;
      try {
        if (!task) {
          return;
        }
        const payload = decodeMessage<RawExecutionPayload>(line.slice(RESULT_PREFIX.length));
        if (this.runtimeStdout.trim().length > 0) {
          payload.stdout = joinOutput(payload.stdout, this.runtimeStdout);
        }
        if (this.runtimeStderr.trim().length > 0) {
          payload.stderr = joinOutput(payload.stderr, this.runtimeStderr);
        }
        if (payload.cancelled) {
          task.reject(new CancelledExecutionError("Python execution was interrupted."));
        } else {
          task.resolve(payload);
        }
      } catch (error) {
        task?.reject(error instanceof Error ? error : new Error(String(error)));
      } finally {
        this.runtimeStdout = "";
        this.runtimeStderr = "";
        this.drainQueue();
      }
      return;
    }
    this.runtimeStdout += (this.runtimeStdout ? "\n" : "") + line;
  }

  private async handlePrompt(request: InteractivePromptRequest): Promise<void> {
    const task = this.pending;
    if (!task) {
      return;
    }
    try {
      const response = task.request.promptHandler
        ? await task.request.promptHandler(request)
        : { cancelled: true } satisfies InteractivePromptResponse;
      this.process.stdin.write(PROMPT_RESPONSE_PREFIX + encodeMessage(response) + "\n");
    } catch (error) {
      this.process.stdin.write(PROMPT_RESPONSE_PREFIX + encodeMessage({ cancelled: true }) + "\n");
      task.reject(error instanceof Error ? error : new Error(String(error)));
      // Keep the task occupying the session until Python consumes the cancelled
      // response and emits its result. Starting the next command earlier would let
      // that old result resolve the next cell's promise.
    }
  }

  private interruptProcess(): void {
    if (this.alive && !this.process.kill("SIGINT")) {
      throw new Error("Unable to interrupt Python session.");
    }
  }

  private handleProcessFailure(error: Error): void {
    if (!this.alive) {
      return;
    }
    this.alive = false;
    clearTimeout(this.startTimer);
    this.readyReject(error);
    this.pending?.reject(error);
    this.pending = undefined;
    this.failQueue(error);
  }

  private failQueue(error: Error): void {
    for (const task of this.queue.splice(0)) {
      task.reject(error);
    }
  }
}

function encodeMessage(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

function decodeMessage<T>(value: string): T {
  return JSON.parse(Buffer.from(value, "base64").toString("utf8")) as T;
}

function joinOutput(first: string, second: string): string {
  return [first.trimEnd(), second.trimEnd()].filter((value) => value.length > 0).join("\n");
}
