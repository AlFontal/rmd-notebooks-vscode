import * as path from "node:path";
import * as readline from "node:readline";
import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import * as vscode from "vscode";
import { ErrorOutputItem, HtmlOutputItem, ImageOutputItem, OutputItem, TextOutputItem } from "../document/chunkTypes";
import {
  Executor,
  ExecutionContext,
  ExecutionResult,
  InteractivePromptChoice,
  InteractivePromptRequest,
  InteractivePromptResponse
} from "./executorTypes";
import { InteractiveExecutionError } from "./executionErrors";

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

export class RExecutor implements Executor {
  public readonly language = "r";
  private readonly sessions = new Map<string, RSession>();

  public constructor(private readonly extensionUri: vscode.Uri) {}

  public canHandle(language: string): boolean {
    return language.toLowerCase() === "r";
  }

  public async warmupSession(documentUri: string): Promise<void> {
    const session = this.getOrCreateSession(documentUri);
    await session.ready();
  }

  public async executeChunk(context: ExecutionContext): Promise<ExecutionResult> {
    const session = this.getOrCreateSession(context.documentUri);
    const timeoutMs = vscode.workspace.getConfiguration("rmdNotebooks").get<number>("execution.interactiveFallbackTimeoutMs", 15000);
    let payload: RawExecutionPayload;

    try {
      payload = await session.execute(
        context.code,
        context.workspaceFolder,
        context.artifactDirectory,
        context.plot,
        timeoutMs,
        context.prompt
      );
    } catch (error) {
      if (error instanceof InteractiveExecutionError) {
        this.sessions.delete(context.documentUri);
        await session.dispose();
      }
      throw error;
    }

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

  public async disposeAll(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((uri) => this.disposeSession(uri)));
  }

  private getOrCreateSession(documentUri: string): RSession {
    const existing = this.sessions.get(documentUri);
    if (existing) {
      return existing;
    }

    const configuration = vscode.workspace.getConfiguration("rmdNotebooks");
    const rPath = configuration.get<string>("r.path", "R");
    const sessionScriptPath = path.join(this.extensionUri.fsPath, "media", "r", "rmd_notebooks_session.R");
    const created = new RSession(rPath, sessionScriptPath);
    this.sessions.set(documentUri, created);
    return created;
  }
}

class RSession {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly lineReader: readline.Interface;
  private readonly readyPromise: Promise<void>;
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  private pending: {
    resolve: (payload: RawExecutionPayload) => void;
    reject: (error: Error) => void;
  } | undefined;
  private currentLines: string[] = [];
  private currentPromptLines: string[] = [];
  private waitingForResult = false;
  private waitingForPrompt = false;
  private startupErrors: string[] = [];
  private readonly startTimer: NodeJS.Timeout;
  private promptHandler: ((request: InteractivePromptRequest) => Promise<InteractivePromptResponse>) | undefined;
  private executionTimeout: NodeJS.Timeout | undefined;
  private executionTimeoutMs = 0;

  public constructor(rPath: string, scriptPath: string) {
    this.process = spawn(rPath, ["--slave", "--vanilla"], {
      stdio: "pipe"
    });

    this.lineReader = readline.createInterface({
      input: this.process.stdout
    });

    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    this.startTimer = setTimeout(() => {
      this.readyReject(new Error(`Timed out starting R session. ${this.startupErrors.join("\n")}`.trim()));
    }, 10000);

    this.lineReader.on("line", (line) => this.handleStdoutLine(line));
    this.process.stderr.on("data", (chunk) => {
      this.startupErrors.push(chunk.toString());
      if (this.pending) {
        this.clearExecutionTimeout();
        this.promptHandler = undefined;
        this.pending.reject(new Error(chunk.toString()));
        this.pending = undefined;
      }
    });
    this.process.on("error", (error) => {
      this.readyReject(error);
      if (this.pending) {
        this.clearExecutionTimeout();
        this.promptHandler = undefined;
        this.pending.reject(error);
        this.pending = undefined;
      }
    });
    this.process.on("exit", (code, signal) => {
      const message = `R session exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"}).`;
      if (this.pending) {
        this.clearExecutionTimeout();
        this.promptHandler = undefined;
        this.pending.reject(new Error(message));
        this.pending = undefined;
      }
      this.readyReject(new Error(message));
    });

    // Start an interactive R session, then source the command loop script over stdin.
    this.process.stdin.write(`source('${escapeRString(scriptPath)}')\n`);
  }

