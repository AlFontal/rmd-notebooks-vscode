import { ExecutionResult } from "../execution/executorTypes";

export interface ChunkOptions {
  eval?: boolean;
  echo?: boolean;
  include?: boolean;
  results?: string;
  warning?: boolean;
  message?: boolean;
  figWidth?: number;
  figHeight?: number;
  figAsp?: number;
  dpi?: number;
}

export function parseChunkOptions(headerInfo: string): ChunkOptions {
  const remainder = getOptionSegment(headerInfo);
  if (!remainder) {
    return {};
  }

  const options: ChunkOptions = {};
  for (const token of splitOptionTokens(remainder)) {
    const separatorIndex = token.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = token.slice(0, separatorIndex).trim().toLowerCase();
    const rawValue = token.slice(separatorIndex + 1).trim();
    if (!key || !rawValue) {
      continue;
    }

    if (key === "eval" || key === "echo" || key === "include" || key === "warning" || key === "message") {
      const booleanValue = parseBooleanOption(rawValue);
      if (booleanValue !== undefined) {
        options[key] = booleanValue;
      }
      continue;
    }

    if (key === "results") {
      options.results = stripOuterQuotes(rawValue).toLowerCase();
      continue;
    }

    if (key === "fig.width") {
      const numericValue = parseNumericOption(rawValue);
      if (numericValue !== undefined) {
        options.figWidth = numericValue;
      }
      continue;
    }

    if (key === "fig.height") {
      const numericValue = parseNumericOption(rawValue);
      if (numericValue !== undefined) {
        options.figHeight = numericValue;
      }
      continue;
    }

    if (key === "fig.asp") {
      const numericValue = parseNumericOption(rawValue);
      if (numericValue !== undefined) {
        options.figAsp = numericValue;
      }
      continue;
    }

    if (key === "dpi") {
      const numericValue = parseNumericOption(rawValue);
      if (numericValue !== undefined) {
        options.dpi = numericValue;
      }
    }
  }

  return options;
}

export function applyChunkOptionsToResult(result: ExecutionResult, options: ChunkOptions | undefined): ExecutionResult {
  if (!options) {
    return result;
  }

  const items = result.items.filter((item) => {
    if (result.success && options.include === false && item.type !== "error") {
      return false;
    }

    if (result.success && options.results === "hide" && (item.type === "text" || item.type === "html")) {
      return false;
    }

    return true;
  });

  return {
    ...result,
    items
  };
}

function getOptionSegment(headerInfo: string): string {
  const trimmed = headerInfo.trim();
  if (!trimmed) {
    return "";
  }

  const firstSeparator = trimmed.search(/[\s,]/);
  if (firstSeparator === -1) {
    return "";
  }

  const remainder = trimmed.slice(firstSeparator).trim();
  if (!remainder) {
    return "";
  }

  const labelCandidate = remainder.split(",")[0]?.trim() ?? "";
  if (labelCandidate && !labelCandidate.includes("=")) {
    return remainder.slice(labelCandidate.length).replace(/^,/, "").trim();
  }

  return remainder.replace(/^,/, "").trim();
}

function splitOptionTokens(value: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | "\"" | undefined;

  for (const character of value) {
    if ((character === "'" || character === "\"") && (!quote || quote === character)) {
      quote = quote === character ? undefined : character;
      current += character;
      continue;
    }

    if (character === "," && !quote) {
      if (current.trim().length > 0) {
        tokens.push(current.trim());
      }
      current = "";
      continue;
    }

    current += character;
  }

  if (current.trim().length > 0) {
    tokens.push(current.trim());
  }

  return tokens;
}

function parseBooleanOption(value: string): boolean | undefined {
  const normalized = stripOuterQuotes(value).trim().toLowerCase();
  if (normalized === "true" || normalized === "t") {
    return true;
  }

  if (normalized === "false" || normalized === "f") {
    return false;
  }

  return undefined;
}

function parseNumericOption(value: string): number | undefined {
  const normalized = stripOuterQuotes(value).trim();
  if (!normalized) {
    return undefined;
  }

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }

  return parsed;
}

function stripOuterQuotes(value: string): string {
  if (value.length >= 2 && ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }

  return value;
}
