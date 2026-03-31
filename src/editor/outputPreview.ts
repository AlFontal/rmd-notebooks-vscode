import { ChunkOutputRecord, ImageOutputItem } from "../document/chunkTypes";

const DEFAULT_INLINE_PREVIEW_LIMIT = 140;
const IMAGE_VIEWPORT_WIDTH_VW = 34;

export function selectOutputAnchorLine(lines: readonly string[], endLine: number): number {
  const nextLine = endLine + 1;
  if (nextLine < lines.length && lines[nextLine].trim().length === 0) {
    return nextLine;
  }

  return endLine;
}

export function formatInlinePreview(record: ChunkOutputRecord, maxCharacters = DEFAULT_INLINE_PREVIEW_LIMIT): string {
  const segments: string[] = [];
  const stateLabel = getStateLabel(record);
  if (stateLabel) {
    segments.push(stateLabel);
  }

  for (const output of record.outputs) {
    if (output.type === "text") {
      const text = collapseWhitespace(output.text);
      if (text) {
        segments.push(text);
      }
      continue;
    }

    if (output.type === "error") {
      const text = collapseWhitespace(output.text);
      segments.push(text ? `[stderr] ${text}` : "[stderr]");
      continue;
    }
  }

  const imageCount = record.outputs.filter((output) => output.type === "image").length;
  if (imageCount > 0) {
    segments.push(imageCount === 1 ? "[plot]" : `[plots: ${imageCount}]`);
  }

  const preview = segments.join("  ").trim();
  if (!preview) {
    return "";
  }

  return preview.length > maxCharacters ? `${preview.slice(0, maxCharacters - 1).trimEnd()}…` : preview;
}

export function getResponsiveImageStyle(
  image: ImageOutputItem,
  configuredMaxWidth: number,
  configuredMaxHeight: number
): { width: string; height: string } {
  const intrinsicWidth = image.width ?? configuredMaxWidth;
  const intrinsicHeight = image.height ?? configuredMaxHeight;
  const fitted = fitWithinBox(intrinsicWidth, intrinsicHeight, configuredMaxWidth, configuredMaxHeight);
  const ratio = fitted.height / fitted.width;
  const heightVw = Number((IMAGE_VIEWPORT_WIDTH_VW * ratio).toFixed(3));

  return {
    width: `min(${Math.round(fitted.width)}px, ${IMAGE_VIEWPORT_WIDTH_VW}vw)`,
    height: `min(${Math.round(fitted.height)}px, ${heightVw}vw)`
  };
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function fitWithinBox(width: number, height: number, maxWidth: number, maxHeight: number): { width: number; height: number } {
  if (width <= maxWidth && height <= maxHeight) {
    return { width, height };
  }

  const widthScale = maxWidth / width;
  const heightScale = maxHeight / height;
  const scale = Math.min(widthScale, heightScale);

  return {
    width: width * scale,
    height: height * scale
  };
}

function getStateLabel(record: ChunkOutputRecord): string | undefined {
  if (record.status === "running") {
    return "[running]";
  }

  if (record.status === "redirected") {
    return "[redirected]";
  }

  if (record.stale) {
    return "[stale]";
  }

  if (record.status === "error") {
    return "[error]";
  }

  return undefined;
}
