import * as vscode from "vscode";
import { ChunkIdentitySeed, ChunkDocumentSnapshot, ExecutableChunk } from "./chunkTypes";
import { assignChunkIdentities } from "./chunkIdentity";
import { parseExecutableChunks } from "./chunkParser";

export class ChunkDocumentService {
  private readonly snapshots = new Map<string, ChunkDocumentSnapshot>();

  public buildSnapshot(document: vscode.TextDocument, previousSeeds: ChunkIdentitySeed[] = []): ChunkDocumentSnapshot {
    const parsedChunks = parseExecutableChunks(document.uri.toString(), document.getText());
    const chunks = assignChunkIdentities(document.uri.toString(), parsedChunks, previousSeeds);
    const snapshot: ChunkDocumentSnapshot = {
      documentUri: document.uri.toString(),
      version: document.version,
      chunks,
      generatedAt: Date.now()
    };

    this.snapshots.set(document.uri.toString(), snapshot);
    return snapshot;
  }

  public getSnapshot(uri: vscode.Uri): ChunkDocumentSnapshot | undefined {
    return this.snapshots.get(uri.toString());
  }

  public deleteSnapshot(uri: vscode.Uri): void {
    this.snapshots.delete(uri.toString());
  }

  public findChunkAtPosition(document: vscode.TextDocument, position: vscode.Position): ExecutableChunk | undefined {
    const snapshot = this.getSnapshot(document.uri);
    if (!snapshot) {
      return undefined;
    }

    return snapshot.chunks.find((chunk) => position.line >= chunk.startLine && position.line <= chunk.endLine);
  }
}
