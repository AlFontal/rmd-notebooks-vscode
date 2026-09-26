import { strict as assert } from "node:assert";
import {
  deriveCodeCellMetadata,
  parseNotebookSource,
  renderNotebookSource,
  SourceCell
} from "../../../src/notebook/notebookSourceFormat";
import { getInlineChunksMetadata, withInlineChunksMetadata } from "../../../src/notebook/notebookTypes";

function roundTrip(source: string): string {
  const parsed = parseNotebookSource(source);
  return renderNotebookSource(parsed.cells, parsed.layout);
}

const ROUND_TRIP_CASES: Record<string, string> = {
  "front matter, prose and chunks": "---\ntitle: x\n---\n\nIntro\n\n```{r}\n1\n```\n\nOutro\n",
  "chunk directly adjacent to prose": "Text\n```{r}\n1\n```\nMore\n",
  "several blank lines between blocks": "Intro\n\n\n\n```{r}\n1\n```\n\n\n```{python}\nprint(1)\n```\n",
  "whitespace-only separator lines": "Intro\n  \n\t\n```{r}\n1\n```\n",
  "no final newline": "Intro\n\n```{r}\n1\n```",
  "multiple final newlines": "Intro\n\n```{r}\n1\n```\n\n\n",
  "leading blank lines": "\n\nIntro\n\n```{r}\n1\n```\n",
  "CRLF line endings": "Text\r\n\r\n```{r}\r\n1\r\n```\r\n",
  "blank lines inside a chunk body": "```{r}\n\nx <- 1\n\ny <- 2\n\n```\n",
  "blank line inside front matter": "---\ntitle: x\n\nauthor: y\n---\n",
  "front matter closed with dots": "---\ntitle: x\n...\n\nBody\n",
  "longer chunk fences": "````{r}\n```\n````\n",
  "inline R prose": "Value is `r 1 + 1`.\n\n```{r}\nx\n```\n",
  "chunk nested in a 4-backtick fence": "Doc:\n\n````markdown\n```{r}\nx <- 1\n```\n````\n",
  "chunk nested in a tilde fence": "~~~\n```{r}\nx\n```\n~~~\n",
  "labelled header with a leading comma": "```{r, setup}\nlibrary(stats)\n```\n",
  "empty file": "",
  "whitespace-only file": "\n\n",
  "prose only": "# Title\n\nSome text.\n"
};

