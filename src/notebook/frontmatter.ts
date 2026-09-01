export interface ParsedFrontmatter {
  openingFence: "---";
  closingFence: "---" | "...";
  body: string;
  endLine: number;
}

export interface JupyterFrontmatterInfo {
  kernelName?: string;
  startLine: number;
  endLine: number;
}

export function parseFrontmatter(source: string): ParsedFrontmatter | undefined {
  const normalized = source.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines[0] !== "---") {
    return undefined;
  }

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line !== "---" && line !== "...") {
      continue;
    }

    return {
      openingFence: "---",
      closingFence: line,
      body: lines.slice(1, index).join("\n"),
      endLine: index
    };
  }

  return undefined;
}

export function parseJupyterFrontmatter(body: string): JupyterFrontmatterInfo | undefined {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^jupyter\s*:\s*(.*?)\s*$/i);
    if (!match) {
      continue;
    }
    const scalar = unquote(match[1]);
    const endLine = findYamlBlockEnd(lines, index);
    if (scalar) {
      return { kernelName: scalar, startLine: index, endLine };
    }
    for (let nested = index + 1; nested <= endLine; nested += 1) {
      const name = lines[nested].match(/^\s+name\s*:\s*(.*?)\s*$/i);
      if (name) {
        return { kernelName: unquote(name[1]), startLine: index, endLine };
      }
    }
    return { startLine: index, endLine };
  }
  return undefined;
}

export function updateJupyterFrontmatter(body: string, kernelName?: string): string {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const existing = parseJupyterFrontmatter(body);
  if (!existing) {
    if (!kernelName) {
      return body;
    }
    return [...lines, `jupyter: ${quoteYamlScalar(kernelName)}`].join("\n");
  }

  lines.splice(
    existing.startLine,
    existing.endLine - existing.startLine + 1,
    ...(kernelName ? [`jupyter: ${quoteYamlScalar(kernelName)}`] : [])
  );
  return lines.join("\n").replace(/^\n+|\n+$/g, "");
}

function findYamlBlockEnd(lines: readonly string[], startLine: number): number {
  let endLine = startLine;
  for (let index = startLine + 1; index < lines.length; index += 1) {
    if (lines[index].trim().length === 0 || /^\s+/.test(lines[index])) {
      endLine = index;
      continue;
    }
    break;
  }
  return endLine;
}

function unquote(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function quoteYamlScalar(value: string): string {
  return /^[A-Za-z0-9_.-]+$/.test(value) ? value : JSON.stringify(value);
}
