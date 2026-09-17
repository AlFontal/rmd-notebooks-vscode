import { InlineChunksCodeCellMetadata } from "./notebookTypes";
import { extractChunkLanguage, normalizeChunkHeaderInfo } from "./chunkHeader";

export function formatChunkHeaderBadge(
  metadata: InlineChunksCodeCellMetadata,
  body = ""
): string | undefined {
  const headerInfo = normalizeChunkHeaderInfo(metadata.headerInfo);
  const language = extractChunkLanguage(headerInfo);
  const headerDetails = language
    ? headerInfo.slice(language.length).trim().replace(/^,/, "").trim()
    : "";
  const details = [headerDetails, ...getLeadingQuartoOptionSummaries(body)].filter(Boolean);
  return details.length > 0 ? details.join(" | ") : undefined;
}

export function formatChunkHeaderTooltip(metadata: InlineChunksCodeCellMetadata, body = ""): string {
  const lines = [
    `Chunk header: ${metadata.header}`
  ];

  if (metadata.label) {
    lines.push(`Label: \`${metadata.label}\``);
  }

  lines.push(`Language: \`${metadata.language}\``);

  const quartoOptions = getLeadingQuartoOptionSummaries(body);
  if (quartoOptions.length > 0) {
    lines.push(`Cell options: ${quartoOptions.join(", ")}`);
  }

  return lines.join("\n\n");
}

function getLeadingQuartoOptionSummaries(body: string): string[] {
  const summaries: string[] = [];
  for (const line of body.replace(/\r\n/g, "\n").split("\n")) {
    const match = line.match(/^\s*#\|\s*([A-Za-z0-9_.-]+)\s*:\s*(.*?)\s*$/);
    if (!match) {
      break;
    }
    summaries.push(match[1].toLowerCase() === "label" ? match[2] : `${match[1]}=${match[2]}`);
  }
  return summaries;
}
