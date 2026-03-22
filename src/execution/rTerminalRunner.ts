import * as vscode from "vscode";

export class RTerminalRunner implements vscode.Disposable {
  private terminal: vscode.Terminal | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  public constructor() {
    this.disposables.push(
      vscode.window.onDidCloseTerminal((terminal) => {
        if (this.terminal && terminal === this.terminal) {
          this.terminal = undefined;
        }
      })
    );
  }

  public async runChunk(code: string, workspaceFolder?: string): Promise<void> {
    const terminal = this.getOrCreateTerminal(workspaceFolder);
    terminal.show(false);

    if (workspaceFolder) {
      terminal.sendText(`setwd(${toRString(workspaceFolder)})`, true);
    }

    terminal.sendText(code, true);
  }

  public dispose(): void {
    this.disposables.forEach((disposable) => disposable.dispose());
  }

  private getOrCreateTerminal(workspaceFolder?: string): vscode.Terminal {
    if (this.terminal && !this.terminal.exitStatus) {
      return this.terminal;
    }

    const configuration = vscode.workspace.getConfiguration("rmdNotebooks");
    const rPath = configuration.get<string>("r.path", "R");

    this.terminal = vscode.window.createTerminal({
      name: "Rmd Notebooks R",
      shellPath: rPath,
      shellArgs: ["--vanilla"],
      cwd: workspaceFolder
    });

    return this.terminal;
  }
}

function toRString(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}
