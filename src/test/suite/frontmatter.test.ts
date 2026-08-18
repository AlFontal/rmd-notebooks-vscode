import { strict as assert } from "node:assert";
import { describe, it } from "mocha";
import { parseFrontmatter } from "../../notebook/frontmatter";

describe("frontmatter", () => {
  it("parses frontmatter only at the start of a document", () => {
    assert.deepEqual(parseFrontmatter("---\ntitle: Example\n---\n\nBody"), {
      openingFence: "---",
      closingFence: "---",
      body: "title: Example",
      endLine: 2
    });
    assert.equal(parseFrontmatter("# Heading\n\n---\ntitle: Not frontmatter\n---"), undefined);
  });

  it("preserves an alternate YAML closing delimiter", () => {
    assert.deepEqual(parseFrontmatter("---\ntitle: Example\n...\n"), {
      openingFence: "---",
      closingFence: "...",
      body: "title: Example",
      endLine: 2
    });
  });

  it("does not treat an unclosed opening delimiter as frontmatter", () => {
    assert.equal(parseFrontmatter("---\ntitle: Example"), undefined);
  });
});
