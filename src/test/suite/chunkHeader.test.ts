import { strict as assert } from "node:assert";
import { describe, it } from "mocha";
import {
  buildChunkHeader,
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

  it("validates language-preserving edits", () => {
    assert.equal(validateChunkHeaderInfo("r first, echo=FALSE", "r"), undefined);
    assert.match(validateChunkHeaderInfo("python first", "r") ?? "", /Changing the chunk language/);
  });
});
