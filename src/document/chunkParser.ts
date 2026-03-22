import { ParsedExecutableChunk } from "./chunkTypes";

const OPEN_FENCE_PATTERN = /^(\s*)(`{3,})\{([^}]*)\}\s*$/;

export function parseExecutableChunks(documentUri: string, text: string): ParsedExecutableChunk[] {
  const lines = splitLines(text);
  const chunks: ParsedExecutableChunk[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line.match(OPEN_FENCE_PATTERN);
    if (!match) {
      continue;
    }

    const fence = match[2];
    const headerInfo = match[3].trim();
    const parsedHeader = parseHeaderInfo(headerInfo);
    if (!parsedHeader.language) {
      continue;
    }

    const closeIndex = findClosingFence(lines, index + 1, fence.length);
    const endLine = closeIndex ?? Math.max(lines.length - 1, index);
    const bodyStart = index + 1;
    const bodyEnd = closeIndex === null ? endLine : Math.max(index, closeIndex - 1);
    const bodyLines = bodyStart <= bodyEnd ? lines.slice(bodyStart, bodyEnd + 1) : [];

    chunks.push({
      documentUri,
      language: parsedHeader.language,
      header: line,
      headerInfo,
      label: parsedHeader.label,
      body: bodyLines.join("\n"),
      isClosed: closeIndex !== null,
      fenceLength: fence.length,
      startLine: index,
      endLine,
      headerRange: {
        startLine: index,
        startCharacter: 0,
        endLine: index,
        endCharacter: line.length
      },
      bodyRange: {
        startLine: bodyStart,
        startCharacter: 0,
        endLine: bodyEnd,
        endCharacter: bodyLines.length > 0 ? bodyLines[bodyLines.length - 1].length : 0
      },
      fullRange: {
        startLine: index,
        startCharacter: 0,
        endLine,
        endCharacter: getLineLength(lines, endLine)
      }
    });

    if (closeIndex !== null) {
      index = closeIndex;
    }
  }

  return chunks;
}

function splitLines(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n");
  if (normalized.length === 0) {
    return [];
  }

  return normalized.split("\n");
}

function findClosingFence(lines: string[], startIndex: number, minimumFenceLength: number): number | null {
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line.startsWith("`")) {
      continue;
    }

    const fenceMatch = line.match(/^(`{3,})\s*$/);
    if (!fenceMatch) {
      continue;
    }

    if (fenceMatch[1].length >= minimumFenceLength) {
      return index;
    }
  }

  return null;
}

function parseHeaderInfo(headerInfo: string): { language: string; label?: string } {
  const trimmed = headerInfo.trim();
  if (!trimmed) {
    return { language: "" };
  }

  const firstSeparator = trimmed.search(/[\s,]/);
  const language = (firstSeparator === -1 ? trimmed : trimmed.slice(0, firstSeparator)).trim().toLowerCase();
  const remainder = firstSeparator === -1 ? "" : trimmed.slice(firstSeparator).trim();
  const rawLabel = remainder.split(",")[0]?.trim();
  const label = rawLabel && !rawLabel.includes("=") ? rawLabel : undefined;

  return { language, label };
}

function getLineLength(lines: string[], lineNumber: number): number {
  if (lineNumber < 0 || lineNumber >= lines.length) {
    return 0;
  }

  return lines[lineNumber].length;
}
