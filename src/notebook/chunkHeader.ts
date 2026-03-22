export function normalizeChunkHeaderInfo(value: string): string {
  let trimmed = value.trim();

  const fencedMatch = trimmed.match(/^`{3,}\{(.*)\}$/);
  if (fencedMatch) {
    trimmed = fencedMatch[1].trim();
  }

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    trimmed = trimmed.slice(1, -1).trim();
  }

  return trimmed;
}

export function extractChunkLanguage(headerInfo: string): string | undefined {
  const normalized = normalizeChunkHeaderInfo(headerInfo);
  if (!normalized) {
    return undefined;
  }

  const separatorIndex = normalized.search(/[\s,]/);
  return separatorIndex === -1 ? normalized : normalized.slice(0, separatorIndex).trim() || undefined;
}

export function extractChunkLabel(headerInfo: string): string | undefined {
  const normalized = normalizeChunkHeaderInfo(headerInfo);
  const language = extractChunkLanguage(normalized);
  if (!language) {
    return undefined;
  }

  const remainder = normalized.slice(language.length).trim().replace(/^,/, "").trim();
  if (!remainder) {
    return undefined;
  }

  const firstToken = remainder.split(",")[0]?.trim();
  if (!firstToken || firstToken.includes("=")) {
    return undefined;
  }

  return firstToken;
}

export function buildChunkHeader(headerInfo: string, fenceLength = 3): string {
  const normalized = normalizeChunkHeaderInfo(headerInfo);
  return `${"`".repeat(Math.max(3, fenceLength))}{${normalized}}`;
}

export function validateChunkHeaderInfo(value: string, expectedLanguage: string): string | undefined {
  const normalized = normalizeChunkHeaderInfo(value);
  if (!normalized) {
    return "Chunk header cannot be empty.";
  }

  if (/\r|\n/.test(normalized)) {
    return "Chunk header must stay on a single line.";
  }

  const language = extractChunkLanguage(normalized);
  if (!language) {
    return "Chunk header must start with a language identifier.";
  }

  if (language.toLowerCase() !== expectedLanguage.toLowerCase()) {
    return `Changing the chunk language is not supported yet. Keep \"${expectedLanguage}\".`;
  }

  return undefined;
}
