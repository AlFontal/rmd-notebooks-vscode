import { strict as assert } from "node:assert";
import { formatChunkHeaderBadge, formatChunkHeaderTooltip } from "../../../src/notebook/metadataDisplay";

describe("metadataDisplay", () => {
  it("formats the raw chunk header info as a badge", () => {
    assert.equal(
      formatChunkHeaderBadge({
        kind: "code",
        header: "```{r first, echo=FALSE}",
        headerInfo: "r first, echo=FALSE",
        language: "r",
        label: "first",
        fenceLength: 3,
        isClosed: true
      }),
      "{r first, echo=FALSE}"
    );
  });

  it("builds a tooltip with header, label, and language", () => {
    assert.equal(
      formatChunkHeaderTooltip({
        kind: "code",
        header: "```{r first, echo=FALSE}",
        headerInfo: "r first, echo=FALSE",
        language: "r",
        label: "first",
        fenceLength: 3,
        isClosed: true
      }),
      "Chunk header: ```{r first, echo=FALSE}\n\nLabel: `first`\n\nLanguage: `r`"
    );
  });
});