  public async ready(): Promise<void> {
    await this.readyPromise;
  }

  public async execute(
    code: string,
    workingDirectory?: string,
    artifactDirectory?: string,
    plot?: ExecutionContext["plot"],
    timeoutMs = 15000,
    promptHandler?: (request: InteractivePromptRequest) => Promise<InteractivePromptResponse>
  ): Promise<RawExecutionPayload> {
    await this.ready();
    if (this.pending) {
      throw new Error("R session is already executing a chunk.");
    }

    return new Promise<RawExecutionPayload>((resolve, reject) => {
      this.pending = { resolve, reject };
      this.promptHandler = promptHandler;
      this.executionTimeoutMs = timeoutMs;
      this.armExecutionTimeout();
      this.process.stdin.write(`${COMMAND_MARKER}\n`);
      this.process.stdin.write(`${workingDirectory ?? ""}\n`);
      this.process.stdin.write(`${artifactDirectory ?? ""}\n`);
      this.process.stdin.write(`${plot?.widthInches ?? ""}\n`);
      this.process.stdin.write(`${plot?.heightInches ?? ""}\n`);
      this.process.stdin.write(`${plot?.dpi ?? ""}\n`);
      this.process.stdin.write(code);
      if (!code.endsWith("\n")) {
        this.process.stdin.write("\n");
      }
      this.process.stdin.write(`${COMMAND_END_MARKER}\n`);

      const originalResolve = resolve;
      const originalReject = reject;
      this.pending = {
        resolve: (payload) => {
          this.clearExecutionTimeout();
          this.promptHandler = undefined;
          originalResolve(payload);
        },
        reject: (error) => {
          this.clearExecutionTimeout();
          this.promptHandler = undefined;
          originalReject(error);
        }
      };
    });
  }

  public async dispose(): Promise<void> {
    this.lineReader.close();
    this.process.stdin.end();
    this.process.kill();
  }

  private handleStdoutLine(line: string): void {
    if (line === READY_MARKER) {
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
      if (!pending) {
        return;
      }

      try {
        pending.resolve(parseRawExecutionPayload(this.currentLines));
      } catch (error) {
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      } finally {
        this.currentLines = [];
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
      if (!pending) {
        return;
      }

      const hadPromptOpen = this.waitingForPrompt;
      this.pending = undefined;
      this.promptHandler = undefined;
      this.waitingForResult = false;
      this.waitingForPrompt = false;
      this.currentLines = [];
      this.currentPromptLines = [];
      if (hadPromptOpen) {
        this.writePromptResponse({ cancelled: true });
      }
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
  let currentSection: string | undefined;

  for (const line of lines) {
    const sectionStart = line.match(/^SECTION:([A-Z_]+):START$/);
    if (sectionStart) {
      currentSection = sectionStart[1];
      sections.set(currentSection, []);
      continue;
    }

    const sectionEnd = line.match(/^SECTION:([A-Z_]+):END$/);
    if (sectionEnd) {
      currentSection = undefined;
      continue;
    }

    if (currentSection) {
      sections.get(currentSection)?.push(line);
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
  let currentSection: string | undefined;

  for (const line of lines) {
    const sectionStart = line.match(/^SECTION:([A-Z_]+):START$/);
    if (sectionStart) {
      currentSection = sectionStart[1];
      sections.set(currentSection, []);
      continue;
    }

    const sectionEnd = line.match(/^SECTION:([A-Z_]+):END$/);
    if (sectionEnd) {
      currentSection = undefined;
      continue;
    }

    if (currentSection) {
      sections.get(currentSection)?.push(line);
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

function escapeRString(value: string): string {
  return value.replace(/\\/g, "/").replace(/'/g, "\\'");
}
