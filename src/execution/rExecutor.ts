import * as path from "node:path";
import * as readline from "node:readline";
import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import * as vscode from "vscode";
import { ErrorOutputItem, HtmlOutputItem, ImageOutputItem, OutputItem, TextOutputItem } from "../document/chunkTypes";
import {
  Executor,
  ExecutionCancellationToken,
  ExecutionContext,
  ExecutionResult,
  InteractivePromptChoice,
  InteractivePromptRequest,
  InteractivePromptResponse
} from "./executorTypes";
import { CancelledExecutionError, InteractiveExecutionError } from "./executionErrors";
import { getInlineRArgs } from "./rStartupArgs";

const READY_MARKER = "RMD_NOTEBOOKS_READY";
const RESULT_START_MARKER = "RMD_NOTEBOOKS_RESULT_START";
const RESULT_END_MARKER = "RMD_NOTEBOOKS_RESULT_END";
const PROMPT_START_MARKER = "RMD_NOTEBOOKS_PROMPT_START";
const PROMPT_END_MARKER = "RMD_NOTEBOOKS_PROMPT_END";
const PROMPT_RESPONSE_START_MARKER = "RMD_NOTEBOOKS_PROMPT_RESPONSE_START";
const PROMPT_RESPONSE_END_MARKER = "RMD_NOTEBOOKS_PROMPT_RESPONSE_END";
const COMMAND_MARKER = "RMD_NOTEBOOKS_COMMAND_V1";
const COMMAND_END_MARKER = "RMD_NOTEBOOKS_END";

interface RawExecutionPayload {
  success: boolean;
  startedAt: number;
  finishedAt: number;
  stdout: string;
  stderr: string;
  html: string;
  plots: string[];
}

interface DataFrameRenderOptions {
  render: boolean;
  maxRows: number;
}

interface PendingExecution {
  resolve: (payload: RawExecutionPayload) => void;
  reject: (error: Error) => void;
  abandoned: boolean;
}

interface ExecutionRequest {
  code: string;
  workingDirectory?: string;
  artifactDirectory?: string;
  plot?: ExecutionContext["plot"];
  dataFrame?: DataFrameRenderOptions;
  timeoutMs: number;
  promptHandler?: (request: InteractivePromptRequest) => Promise<InteractivePromptResponse>;
  onStart?: () => void;
}

interface QueuedExecution {
  readonly request: ExecutionRequest;
  resolve: (payload: RawExecutionPayload) => void;
  reject: (error: Error) => void;
}

export class RExecutor implements Executor {
  public readonly language = "r";
  private readonly sessions = new Map<string, RSession>();

  public constructor(private readonly extensionUri: vscode.Uri) {}

  public canHandle(language: string): boolean {
    return language.toLowerCase() === "r";
  }

  public async warmupSession(documentUri: string): Promise<void> {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.parse(documentUri))?.uri.fsPath;
    const session = this.getOrCreateSession(documentUri, workspaceFolder);
    await session.ready();
  }

  public async executeChunk(context: ExecutionContext): Promise<ExecutionResult> {
    const session = this.getOrCreateSession(context.documentUri, context.workspaceFolder);
    const configuration = vscode.workspace.getConfiguration("rmdNotebooks");
    const timeoutMs = configuration.get<number>("execution.interactiveFallbackTimeoutMs", 0);
    const dataFrame: DataFrameRenderOptions = {
      render: configuration.get<boolean>("output.dataFrameRender", true),
      maxRows: configuration.get<number>("output.dataFrameMaxRows", 50)
    };
    const payload = await session.execute(
      context.code,
      context.workspaceFolder,
      context.artifactDirectory,
      context.plot,
      dataFrame,
      timeoutMs,
      context.prompt,
      context.onStart,
      context.token
    );

    const items: OutputItem[] = [];

    if (payload.stdout.trim().length > 0) {
      items.push({
        type: "text",
        text: payload.stdout.trimEnd()
      } satisfies TextOutputItem);
    }

    if (payload.stderr.trim().length > 0) {
      items.push({
        type: "error",
        text: payload.stderr.trimEnd()
      } satisfies ErrorOutputItem);
    }

    if (payload.html.trim().length > 0) {
      items.push({
        type: "html",
        html: payload.html.trim()
      } satisfies HtmlOutputItem);
    }

    for (const plotPath of payload.plots) {
      items.push({
        type: "image",
        path: plotPath,
        mimeType: "image/png"
      } satisfies ImageOutputItem);
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
    const session = this.sessions.get(documentUri);
    session?.interrupt();
  }

  public async disposeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((uri) => this.disposeSession(uri)));
  }

  private getOrCreateSession(documentUri: string, workspaceFolder?: string): RSession {
    const existing = this.sessions.get(documentUri);
    if (existing) {
      return existing;
    }

    const configuration = vscode.workspace.getConfiguration("rmdNotebooks");
    const rPath = configuration.get<string>("r.path", "R");
    const rArgs = getInlineRArgs(configuration);
    const sourceVscodeRSessionWatcher = configuration.get<boolean>("r.sourceVscodeRSessionWatcher", true);
    const startupTimeoutMs = configuration.get<number>("r.startupTimeoutMs", 30000);
    const sessionScriptPath = path.join(this.extensionUri.fsPath, "media", "r", "rmd_notebooks_session.R");
    const created = new RSession(rPath, rArgs, sessionScriptPath, workspaceFolder, sourceVscodeRSessionWatcher, startupTimeoutMs);
    this.sessions.set(documentUri, created);
    // Evict a session that never becomes ready so the next run starts fresh
    // instead of replaying the cached startup rejection.
    created.ready().catch(() => {
      if (this.sessions.get(documentUri) === created) {
        this.sessions.delete(documentUri);
      }
      void created.dispose();
    });
    return created;
  }
}

