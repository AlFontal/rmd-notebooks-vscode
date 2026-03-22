import * as path from "node:path";
import * as vscode from "vscode";
import { ChunkIdentitySeed, ChunkOutputRecord, ImageOutputItem, OutputItem } from "../document/chunkTypes";

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

  public toIdentitySeeds(outputs: Iterable<ChunkOutputRecord>): ChunkIdentitySeed[] {
    return [...outputs].map((record) => ({
      chunkId: record.chunkId,
      contentHash: record.contentHash,
      headerHash: record.headerHash,
      bodyHash: record.bodyHash,
      language: record.language,
      label: record.label,
      startLine: record.startLine,
      header: record.header
    }));
  }

  public async getArtifactDirectory(documentUri: string): Promise<string | undefined> {
    if (!this.context.storageUri) {
      return undefined;
    }

    const uri = vscode.Uri.joinPath(this.context.storageUri, "artifacts", sanitizePath(documentUri));
    await vscode.workspace.fs.createDirectory(uri);
    return uri.fsPath;
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
