import { InlineChunksCodeCellMetadata } from "./notebookTypes";

export function formatChunkHeaderBadge(metadata: InlineChunksCodeCellMetadata): string {
  return `{${metadata.headerInfo}}`;
}

export function formatChunkHeaderTooltip(metadata: InlineChunksCodeCellMetadata): string {
  const lines = [
    `Chunk header: ${metadata.header}`
  ];

  if (metadata.label) {
    lines.push(`Label: \`${metadata.label}\``);
  }

  lines.push(`Language: \`${metadata.language}\``);

  return lines.join("\n\n");
}
