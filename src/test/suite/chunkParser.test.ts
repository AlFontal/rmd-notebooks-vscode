import { strict as assert } from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseExecutableChunks } from "../../../src/document/chunkParser";

describe("chunkParser", () => {
  it("parses a simple qmd chunk", () => {
    const source = readFixture("simple.qmd");
    const chunks = parseExecutableChunks("file:///simple.qmd", source);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].language, "r");
    assert.equal(chunks[0].body.trim(), "summary(cars)");
    assert.equal(chunks[0].startLine, 4);
  });

  it("parses a named rmd chunk and extracts the label", () => {
    const source = readFixture("simple.Rmd");
    const chunks = parseExecutableChunks("file:///simple.Rmd", source);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].language, "r");
    assert.equal(chunks[0].label, "my-chunk");
  });

  it("parses multiple chunks and ignores non executable fences", () => {
    const source = readFixture("multi-chunk.qmd");
    const chunks = parseExecutableChunks("file:///multi-chunk.qmd", source);
    assert.equal(chunks.length, 2);
    assert.deepEqual(
      chunks.map((chunk) => chunk.language),
      ["r", "python"]
    );
  });

  it("tolerates malformed fences without throwing", () => {
    const source = readFixture("malformed.Rmd");
    const chunks = parseExecutableChunks("file:///malformed.Rmd", source);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[1].isClosed, false);
  });
});

function readFixture(name: string): string {
  const fixturePath = path.resolve(__dirname, "../../../../test/fixtures", name);
  return fs.readFileSync(fixturePath, "utf8");
}
