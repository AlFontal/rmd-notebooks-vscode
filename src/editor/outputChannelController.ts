import * as path from "node:path";
import * as vscode from "vscode";
import { ChunkOutputRecord, ExecutableChunk } from "../document/chunkTypes";
import { ExecutionSurface, getOutputPolicy, OutputPolicyEvent, RevealMode } from "./outputPolicy";

export class OutputChannelController implements vscode.Disposable {
  private readonly channel = vscode.window.createOutputChannel("Rmd Notebooks");
  private readonly transcript: string[] = [];

  public logRunStarted(document: vscode.TextDocument, chunk: ExecutableChunk, surface: ExecutionSurface): void {
    this.appendBlock([
      formatHeader(document, chunk),
      "status: running",
      ""
    ]);
    this.applyPolicy(surface, "started");
    void vscode.window.setStatusBarMessage(`Rmd Notebooks: running ${getChunkDisplayName(chunk)}`, 2000);
  }

  public logRunCompleted(
    document: vscode.TextDocument,
    chunk: ExecutableChunk,
    record: ChunkOutputRecord,
    surface: ExecutionSurface
  ): void {
    const lines = [formatHeader(document, chunk), `status: ${record.status}`];
    if (record.stale) {
      lines.push("stale: true");
    }
    lines.push(...formatOutputs(record));
    lines.push("");
    this.appendBlock(lines);

    const policy = this.applyPolicy(surface, record.status);

    if (record.status === "error") {
      if (policy.showGenericError) {
        void vscode.window.showErrorMessage(`Rmd Notebooks: ${getChunkDisplayName(chunk)} failed. See the Rmd Notebooks output panel.`);
      }
    } else if (record.status === "redirected") {
      void vscode.window.setStatusBarMessage(`Rmd Notebooks: redirected ${getChunkDisplayName(chunk)} to the R terminal`, 3000);
    } else if (record.status === "cancelled") {
      void vscode.window.setStatusBarMessage(`Rmd Notebooks: cancelled ${getChunkDisplayName(chunk)}`, 2500);
    } else {
      void vscode.window.setStatusBarMessage(`Rmd Notebooks: finished ${getChunkDisplayName(chunk)}`, 2500);
    }
  }

  public reveal(preserveFocus = false): void {
    this.channel.show(preserveFocus);
  }

  public getTranscript(): string {
    return this.transcript.join("\n");
  }

  public logDiagnostic(message: string): void {
    this.appendBlock(["# Python environment discovery", message, ""]);
  }

  public dispose(): void {
    this.channel.dispose();
  }

  private appendBlock(lines: string[]): void {
    const block = lines.join("\n");
    this.transcript.push(block);
    this.channel.appendLine(block);
  }

  private applyPolicy(surface: ExecutionSurface, event: OutputPolicyEvent): ReturnType<typeof getOutputPolicy> {
    const revealMode = vscode.workspace.getConfiguration("rmdNotebooks").get<RevealMode>("output.revealMode", "errors");
    const policy = getOutputPolicy(surface, revealMode, event);
    if (policy.reveal) {
      this.reveal(true);
    }
    return policy;
  }
}

function formatHeader(document: vscode.TextDocument, chunk: ExecutableChunk): string {
  return `# ${path.basename(document.uri.fsPath || document.uri.path)} :: ${getChunkDisplayName(chunk)}`;
}

function getChunkDisplayName(chunk: ExecutableChunk): string {
  return chunk.label ? `chunk "${chunk.label}"` : `chunk at line ${chunk.startLine + 1}`;
}

function formatOutputs(record: ChunkOutputRecord): string[] {
  if (record.outputs.length === 0) {
    return ["output: [none]"];
  }

  const lines: string[] = [];
  for (const output of record.outputs) {
    if (output.type === "text") {
      lines.push("[stdout]");
      lines.push(output.text);
      continue;
    }

    if (output.type === "error") {
      lines.push("[error]");
      lines.push(output.text);
      continue;
    }

    if (output.type === "stream") {
      lines.push(`[${output.name}]`);
      lines.push(output.text);
      continue;
    }

    if (output.type === "image") {
      lines.push(`[plot] ${output.path}`);
      continue;
    }

    if (output.type === "html") {
      lines.push("[html]");
      lines.push(output.html);
      continue;
    }

    if (output.type === "markdown") {
      lines.push("[markdown]");
      lines.push(output.markdown);
      continue;
    }

    if (output.type === "display") {
      lines.push(`[display: ${output.items.map((item) => item.mimeType).join(", ")}]`);
    }
  }

  return lines;
}
