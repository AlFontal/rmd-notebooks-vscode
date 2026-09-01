import { strict as assert } from "node:assert";
import { describe, it } from "mocha";
import { parseFrontmatter, parseJupyterFrontmatter, updateJupyterFrontmatter } from "../../notebook/frontmatter";

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

  it("parses scalar and full kernelspec Jupyter metadata", () => {
    assert.equal(parseJupyterFrontmatter("title: Test\njupyter: python3")?.kernelName, "python3");
    assert.equal(
      parseJupyterFrontmatter("jupyter:\n  kernelspec:\n    name: project-python\n    language: python")?.kernelName,
      "project-python"
    );
  });

  it("updates or removes Jupyter metadata without changing other YAML", () => {
    const body = "title: Test\njupyter:\n  kernelspec:\n    name: old\n    language: python\nauthor: Ada";
    assert.equal(updateJupyterFrontmatter(body, "new-kernel"), "title: Test\njupyter: new-kernel\nauthor: Ada");
    assert.equal(updateJupyterFrontmatter(body), "title: Test\nauthor: Ada");
  });
});
