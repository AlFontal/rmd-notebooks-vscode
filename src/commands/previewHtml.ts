import * as vscode from "vscode";
import { INLINE_CHUNKS_NOTEBOOK_TYPE, isInlineChunksNotebook } from "../notebook/notebookTypes";

const VSCODE_R_EXTENSION_ID = "REditorSupport.r";
const VSCODE_R_PREVIEW_COMMAND = "r.rmarkdown.showPreviewToSide";
const QUARTO_EXTENSION_ID = "quarto.quarto";
const QUARTO_PREVIEW_COMMAND = "quarto.preview";

export type PreviewResult = "previewed" | "cancelled" | "unsupported" | "missing";

export interface PreviewRequest {
  uri: vscode.Uri;
  viewColumn?: vscode.ViewColumn;
  save(): Thenable<boolean>;
}

export interface PreviewServices {
  ensureIntegration(extensionId: string, commandId: string, displayName: string): Promise<boolean>;
  executeCommand(commandId: string, ...args: unknown[]): Thenable<unknown>;
  openRawSource(uri: vscode.Uri, viewColumn?: vscode.ViewColumn): Promise<void>;
  restoreNotebook(uri: vscode.Uri, viewColumn?: vscode.ViewColumn): Promise<void>;
  showWarning(message: string): Thenable<unknown>;
}

export async function previewActiveNotebookHtml(): Promise<PreviewResult> {
  const editor = vscode.window.activeNotebookEditor;
  if (!editor || !isInlineChunksNotebook(editor.notebook)) {
    void vscode.window.showWarningMessage("Rmd Notebooks: open an .Rmd or .qmd notebook to preview it.");
    return "unsupported";
  }

  return previewNotebookHtml(
    {
      uri: editor.notebook.uri,
      viewColumn: editor.viewColumn,
      save: () => editor.notebook.save()
    },
    createPreviewServices()
  );
}

export async function previewNotebookHtml(request: PreviewRequest, services: PreviewServices): Promise<PreviewResult> {
  const extension = request.uri.path.slice(request.uri.path.lastIndexOf(".")).toLowerCase();
  if (extension !== ".rmd" && extension !== ".qmd") {
    await services.showWarning("Rmd Notebooks: HTML preview is available for .Rmd and .qmd files.");
    return "unsupported";
  }

  if (!(await request.save())) {
    await services.showWarning("Rmd Notebooks: save the notebook before opening its HTML preview.");
    return "cancelled";
  }

  if (extension === ".qmd") {
    if (!(await services.ensureIntegration(QUARTO_EXTENSION_ID, QUARTO_PREVIEW_COMMAND, "Quarto"))) {
      return "missing";
    }
    await services.executeCommand(QUARTO_PREVIEW_COMMAND);
    return "previewed";
  }

  if (!(await services.ensureIntegration(VSCODE_R_EXTENSION_ID, VSCODE_R_PREVIEW_COMMAND, "vscode-R"))) {
    return "missing";
  }

  try {
    await services.openRawSource(request.uri, request.viewColumn);
    await services.executeCommand(VSCODE_R_PREVIEW_COMMAND);
    return "previewed";
  } finally {
    await services.restoreNotebook(request.uri, request.viewColumn);
  }
}

function createPreviewServices(): PreviewServices {
  return {
    ensureIntegration: async (extensionId, commandId, displayName) => {
      const extension = vscode.extensions.getExtension(extensionId);
      if (!extension) {
        const choice = await vscode.window.showWarningMessage(
          `Rmd Notebooks: ${displayName} is required to preview this document.`,
          `Find ${displayName}`
        );
        if (choice === `Find ${displayName}`) {
          await vscode.commands.executeCommand("workbench.extensions.search", `@id:${extensionId}`);
        }
        return false;
      }

      if (!extension.isActive) {
        await extension.activate();
      }
      const commands = await vscode.commands.getCommands(true);
      if (!commands.includes(commandId)) {
        void vscode.window.showWarningMessage(
          `Rmd Notebooks: ${displayName} is installed but does not provide the expected preview command.`
        );
        return false;
      }
      return true;
    },
    executeCommand: (commandId, ...args) => vscode.commands.executeCommand(commandId, ...args),
    openRawSource: async (uri, viewColumn) => {
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document, {
        preview: false,
        preserveFocus: false,
        viewColumn
      });
    },
    restoreNotebook: async (uri, viewColumn) => {
      await vscode.commands.executeCommand("vscode.openWith", uri, INLINE_CHUNKS_NOTEBOOK_TYPE, {
        preview: false,
        preserveFocus: false,
        viewColumn
      });
    },
    showWarning: (message) => vscode.window.showWarningMessage(message)
  };
}
