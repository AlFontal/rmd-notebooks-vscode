export interface ParsedFrontmatter {
  openingFence: "---";
  closingFence: "---" | "...";
  body: string;
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
