import * as vscode from "vscode";
import { ChunkDocumentService } from "../document/chunkDocumentService";
import { isSupportedDocument } from "../util/documentMatchers";

export class ChunkCodeLensProvider implements vscode.CodeLensProvider {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  public readonly onDidChangeCodeLenses = this.onDidChangeEmitter.event;

  public constructor(private readonly documentService: ChunkDocumentService) {}

  public provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!isSupportedDocument(document)) {
      return [];
    }

    const snapshot = this.documentService.getSnapshot(document.uri);
    if (!snapshot) {
      return [];
    }

    return snapshot.chunks.flatMap((chunk) => {
      const range = new vscode.Range(chunk.startLine, 0, chunk.startLine, 0);
      const documentUri = document.uri.toString();
      const chunkId = chunk.identity.chunkId;
      return [
        new vscode.CodeLens(range, {
          command: "rmdNotebooks.runCurrentChunk",
          title: "Run",
          arguments: [documentUri, chunkId]
        }),
        new vscode.CodeLens(range, {
          command: "rmdNotebooks.runAllChunks",
          title: "Run All",
          arguments: [documentUri]
        }),
        new vscode.CodeLens(range, {
          command: "rmdNotebooks.clearCurrentOutput",
          title: "Clear Output",
          arguments: [documentUri, chunkId]
        })
      ];
    });
  }

  public refresh(): void {
    this.onDidChangeEmitter.fire();
  }
}
