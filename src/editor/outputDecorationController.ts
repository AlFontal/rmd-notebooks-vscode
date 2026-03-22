import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { ChunkDocumentSnapshot, ChunkOutputRecord, ImageOutputItem } from "../document/chunkTypes";
import { formatInlinePreview, getResponsiveImageStyle, selectOutputAnchorLine } from "./outputPreview";

export class OutputDecorationController implements vscode.Disposable {
  private readonly summaryDecorationType = vscode.window.createTextEditorDecorationType({
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
  });
  private readonly imageDecorationType = vscode.window.createTextEditorDecorationType({
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
  });

  public render(editor: vscode.TextEditor, snapshot: ChunkDocumentSnapshot, outputs: Map<string, ChunkOutputRecord>): void {
    const summaryDecorations: vscode.DecorationOptions[] = [];
    const imageDecorations: vscode.DecorationOptions[] = [];
    const configuration = vscode.workspace.getConfiguration("rmdNotebooks");
    const maxPreviewCharacters = configuration.get<number>("output.maxPreviewCharacters", 160);
    const plotWidth = configuration.get<number>("output.plotWidth", 320);
    const plotHeight = configuration.get<number>("output.plotHeight", 220);
    const documentLines = getDocumentLines(editor.document);

    for (const chunk of snapshot.chunks) {
      const record = outputs.get(chunk.identity.chunkId);
      if (!record) {
        continue;
      }

      const anchorLine = selectOutputAnchorLine(documentLines, chunk.endLine);
      const anchor = this.createAnchorRange(editor.document, anchorLine);
      const previewText = formatInlinePreview(record, maxPreviewCharacters);

      if (previewText) {
        summaryDecorations.push({
          range: anchor,
          renderOptions: {
            after: {
              contentText: ` ${previewText}`,
              color: new vscode.ThemeColor(record.status === "error" ? "testing.iconErrored" : "editorCodeLens.foreground"),
              backgroundColor: new vscode.ThemeColor("textBlockQuote.background"),
              border: "1px solid",
              borderColor: new vscode.ThemeColor(record.stale ? "editorWarning.foreground" : "textBlockQuote.border"),
              margin: anchorLine === chunk.endLine ? "0 0 0 1.25em" : "0 0 0 0.25em",
              textDecoration: "none",
              fontStyle: "normal"
            }
          }
        });
      }

      const images = record.outputs
        .filter((output): output is ImageOutputItem => output.type === "image")
        .map((image) => hydrateImageDimensions(image));

      images.forEach((image, index) => {
        const style = getResponsiveImageStyle(image, plotWidth, plotHeight);
        imageDecorations.push({
          range: anchor,
          hoverMessage: path.basename(image.path),
          renderOptions: {
            after: {
              contentIconPath: vscode.Uri.file(image.path),
              width: style.width,
              height: style.height,
              margin: `${previewText ? 0.75 + index * 0.25 : 0.35 + index * 0.25}em 0 0 1.25em`,
              textDecoration: "none"
            }
          }
        });
      });
    }

    editor.setDecorations(this.summaryDecorationType, summaryDecorations);
    editor.setDecorations(this.imageDecorationType, imageDecorations);
  }

  public clear(editor: vscode.TextEditor): void {
    editor.setDecorations(this.summaryDecorationType, []);
    editor.setDecorations(this.imageDecorationType, []);
  }

  public dispose(): void {
    this.summaryDecorationType.dispose();
    this.imageDecorationType.dispose();
  }

  private createAnchorRange(document: vscode.TextDocument, lineNumber: number): vscode.Range {
    const safeLine = Math.min(Math.max(lineNumber, 0), Math.max(document.lineCount - 1, 0));
    const line = document.lineAt(safeLine);
    const anchor = new vscode.Position(safeLine, line.text.length);
    return new vscode.Range(anchor, anchor);
  }
}

function getDocumentLines(document: vscode.TextDocument): string[] {
  const lines: string[] = [];
  for (let index = 0; index < document.lineCount; index += 1) {
    lines.push(document.lineAt(index).text);
  }

  return lines;
}

function hydrateImageDimensions(image: ImageOutputItem): ImageOutputItem {
  if (image.width && image.height) {
    return image;
  }

  const detected = readPngDimensions(image.path);
  if (!detected) {
    return image;
  }

  return {
    ...image,
    width: detected.width,
    height: detected.height
  };
}

function readPngDimensions(filePath: string): { width: number; height: number } | undefined {
  try {
    const buffer = fs.readFileSync(filePath);
    if (buffer.length < 24 || buffer.toString("ascii", 1, 4) !== "PNG") {
      return undefined;
    }

    return {
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20)
    };
  } catch {
    return undefined;
  }
}
