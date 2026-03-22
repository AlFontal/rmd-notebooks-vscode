import * as vscode from "vscode";

const SUPPORTED_EXTENSION_PATTERN = /\.(qmd|rmd)$/i;

export function isSupportedDocument(document: vscode.TextDocument): boolean {
  return isSupportedUri(document.uri);
}

export function isSupportedUri(uri: vscode.Uri): boolean {
  return SUPPORTED_EXTENSION_PATTERN.test(uri.fsPath || uri.path);
}

export function getDocumentSelector(): vscode.DocumentSelector {
  return [
    { scheme: "file", pattern: "**/*.qmd" },
    { scheme: "file", pattern: "**/*.QMD" },
    { scheme: "file", pattern: "**/*.Rmd" },
    { scheme: "file", pattern: "**/*.rmd" },
    { scheme: "untitled", pattern: "**/*.qmd" },
    { scheme: "untitled", pattern: "**/*.QMD" },
    { scheme: "untitled", pattern: "**/*.Rmd" },
    { scheme: "untitled", pattern: "**/*.rmd" }
  ];
}
