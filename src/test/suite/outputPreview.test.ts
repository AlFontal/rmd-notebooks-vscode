import { strict as assert } from "node:assert";
import { ChunkOutputRecord } from "../../../src/document/chunkTypes";
import { formatInlinePreview, getResponsiveImageStyle, selectOutputAnchorLine } from "../../../src/editor/outputPreview";

describe("outputPreview", () => {
  it("prefers the blank line after a chunk as the output anchor", () => {
    const anchor = selectOutputAnchorLine(["```{r}", "x + 1", "```", "", "next"], 2);
    assert.equal(anchor, 3);
  });

  it("falls back to the closing fence line when no blank line exists", () => {
    const anchor = selectOutputAnchorLine(["```{r}", "x + 1", "```", "next"], 2);
    assert.equal(anchor, 2);
  });

  it("formats stdout into a single inline preview", () => {
    const preview = formatInlinePreview(createRecord([{ type: "text", text: "[1] 2\n[1] 3" }]));
    assert.equal(preview, "[1] 2 [1] 3");
  });

  it("adds state and stderr markers to the preview", () => {
    const preview = formatInlinePreview(
      createRecord([{ type: "error", text: "object 'y' not found" }], { status: "error", stale: true })
    );
    assert.equal(preview, "[stale]  [stderr] object 'y' not found");
  });

  it("returns responsive image sizes bounded by configured maxima", () => {
    const style = getResponsiveImageStyle(
      {
        type: "image",
        path: "/tmp/plot.png",
        mimeType: "image/png",
        width: 960,
        height: 720
      },
      320,
      220
    );

    assert.equal(style.width, "min(293px, 34vw)");
    assert.equal(style.height, "min(220px, 25.5vw)");
  });
});

function createRecord(
  outputs: ChunkOutputRecord["outputs"],
  overrides?: Partial<Pick<ChunkOutputRecord, "status" | "stale">>
): ChunkOutputRecord {
  return {
    documentUri: "file:///test.qmd",
    chunkId: "chunk-1",
    language: "r",
    header: "```{r}",
    contentHash: "content",
    headerHash: "header",
    bodyHash: "body",
    startLine: 0,
    capturedAt: Date.now(),
    stale: overrides?.stale ?? false,
    status: overrides?.status ?? "success",
    outputs
  };
}
