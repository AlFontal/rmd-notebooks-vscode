import * as path from "node:path";
import * as vscode from "vscode";
import { ChunkOutputRecord, ImageOutputItem, OutputItem } from "../document/chunkTypes";
import { sha1 } from "../util/hash";

const STORAGE_PREFIX = "rmdNotebooks.outputs.v1:";
const ARTIFACT_PREFIX = "artifact:";

export class OutputStore {
  public constructor(private readonly context: vscode.ExtensionContext) {}

  public async loadDocumentOutputs(documentUri: string): Promise<Map<string, ChunkOutputRecord>> {
    const storedEntries = this.context.workspaceState.get<ChunkOutputRecord[]>(this.getKey(documentUri), []);
    return new Map(storedEntries.map((entry) => [entry.chunkId, this.deserializeRecord(entry)]));
  }

  public async saveDocumentOutputs(documentUri: string, outputs: Map<string, ChunkOutputRecord>): Promise<void> {
    const values = [...outputs.values()].map((entry) => this.serializeRecord(entry));
    await this.context.workspaceState.update(this.getKey(documentUri), values);
  }

  public async clearDocumentOutputs(documentUri: string): Promise<void> {
    await this.context.workspaceState.update(this.getKey(documentUri), []);
  }

  public async getArtifactDirectory(documentUri: string): Promise<string | undefined> {
    if (!this.context.storageUri) {
      return undefined;
    }

    const uri = this.getArtifactDirectoryUri(this.context.storageUri, documentUri);
    await vscode.workspace.fs.createDirectory(uri);
    return uri.fsPath;
  }

  // Re-running or clearing a chunk leaves its previous plot files behind. Delete
  // files in the document's artifact directory that no output record references.
  public async pruneArtifacts(documentUri: string, outputs: Map<string, ChunkOutputRecord>): Promise<void> {
    if (!this.context.storageUri) {
      return;
    }

    const directory = this.getArtifactDirectoryUri(this.context.storageUri, documentUri);
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(directory);
    } catch {
      return;
    }

    const referenced = new Set(
      [...outputs.values()]
        .flatMap((record) => record.outputs)
        .flatMap((output) => (output.type === "image" ? [path.resolve(output.path)] : []))
    );
    await Promise.all(
      entries
        .filter(([name, type]) => type === vscode.FileType.File && !referenced.has(path.resolve(directory.fsPath, name)))
        .map(([name]) => Promise.resolve(vscode.workspace.fs.delete(vscode.Uri.joinPath(directory, name))).catch(() => undefined))
    );
  }

  // The readable name alone is not unique ("a/b.qmd" and "a_b.qmd" both sanitize to
  // "a_b.qmd"); the hash keeps each document's folder, and so its pruning, separate.
  private getArtifactDirectoryUri(storageUri: vscode.Uri, documentUri: string): vscode.Uri {
    return vscode.Uri.joinPath(storageUri, "artifacts", `${sanitizePath(documentUri)}-${sha1(documentUri).slice(0, 12)}`);
  }

  private getKey(documentUri: string): string {
    return `${STORAGE_PREFIX}${documentUri}`;
  }

  private serializeRecord(record: ChunkOutputRecord): ChunkOutputRecord {
    return {
      ...record,
      outputs: record.outputs.map((output) => this.serializeOutput(output))
    };
  }

  private deserializeRecord(record: ChunkOutputRecord): ChunkOutputRecord {
    return {
      ...record,
      outputs: record.outputs.map((output) => this.deserializeOutput(output))
    };
  }

  private serializeOutput(output: OutputItem): OutputItem {
    if (output.type !== "image" || !this.context.storageUri) {
      return output;
    }

    const rootPath = this.context.storageUri.fsPath;
    if (!path.isAbsolute(output.path) || !output.path.startsWith(rootPath)) {
      return output;
    }

    const relativePath = path.relative(rootPath, output.path);
    return {
      ...(output as ImageOutputItem),
      path: `${ARTIFACT_PREFIX}${relativePath}`
    };
  }

  private deserializeOutput(output: OutputItem): OutputItem {
    if (output.type !== "image" || !this.context.storageUri || !output.path.startsWith(ARTIFACT_PREFIX)) {
      return output;
    }

    const relativePath = output.path.slice(ARTIFACT_PREFIX.length);
    return {
      ...(output as ImageOutputItem),
      path: path.join(this.context.storageUri.fsPath, relativePath)
    };
  }
}

function sanitizePath(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, "_");
}
