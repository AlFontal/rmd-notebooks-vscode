import { strict as assert } from "node:assert";
import { describe, it } from "mocha";
import { buildInlineRExecutionCode, normalizeInlineRForKnitr, parseInlineRExpressions } from "../../notebook/inlineR";

describe("inlineR", () => {
  it("parses native knitr and Quarto R expressions", () => {
    const expressions = parseInlineRExpressions("A `r x + 1` and `{r} paste('hello', 'world')`.");
    assert.deepEqual(expressions.map(({ syntax, expression }) => ({ syntax, expression })), [
      { syntax: "knitr", expression: "x + 1" },
      { syntax: "quarto", expression: "paste('hello', 'world')" }
    ]);
  });

  it("ignores escaped, doubled-backtick, double-brace, and non-R spans", () => {
    const markdown = String.raw`\`r escaped\` and \`\`{r} doubled\`\` and \`{{r}} escaped\` and \`python value\``;
    assert.deepEqual(parseInlineRExpressions(markdown), []);
  });

  it("normalizes supported syntax for knitr without changing surrounding prose", () => {
    assert.equal(
      normalizeInlineRForKnitr("Value `{r} x` and `r y`."),
      "Value `r x` and `r y`."
    );
  });

  it("builds protocol-safe R code for multiline and quoted prose", () => {
    const code = buildInlineRExecutionCode("It's `r paste(\"hello\", \"world\")`.\nNext.");
    assert.match(code, /^local\(\{/);
    assert.ok(code.includes("knitr::knit"));
    assert.ok(!code.includes("It's"));
    assert.ok(code.includes("%0A"));
  });
});
