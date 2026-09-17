import { strict as assert } from "node:assert";
import { describe, it } from "mocha";
import {
  areEquivalentChunkLanguages,
  buildChunkHeader,
  canonicalizeChunkHeader,
  extractChunkLabel,
  extractChunkLanguage,
  normalizeChunkHeaderInfo,
  validateChunkHeaderInfo
} from "../../notebook/chunkHeader";

describe("chunkHeader", () => {
  it("normalizes raw header content from plain, braced, or fenced input", () => {
    assert.equal(normalizeChunkHeaderInfo("r first, echo=FALSE"), "r first, echo=FALSE");
    assert.equal(normalizeChunkHeaderInfo("{r first, echo=FALSE}"), "r first, echo=FALSE");
    assert.equal(normalizeChunkHeaderInfo("```{r first, echo=FALSE}"), "r first, echo=FALSE");
  });

  it("extracts the language and optional label", () => {
    assert.equal(extractChunkLanguage("r first, echo=FALSE"), "r");
    assert.equal(extractChunkLabel("r first, echo=FALSE"), "first");
    assert.equal(extractChunkLabel("r echo=FALSE"), undefined);
  });

  it("builds a fenced header line", () => {
    assert.equal(buildChunkHeader("r first, echo=FALSE"), "```{r first, echo=FALSE}");
  });

  it("replaces only the language token in a full stored header", () => {
    const original = '  ````{r analysis, fig.cap="Before, during, after", custom.option=some_function()}  ';
    assert.deepEqual(canonicalizeChunkHeader("python", { header: original, fenceLength: 4 }), {
      language: "python",
      headerInfo: 'python analysis, fig.cap="Before, during, after", custom.option=some_function()',
      header: '  ````{python analysis, fig.cap="Before, during, after", custom.option=some_function()}  '
    });
  });

  it("reconstructs malformed or missing headers from usable metadata", () => {
    assert.equal(
      canonicalizeChunkHeader("r", { header: "not a header", headerInfo: "python analysis, echo=FALSE" }).header,
      "```{r analysis, echo=FALSE}"
    );
    assert.equal(canonicalizeChunkHeader("r", { label: "analysis", fenceLength: 4 }).header, "````{r analysis}");
  });

  it("preserves the known python alias spelling", () => {
    assert.equal(areEquivalentChunkLanguages("python", "py"), true);
    assert.equal(areEquivalentChunkLanguages("r", "python"), false);
    assert.equal(canonicalizeChunkHeader("py", { header: "```{python analysis}" }).header, "```{python analysis}");
  });

  it("validates language-preserving edits", () => {
    assert.equal(validateChunkHeaderInfo("r first, echo=FALSE", "r"), undefined);
    assert.equal(validateChunkHeaderInfo("python first", "py"), undefined);
    assert.match(validateChunkHeaderInfo("python first", "r") ?? "", /Changing the chunk language/);
  });
});
