import { strict as assert } from "node:assert";
import { applyChunkOptionsToResult, parseChunkOptions } from "../../../src/notebook/chunkOptions";

describe("chunkOptions", () => {
  it("parses common boolean options and results mode", () => {
    assert.deepEqual(
      parseChunkOptions("r demo, echo=FALSE, include=TRUE, results='hide', warning=FALSE, message=FALSE"),
      {
        echo: false,
        include: true,
        results: "hide",
        warning: false,
        message: false
      }
    );
  });

  it("ignores the label before parsing options", () => {
    assert.deepEqual(
      parseChunkOptions("r first-values, eval=FALSE"),
      {
        eval: false
      }
    );
  });

  it("returns an empty object when no options are present", () => {
    assert.deepEqual(parseChunkOptions("r"), {});
  });

  it("parses figure sizing options", () => {
    assert.deepEqual(
      parseChunkOptions("r demo, fig.width=8, fig.height=4.5, dpi=144, fig.asp=0.625"),
      {
        figWidth: 8,
        figHeight: 4.5,
        dpi: 144,
        figAsp: 0.625
      }
    );
  });

  it("suppresses all successful outputs when include=FALSE", () => {
    const result = applyChunkOptionsToResult(
      {
        success: true,
        startedAt: 1,
        finishedAt: 2,
        items: [
          { type: "text", text: "hello" },
          { type: "html", html: "<strong>hello</strong>" },
          { type: "image", path: "/tmp/plot.png", mimeType: "image/png" }
        ]
      },
      { include: false }
    );

    assert.deepEqual(result.items, []);
  });

  it("suppresses text and html for results='hide' but keeps plots", () => {
    const result = applyChunkOptionsToResult(
      {
        success: true,
        startedAt: 1,
        finishedAt: 2,
        items: [
          { type: "text", text: "hello" },
          { type: "html", html: "<strong>hello</strong>" },
          { type: "image", path: "/tmp/plot.png", mimeType: "image/png" }
        ]
      },
      { results: "hide" }
    );

    assert.deepEqual(result.items, [{ type: "image", path: "/tmp/plot.png", mimeType: "image/png" }]);
  });
});
