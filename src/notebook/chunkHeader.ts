export interface CanonicalChunkHeader {
  language: string;
  headerInfo: string;
  header: string;
}

export interface ChunkHeaderSource {
  header?: string;
  headerInfo?: string;
  fenceLength?: number;
  label?: string;
}

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

export function areEquivalentChunkLanguages(left: string, right: string): boolean {
  const normalizedLeft = left.trim().toLowerCase();
  const normalizedRight = right.trim().toLowerCase();
  return normalizedLeft === normalizedRight ||
    ([normalizedLeft, normalizedRight].every((language) => language === "python" || language === "py"));
}

export function canonicalizeChunkHeader(languageId: string, source: ChunkHeaderSource = {}): CanonicalChunkHeader {
  const language = languageId.trim();
  const fullHeaderMatch = source.header?.match(/^(\s*`{3,}\{\s*)([^\s,}]+)([^}]*\}\s*)$/);
  if (fullHeaderMatch) {
    const storedLanguage = fullHeaderMatch[2];
    const headerLanguage = areEquivalentChunkLanguages(storedLanguage, language) ? storedLanguage : language;
    const header = `${fullHeaderMatch[1]}${headerLanguage}${fullHeaderMatch[3]}`;
    const headerInfo = header.match(/`{3,}\{([^}]*)\}/)?.[1].trim() ?? headerLanguage;
    return { language, headerInfo, header };
  }

  const storedHeaderInfo = normalizeChunkHeaderInfo(source.headerInfo ?? "");
  const storedLanguage = extractChunkLanguage(storedHeaderInfo);
  if (storedLanguage) {
    const headerLanguage = areEquivalentChunkLanguages(storedLanguage, language) ? storedLanguage : language;
    const headerInfo = `${headerLanguage}${storedHeaderInfo.slice(storedLanguage.length)}`;
    return {
      language,
      headerInfo,
      header: buildChunkHeader(headerInfo, source.fenceLength)
    };
  }

  const headerInfo = source.label ? `${language} ${source.label}` : language;
  return {
    language,
    headerInfo,
    header: buildChunkHeader(headerInfo, source.fenceLength)
  };
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

  if (!areEquivalentChunkLanguages(language, expectedLanguage)) {
    return `Changing the chunk language is not supported yet. Keep \"${expectedLanguage}\".`;
  }

  return undefined;
}
