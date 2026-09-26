import { parseExecutableChunks } from "../document/chunkParser";
import { canonicalizeChunkHeader, ChunkHeaderSource, extractChunkLabel } from "./chunkHeader";
import { parseChunkOptions, parseQuartoCellOptions } from "./chunkOptions";
import { parseFrontmatter } from "./frontmatter";
import { parseInlineRExpressions } from "./inlineR";
import {
  getInlineChunksCellLayout,
  getInlineChunksMetadata,
  InlineChunksCellLayout,
  InlineChunksCellMetadata,
  InlineChunksCodeCellMetadata,
  InlineChunksDocumentLayout,
  withInlineChunksMetadata
} from "./notebookTypes";

// Plain-data mirror of vscode.NotebookCellData, so the source format can be
// round-trip tested without the extension host.
export interface SourceCell {
  kind: "markup" | "code";
  value: string;
  languageId: string;
  metadata: { [key: string]: any };
}

export interface ParsedNotebookSource {
  cells: SourceCell[];
  layout: InlineChunksDocumentLayout;
}

interface SourceBlock {
  startLine: number;
  endLine: number;
  cell: SourceCell;
}

const DEFAULT_GAP = [""];

export function parseNotebookSource(source: string): ParsedNotebookSource {
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const normalized = source.replace(/\r\n/g, "\n");
  const lines = normalized.length === 0 ? [] : normalized.split("\n");
  const blocks: SourceBlock[] = [];
  const frontmatter = parseFrontmatter(normalized);
  let cursor = 0;

  if (frontmatter) {
    blocks.push({
      startLine: 0,
      endLine: frontmatter.endLine,
      cell: {
        kind: "code",
        value: frontmatter.body,
        languageId: "yaml",
        metadata: withInlineChunksMetadata(undefined, {
          kind: "frontmatter",
          openingFence: frontmatter.openingFence,
          closingFence: frontmatter.closingFence
        })
      }
    });
    cursor = frontmatter.endLine + 1;
  }

  for (const chunk of parseExecutableChunks("", normalized)) {
    if (chunk.startLine < cursor) {
      continue;
    }
    pushProseBlock(blocks, lines, cursor, chunk.startLine);
    const endLine = chunk.isClosed ? chunk.endLine : lines.length - 1;
    blocks.push({
      startLine: chunk.startLine,
      endLine,
      cell: {
        kind: "code",
        value: chunk.body,
        languageId: chunk.language,
        metadata: withInlineChunksMetadata(
          undefined,
          deriveCodeCellMetadata(chunk.language, chunk, chunk.body, chunk.fenceLength, chunk.isClosed)
        )
      }
    });
    cursor = endLine + 1;
  }

  pushProseBlock(blocks, lines, cursor, lines.length);

  let previousEnd = -1;
  for (const [index, block] of blocks.entries()) {
    const layout: InlineChunksCellLayout = {};
    const gap = lines.slice(previousEnd + 1, block.startLine);
    if (!sameLines(gap, index === 0 ? [] : DEFAULT_GAP)) {
      layout.gapBefore = gap;
    }
    const trailingNewlines = countTrailingNewlines(block.cell.value);
    if (block.cell.kind === "code" && trailingNewlines > 0) {
      layout.trailingNewlines = trailingNewlines;
    }
    if (layout.gapBefore || layout.trailingNewlines) {
      block.cell.metadata = { ...block.cell.metadata, rmdNotebooksLayout: layout };
    }
    previousEnd = block.endLine;
  }

  const rest = lines.slice(previousEnd + 1);
  const trailing = rest.length === 0 ? "" : `${blocks.length > 0 ? "\n" : ""}${rest.join("\n")}`;
  const cells = blocks.map((block) => block.cell);
  if (cells.length === 0) {
    cells.push({ kind: "markup", value: "", languageId: "markdown", metadata: withInlineChunksMetadata(undefined, { kind: "markup" }) });
  }

  return { cells, layout: { eol, trailing } };
}

