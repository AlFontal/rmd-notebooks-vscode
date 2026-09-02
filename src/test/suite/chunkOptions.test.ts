import { strict as assert } from "node:assert";
import { applyChunkOptionsToResult, parseChunkOptions, parseQuartoCellOptions } from "../../../src/notebook/chunkOptions";

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

  it("parses leading Quarto cell options conservatively", () => {
    assert.deepEqual(
      parseQuartoCellOptions([
        "#| label: foo",
        "#| eval: false",
        "#| include: false",
        "#| output: false",
        "#| fig-width: 8",
        "#| fig-height: 5",
        "#| fig-asp: 0.5",
        "#| fig-dpi: 144",
        "print('ignored')"
      ].join("\n")),
      { label: "foo", eval: false, include: false, output: false, figWidth: 8, figHeight: 5, figAsp: 0.5, dpi: 144 }
    );
  });

  it("lets Quarto cell options override header options", () => {
    const merged = {
      ...parseChunkOptions("python, eval=TRUE, fig.width=3"),
      ...parseQuartoCellOptions("#| eval: false\n#| fig-width: 8\nprint('x')")
    };
    assert.equal(merged.eval, false);
    assert.equal(merged.figWidth, 8);
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
