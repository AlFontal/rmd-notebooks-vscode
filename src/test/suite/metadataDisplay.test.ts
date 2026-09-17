import { strict as assert } from "node:assert";
import { formatChunkHeaderBadge, formatChunkHeaderTooltip } from "../../../src/notebook/metadataDisplay";

describe("metadataDisplay", () => {
  it("omits a redundant language-only badge", () => {
    assert.equal(
      formatChunkHeaderBadge({
        kind: "code",
        header: "```{python}",
        headerInfo: "python",
        language: "python",
        fenceLength: 3,
        isClosed: true
      }),
      undefined
    );
  });

  it("formats header and current body metadata without the language", () => {
    assert.equal(
      formatChunkHeaderBadge({
        kind: "code",
        header: "```{r first, echo=FALSE}",
        headerInfo: "r first, echo=FALSE",
        language: "r",
        label: "first",
        fenceLength: 3,
        isClosed: true
      }, "#| label: body-label\n#| include: false\n1 + 1"),
      "first, echo=FALSE | body-label | include=false"
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
      }, "#| warning: false\n1 + 1"),
      "Chunk header: ```{r first, echo=FALSE}\n\nLabel: `first`\n\nLanguage: `r`\n\nCell options: warning=false"
    );
  });
});
