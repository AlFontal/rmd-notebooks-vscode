import * as path from "node:path";
import * as vscode from "vscode";
import { ChunkOutputRecord, ExecutableChunk } from "../document/chunkTypes";

type RevealMode = "always" | "errors" | "never";

export class OutputChannelController implements vscode.Disposable {
  private readonly channel = vscode.window.createOutputChannel("Rmd Notebooks");
  private readonly transcript: string[] = [];

  public logRunStarted(document: vscode.TextDocument, chunk: ExecutableChunk): void {
    this.appendBlock([
      formatHeader(document, chunk),
      "status: running",
      ""
    ]);
    this.maybeReveal("always");
    void vscode.window.setStatusBarMessage(`Rmd Notebooks: running ${getChunkDisplayName(chunk)}`, 2000);
  }

  public logRunCompleted(document: vscode.TextDocument, chunk: ExecutableChunk, record: ChunkOutputRecord): void {
    const lines = [formatHeader(document, chunk), `status: ${record.status}`];
    if (record.stale) {
      lines.push("stale: true");
    }
    lines.push(...formatOutputs(record));
    lines.push("");
    this.appendBlock(lines);

    const shouldReveal = record.status === "error" ? "errors" : "always";
    this.maybeReveal(shouldReveal);

    if (record.status === "error") {
      void vscode.window.showErrorMessage(`Rmd Notebooks: ${getChunkDisplayName(chunk)} failed. See the Rmd Notebooks output panel.`);
    } else if (record.status === "redirected") {
      void vscode.window.setStatusBarMessage(`Rmd Notebooks: redirected ${getChunkDisplayName(chunk)} to the R terminal`, 3000);
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

  public dispose(): void {
    this.channel.dispose();
  }

  private appendBlock(lines: string[]): void {
    const block = lines.join("\n");
    this.transcript.push(block);
    this.channel.appendLine(block);
  }

  private maybeReveal(event: "always" | "errors"): void {
    const revealMode = vscode.workspace.getConfiguration("rmdNotebooks").get<RevealMode>("output.revealMode", "always");
    if (revealMode === "never") {
      return;
    }

    if (revealMode === "errors" && event !== "errors") {
      return;
    }

    this.reveal(true);
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
      lines.push("[stderr]");
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
    }
  }

  return lines;
}