class RSession {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly lineReader: readline.Interface;
  private readonly readyPromise: Promise<void>;
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  private pending: PendingExecution | undefined;
  private pendingTask: QueuedExecution | undefined;
  private readonly queue: QueuedExecution[] = [];
  private starting = false;
  private currentLines: string[] = [];
  private currentPromptLines: string[] = [];
  private waitingForResult = false;
  private waitingForPrompt = false;
  private startupErrors: string[] = [];
  private readonly startTimer: NodeJS.Timeout;
  private promptHandler: ((request: InteractivePromptRequest) => Promise<InteractivePromptResponse>) | undefined;
  private executionTimeout: NodeJS.Timeout | undefined;
  private executionTimeoutMs = 0;
  private sessionReady = false;
  private alive = true;
  private runtimeStderr = "";

  public constructor(
    rPath: string,
    rArgs: string[],
    scriptPath: string,
    startupDirectory?: string,
    sourceVscodeRSessionWatcher = true,
    startupTimeoutMs = 30000
  ) {
    this.process = spawn(rPath, rArgs, {
      stdio: "pipe",
      cwd: startupDirectory,
      env: {
        ...process.env,
        RMD_NOTEBOOKS_SOURCE_VSCODE_R_INIT: sourceVscodeRSessionWatcher ? "1" : "0"
      }
    });

    this.lineReader = readline.createInterface({
      input: this.process.stdout
    });

    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    this.startTimer = setTimeout(() => {
      this.readyReject(new Error(`Timed out starting R session after ${startupTimeoutMs}ms. Increase rmdNotebooks.r.startupTimeoutMs if this project has a slow R startup. ${this.startupErrors.join("\n")}`.trim()));
    }, startupTimeoutMs);

    this.lineReader.on("line", (line) => this.handleStdoutLine(line));
    this.process.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      if (!this.sessionReady) {
        this.startupErrors.push(text);
      } else if (this.pending) {
        this.runtimeStderr += text;
        return;
      }

      if (this.pending && !this.sessionReady) {
        this.clearExecutionTimeout();
        this.promptHandler = undefined;
        this.pending.reject(new Error(text));
        this.pending = undefined;
      }
    });
    this.process.on("error", (error) => {
      this.alive = false;
      this.readyReject(error);
      if (this.pending) {
        this.clearExecutionTimeout();
        this.promptHandler = undefined;
        this.pending.reject(error);
        this.pending = undefined;
        this.pendingTask = undefined;
      }
      this.failQueue(error);
    });
    this.process.on("exit", (code, signal) => {
      this.alive = false;
      const message = `R session exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"}).`;
      if (this.pending) {
        this.clearExecutionTimeout();
        this.promptHandler = undefined;
        this.pending.reject(new Error(message));
        this.pending = undefined;
        this.pendingTask = undefined;
      }
      this.readyReject(new Error(message));
      this.failQueue(new Error(message));
    });

    // Start an interactive R session, then source the command loop script over stdin.
    this.process.stdin.write(`source('${escapeRString(scriptPath)}')\n`);
  }

  public async ready(): Promise<void> {
    await this.readyPromise;
  }

  public execute(
    code: string,
    workingDirectory?: string,
    artifactDirectory?: string,
    plot?: ExecutionContext["plot"],
    dataFrame?: DataFrameRenderOptions,
    timeoutMs = 15000,
    promptHandler?: (request: InteractivePromptRequest) => Promise<InteractivePromptResponse>,
    onStart?: () => void,
    token?: ExecutionCancellationToken
  ): Promise<RawExecutionPayload> {
    // Chunks are queued instead of rejected: a chunk requested while another is
    // running waits its turn and runs in order, like cells in a Jupyter notebook.
    return new Promise<RawExecutionPayload>((resolve, reject) => {
      const task: QueuedExecution = {
        request: { code, workingDirectory, artifactDirectory, plot, dataFrame, timeoutMs, promptHandler, onStart },
        resolve,
        reject
      };
      this.queue.push(task);
      // Cancelling one cell affects only that cell: if it is still queued it is
      // dropped; if it is the one running it is interrupted. The rest keep going.
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

  // Cancels a single chunk without disturbing the others.
  private cancelTask(task: QueuedExecution): void {
    const queueIndex = this.queue.indexOf(task);
    if (queueIndex >= 0) {
      this.queue.splice(queueIndex, 1);
      task.reject(new CancelledExecutionError());
      return;
    }

    // Not queued anymore: only interrupt if it is the chunk currently running.
    if (this.pendingTask === task && this.pending && !this.pending.abandoned) {
      this.interruptProcess();
    }
  }

  public interrupt(): void {
    // A single interrupt stops the whole run: drop everything still queued, then
    // interrupt the chunk currently executing (if any). A chunk already abandoned
    // by an execution timeout was interrupted there, so it is left alone.
    this.failQueue(new CancelledExecutionError());
    if (this.pending && !this.pending.abandoned) {
      this.interruptProcess();
    }
  }

  // Starts the next queued chunk once the session is idle. Only one chunk runs
  // at a time; the rest wait their turn instead of erroring out.
  private drainQueue(): void {
    if (this.pending || this.starting || this.queue.length === 0) {
      return;
    }
    if (!this.alive) {
      this.failQueue(new Error("R session is no longer running."));
      return;
    }

    this.starting = true;
    this.ready().then(
      () => {
        this.starting = false;
        if (!this.alive) {
          this.failQueue(new Error("R session is no longer running."));
          return;
        }
        // interrupt() can empty the queue while we awaited readiness.
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
    const { request } = task;
    this.pendingTask = task;
    this.pending = {
      abandoned: false,
      resolve: (payload) => {
        this.clearExecutionTimeout();
        this.promptHandler = undefined;
        task.resolve(payload);
      },
      reject: (error) => {
        this.clearExecutionTimeout();
        this.promptHandler = undefined;
        task.reject(error);
      }
    };
    this.promptHandler = request.promptHandler;
    this.executionTimeoutMs = request.timeoutMs;
    this.runtimeStderr = "";
    // The chunk is leaving the queue now, so let the caller mark the cell as
    // running (rather than queued) starting from this moment.
    request.onStart?.();
    this.armExecutionTimeout();
    this.process.stdin.write(`${COMMAND_MARKER}\n`);
    this.process.stdin.write(`WORKDIR:${encodeProtocolLine(request.workingDirectory ?? "")}\n`);
    this.process.stdin.write(`ARTIFACT_DIR:${encodeProtocolLine(request.artifactDirectory ?? "")}\n`);
    this.process.stdin.write(`PLOT_WIDTH:${request.plot?.widthInches ?? ""}\n`);
    this.process.stdin.write(`PLOT_HEIGHT:${request.plot?.heightInches ?? ""}\n`);
    this.process.stdin.write(`PLOT_DPI:${request.plot?.dpi ?? ""}\n`);
    this.process.stdin.write(`DF_RENDER:${request.dataFrame?.render === false ? "0" : "1"}\n`);
    this.process.stdin.write(`DF_MAX_ROWS:${request.dataFrame?.maxRows ?? ""}\n`);
    const codeLines = toProtocolLines(request.code);
    this.process.stdin.write(`CODE_COUNT:${codeLines.length}\n`);
    for (const line of codeLines) {
      this.process.stdin.write(`LINE:${encodeProtocolLine(line)}\n`);
    }
    this.process.stdin.write(`${COMMAND_END_MARKER}\n`);
  }

  private failQueue(error: Error): void {
    const queued = this.queue.splice(0, this.queue.length);
    for (const task of queued) {
      task.reject(error);
    }
  }

  public async dispose(): Promise<void> {
    this.alive = false;
    // Only a session that actually started gets its queued chunks cancelled here.
    // A session disposed because startup failed (e.g. the eviction in
    // getOrCreateSession) must let drainQueue reject the queue with the real
    // startup error instead of masking it with a cancellation.
    if (this.sessionReady) {
      this.failQueue(new CancelledExecutionError("R session was disposed."));
    }
    this.lineReader.close();
    this.process.stdin.end();
    this.process.kill();
  }

  private handleStdoutLine(line: string): void {
    if (line === READY_MARKER) {
      this.sessionReady = true;
      clearTimeout(this.startTimer);
      this.readyResolve();
      return;
    }

    if (line === RESULT_START_MARKER) {
      this.waitingForResult = true;
      this.currentLines = [];
      return;
    }

    if (line === PROMPT_START_MARKER) {
      this.waitingForPrompt = true;
      this.currentPromptLines = [];
      this.clearExecutionTimeout();
      return;
    }

    if (line === PROMPT_END_MARKER) {
      this.waitingForPrompt = false;
      const promptLines = [...this.currentPromptLines];
      this.currentPromptLines = [];
      void this.handlePromptRequest(promptLines);
      return;
    }

    if (line === RESULT_END_MARKER) {
      this.waitingForResult = false;
      const pending = this.pending;
      this.pending = undefined;
      this.pendingTask = undefined;

      try {
        if (!pending || pending.abandoned) {
          return;
        }

        const payload = parseRawExecutionPayload(this.currentLines);
        if (this.runtimeStderr.trim().length > 0) {
          payload.stderr = payload.stderr.length > 0 ? `${payload.stderr}\n${this.runtimeStderr.trimEnd()}` : this.runtimeStderr.trimEnd();
        }
        pending.resolve(payload);
      } catch (error) {
        pending?.reject(error instanceof Error ? error : new Error(String(error)));
      } finally {
        this.currentLines = [];
        this.runtimeStderr = "";
        // The slot is free again: kick off the next queued chunk, if any.
        this.drainQueue();
      }

      return;
    }

    if (this.waitingForPrompt) {
      this.currentPromptLines.push(line);
      return;
    }

    if (this.waitingForResult) {
      this.currentLines.push(line);
    }
  }

  private armExecutionTimeout(): void {
    this.clearExecutionTimeout();
    if (this.executionTimeoutMs <= 0) {
      return;
    }

    this.executionTimeout = setTimeout(() => {
      const pending = this.pending;
      if (!pending || pending.abandoned) {
        return;
      }

      try {
        this.interruptProcess();
      } catch (error) {
        pending.reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }

      pending.abandoned = true;
      this.promptHandler = undefined;
      pending.reject(
        new InteractiveExecutionError(
          `Inline execution timed out after ${this.executionTimeoutMs}ms and may need interactive input.`
        )
      );
    }, this.executionTimeoutMs);
  }

  private clearExecutionTimeout(): void {
    if (this.executionTimeout) {
      clearTimeout(this.executionTimeout);
      this.executionTimeout = undefined;
    }
  }

  private interruptProcess(): void {
    // Guard on whether the process is still running, not on process.killed:
    // child.killed flips to true after the first kill() and stays true even though
    // the R session survives a SIGINT (it catches the interrupt). Keying off it would
    // make every interrupt after the first one a no-op, so the currently running chunk
    // could never be stopped again.
    if (!this.alive) {
      return;
    }

    if (!this.process.kill("SIGINT")) {
      throw new Error("Unable to interrupt R session.");
    }
  }

  private async handlePromptRequest(lines: string[]): Promise<void> {
    const pending = this.pending;
    if (!pending) {
      return;
    }

    let request: InteractivePromptRequest;
    try {
      request = parsePromptRequest(lines);
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error(String(error)));
      this.pending = undefined;
      this.promptHandler = undefined;
      return;
    }

    try {
      const response = this.promptHandler
        ? await this.promptHandler(request)
        : { cancelled: true } satisfies InteractivePromptResponse;
      this.writePromptResponse(response);
      this.armExecutionTimeout();
    } catch (error) {
      this.writePromptResponse({ cancelled: true });
      pending.reject(error instanceof Error ? error : new Error(String(error)));
      this.pending = undefined;
      this.promptHandler = undefined;
    }
  }

  private writePromptResponse(response: InteractivePromptResponse): void {
    this.process.stdin.write(`${PROMPT_RESPONSE_START_MARKER}\n`);
    this.process.stdin.write(`STATUS:${response.cancelled ? "cancelled" : "ok"}\n`);
    this.process.stdin.write(`VALUE:${sanitizePromptValue(response.value)}\n`);
    this.process.stdin.write(`${PROMPT_RESPONSE_END_MARKER}\n`);
  }
}

function parseRawExecutionPayload(lines: string[]): RawExecutionPayload {
  const metadata = new Map<string, string>();
  const sections = new Map<string, string[]>();
  
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const sectionHeader = line.match(/^SECTION:([A-Z_]+):COUNT:(\d+)$/);
    if (sectionHeader) {
      const [, sectionName, countText] = sectionHeader;
      const count = Number.parseInt(countText, 10);
      const values: string[] = [];
      for (let offset = 0; offset < count && index + 1 < lines.length; offset += 1) {
        values.push(decodeProtocolLine(stripProtocolLinePrefix(lines[++index])));
      }
      sections.set(sectionName, values);
      continue;
    }

    const separatorIndex = line.indexOf(":");
    if (separatorIndex > 0) {
      metadata.set(line.slice(0, separatorIndex), line.slice(separatorIndex + 1));
    }
  }

  return {
    success: metadata.get("SUCCESS") === "1",
    startedAt: Number(metadata.get("STARTED_AT") ?? Date.now()),
    finishedAt: Number(metadata.get("FINISHED_AT") ?? Date.now()),
    stdout: (sections.get("STDOUT") ?? []).join("\n"),
    stderr: (sections.get("STDERR") ?? []).join("\n"),
    html: (sections.get("HTML") ?? []).join("\n"),
    plots: (sections.get("PLOTS") ?? []).filter((entry) => entry.trim().length > 0)
  };
}

function parsePromptRequest(lines: string[]): InteractivePromptRequest {
  const metadata = new Map<string, string>();
  const sections = new Map<string, string[]>();
  
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const sectionHeader = line.match(/^SECTION:([A-Z_]+):COUNT:(\d+)$/);
    if (sectionHeader) {
      const [, sectionName, countText] = sectionHeader;
      const count = Number.parseInt(countText, 10);
      const values: string[] = [];
      for (let offset = 0; offset < count && index + 1 < lines.length; offset += 1) {
        values.push(decodeProtocolLine(stripProtocolLinePrefix(lines[++index])));
      }
      sections.set(sectionName, values);
      continue;
    }

    const separatorIndex = line.indexOf(":");
    if (separatorIndex > 0) {
      metadata.set(line.slice(0, separatorIndex), line.slice(separatorIndex + 1));
    }
  }

  const kind = metadata.get("KIND");
  if (kind !== "select" && kind !== "input" && kind !== "confirm") {
    throw new Error(`Unsupported interactive prompt kind "${kind ?? ""}".`);
  }

  const choiceLabels = sections.get("CHOICE_LABELS") ?? [];
  const choiceValues = sections.get("CHOICE_VALUES") ?? [];
  const choices: InteractivePromptChoice[] = choiceLabels.map((label, index) => ({
    label,
    value: choiceValues[index] ?? label
  }));
  const promptLines = sections.get("PROMPT") ?? [];
  const titleLines = sections.get("TITLE") ?? [];

  return {
    kind,
    title: titleLines.length > 0 ? titleLines.join("\n") : undefined,
    prompt: promptLines.join("\n").trim() || "Interactive input requested",
    placeHolder: metadata.get("PLACEHOLDER") || undefined,
    defaultValue: metadata.get("DEFAULT") || undefined,
    allowEmpty: metadata.get("ALLOW_EMPTY") !== "0",
    choices: choices.length > 0 ? choices : undefined
  };
}

function sanitizePromptValue(value?: string): string {
  return (value ?? "").replace(/\r?\n/g, " ");
}

function toProtocolLines(value: string): string[] {
  const normalized = value.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function encodeProtocolLine(value: string): string {
  return encodeURIComponent(value);
}

function decodeProtocolLine(value: string): string {
  return decodeURIComponent(value);
}

function stripProtocolLinePrefix(line: string): string {
  return line.startsWith("LINE:") ? line.slice("LINE:".length) : "";
}

function escapeRString(value: string): string {
  return value.replace(/\\/g, "/").replace(/'/g, "\\'");
}