describe("notebookSourceFormat", () => {
  for (const [name, source] of Object.entries(ROUND_TRIP_CASES)) {
    it(`round-trips ${name} unchanged`, () => {
      const once = roundTrip(source);
      assert.equal(once, source);
      assert.equal(roundTrip(once), once);
    });
  }

  it("keeps markup cells free of surrounding blank lines", () => {
    const parsed = parseNotebookSource("---\ntitle: x\n---\n\n\nIntro\n\n\n```{r}\n1\n```\n");
    assert.deepEqual(
      parsed.cells.map((cell) => cell.value),
      ["title: x", "Intro", "1"]
    );
  });

  it("separates cells without recorded layout by one blank line and ends with a newline", () => {
    const cells: SourceCell[] = [
      { kind: "markup", value: "Intro", languageId: "markdown", metadata: {} },
      { kind: "code", value: "1", languageId: "r", metadata: {} },
      { kind: "markup", value: "\nOutro\n\n", languageId: "markdown", metadata: {} }
    ];
    assert.equal(renderNotebookSource(cells), "Intro\n\n```{r}\n1\n```\n\nOutro\n");
  });

  it("keeps the recorded spacing of existing cells around a newly inserted cell", () => {
    const parsed = parseNotebookSource("Intro\n```{r}\n1\n```\n");
    const cells = [
      parsed.cells[0],
      { kind: "markup" as const, value: "New", languageId: "markdown", metadata: {} },
      parsed.cells[1]
    ];
    assert.equal(renderNotebookSource(cells, parsed.layout), "Intro\n\nNew\n```{r}\n1\n```\n");
  });

  it("keeps CRLF line endings for edited cells", () => {
    const parsed = parseNotebookSource("Intro\r\n\r\n```{r}\r\n1\r\n```\r\n");
    parsed.cells[1] = { ...parsed.cells[1], value: "1\n2" };
    assert.equal(renderNotebookSource(parsed.cells, parsed.layout), "Intro\r\n\r\n```{r}\r\n1\r\n2\r\n```\r\n");
  });

  it("does not write a trailing newline typed at the end of a new code cell", () => {
    const cells: SourceCell[] = [{ kind: "code", value: "x <- 1\n", languageId: "r", metadata: {} }];
    assert.equal(renderNotebookSource(cells), "```{r}\nx <- 1\n```\n");
  });

  it("does not write extra trailing newlines typed at the end of a parsed code cell", () => {
    const parsed = parseNotebookSource("```{r}\nx <- 1\n\n```\n\n```{r}\ny\n```\n");
    parsed.cells[0] = { ...parsed.cells[0], value: `${parsed.cells[0].value}\n\n` };
    parsed.cells[1] = { ...parsed.cells[1], value: `${parsed.cells[1].value}\n` };
    assert.equal(renderNotebookSource(parsed.cells, parsed.layout), "```{r}\nx <- 1\n\n```\n\n```{r}\ny\n```\n");
  });

  it("persists deleting a blank line that preceded the closing fence", () => {
    const parsed = parseNotebookSource("---\ntitle: x\n\n---\n\n```{r}\nx <- 1\n\n```\n");
    parsed.cells[0] = { ...parsed.cells[0], value: "title: x" };
    parsed.cells[1] = { ...parsed.cells[1], value: "x <- 1" };
    assert.equal(renderNotebookSource(parsed.cells, parsed.layout), "---\ntitle: x\n---\n\n```{r}\nx <- 1\n```\n");
  });

  it("drops cells that were emptied", () => {
    const parsed = parseNotebookSource("Intro\n\n```{r}\n1\n```\n\nOutro\n");
    parsed.cells[0] = { ...parsed.cells[0], value: "  \n" };
    assert.equal(renderNotebookSource(parsed.cells, parsed.layout), "```{r}\n1\n```\n\nOutro\n");
  });

  it("stores the comma-separated label on deserialized code cells", () => {
    const parsed = parseNotebookSource("```{r, setup}\nlibrary(stats)\n```\n");
    const metadata = getInlineChunksMetadata(parsed.cells[0].metadata);
    assert.equal(metadata?.kind, "code");
    assert.equal(metadata?.kind === "code" ? metadata.label : undefined, "setup");
  });

  // The runtime re-derives chunk metadata for every code cell after a notebook
  // opens and applies an edit when it differs. Any difference marks the notebook
  // dirty on open, so deserialized metadata must already match that derivation.
  for (const header of [
    "r",
    "r, setup",
    "r setup",
    "r setup, include=FALSE",
    "R setup, echo=FALSE",
    "r, echo=FALSE",
    "python",
    "r fig, fig.width=5, fig.cap='A, B'"
  ]) {
    it(`needs no metadata rewrite after opening a {${header}} chunk`, () => {
      const parsed = parseNotebookSource(`\`\`\`{${header}}\n#| label: quarto-label\n1\n\`\`\`\n`);
      const [cell] = parsed.cells;
      const stored = getInlineChunksMetadata(cell.metadata);
      assert.equal(stored?.kind, "code");
      if (stored?.kind !== "code") {
        return;
      }
      const rederived = deriveCodeCellMetadata(cell.languageId, stored, cell.value, stored.fenceLength, stored.isClosed);
      assert.equal(JSON.stringify(rederived), JSON.stringify(stored));
    });
  }

  it("renders a header for code cells added without chunk metadata", () => {
    const cells: SourceCell[] = [
      { kind: "code", value: "x", languageId: "python", metadata: withInlineChunksMetadata(undefined, { kind: "markup" }) }
    ];
    assert.equal(renderNotebookSource(cells), "```{python}\nx\n```\n");
  });
});