export function renderNotebookSource(cells: readonly SourceCell[], layout?: InlineChunksDocumentLayout): string {
  let text = "";
  let renderedBlocks = 0;

  for (const cell of cells) {
    const block = renderCell(cell);
    if (block === undefined) {
      continue;
    }

    const gap = getInlineChunksCellLayout(cell.metadata)?.gapBefore ?? (renderedBlocks === 0 ? [] : DEFAULT_GAP);
    const gapText = gap.map((line) => `${line}\n`).join("");
    text += renderedBlocks === 0 ? gapText : `\n${gapText}`;
    text += block;
    renderedBlocks += 1;
  }

  text += layout?.trailing ?? (renderedBlocks > 0 ? "\n" : "");
  return layout?.eol === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

// The single source of truth for a code cell's chunk metadata. Both deserialization
// and the runtime's metadata sync use it, so a freshly opened notebook never needs a
// metadata edit (which would mark it dirty).
export function deriveCodeCellMetadata(
  languageId: string,
  source: ChunkHeaderSource,
  body: string,
  fenceLength = 3,
  isClosed = true
): InlineChunksCodeCellMetadata {
  const canonical = canonicalizeChunkHeader(languageId, source);
  return {
    kind: "code",
    header: canonical.header,
    headerInfo: canonical.headerInfo,
    language: canonical.language,
    label: extractChunkLabel(canonical.headerInfo) ?? parseQuartoCellOptions(body).label,
    options: parseChunkOptions(canonical.headerInfo),
    fenceLength,
    isClosed
  };
}

function pushProseBlock(blocks: SourceBlock[], lines: readonly string[], start: number, end: number): void {
  let first = start;
  while (first < end && lines[first].trim().length === 0) {
    first += 1;
  }
  let last = end - 1;
  while (last >= first && lines[last].trim().length === 0) {
    last -= 1;
  }
  if (first > last) {
    return;
  }

  const value = lines.slice(first, last + 1).join("\n");
  const expressionCount = parseInlineRExpressions(value).length;
  const metadata: InlineChunksCellMetadata = expressionCount > 0 ? { kind: "inline", expressionCount } : { kind: "markup" };
  blocks.push({
    startLine: first,
    endLine: last,
    cell: {
      kind: expressionCount > 0 ? "code" : "markup",
      value,
      languageId: "markdown",
      metadata: withInlineChunksMetadata(undefined, metadata)
    }
  });
}

function renderCell(cell: SourceCell): string | undefined {
  const metadata = getInlineChunksMetadata(cell.metadata);
  const value = cell.value.replace(/\r\n/g, "\n");

  if (metadata?.kind === "inline" || cell.kind === "markup") {
    const markup = value.replace(/^\n+/, "").replace(/\n+$/, "");
    return markup.trim().length > 0 ? markup : undefined;
  }

  // Only trailing newlines that were in the source survive; ones typed at the end
  // of a cell in the notebook view would otherwise add blank lines before the fence.
  const recordedNewlines = getInlineChunksCellLayout(cell.metadata)?.trailingNewlines ?? 0;
  const body = value.replace(/\n+$/, "") + "\n".repeat(Math.min(countTrailingNewlines(value), recordedNewlines));

  if (metadata?.kind === "frontmatter") {
    return body.length > 0
      ? `${metadata.openingFence}\n${body}\n${metadata.closingFence}`
      : `${metadata.openingFence}\n${metadata.closingFence}`;
  }

  const codeMetadata = metadata?.kind === "code" ? metadata : undefined;
  const header = canonicalizeChunkHeader(cell.languageId, codeMetadata ?? {}).header;
  const closingFence = "`".repeat(Math.max(3, codeMetadata?.fenceLength ?? 3));
  return body.length > 0 ? `${header}\n${body}\n${closingFence}` : `${header}\n${closingFence}`;
}

function countTrailingNewlines(value: string): number {
  return value.length - value.replace(/\n+$/, "").length;
}

function sameLines(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((line, index) => line === right[index]);
}
