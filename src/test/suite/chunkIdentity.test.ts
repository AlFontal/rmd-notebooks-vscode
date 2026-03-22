import { strict as assert } from "node:assert";
import { assignChunkIdentities } from "../../../src/document/chunkIdentity";
import { parseExecutableChunks } from "../../../src/document/chunkParser";

describe("chunkIdentity", () => {
  it("keeps the same chunk id when nearby prose changes", () => {
    const initial = assignChunkIdentities(
      "file:///doc.qmd",
      parseExecutableChunks("file:///doc.qmd", "Text\n\n```{r}\nsummary(cars)\n```\n")
    );
    const updated = assignChunkIdentities(
      "file:///doc.qmd",
      parseExecutableChunks("file:///doc.qmd", "Updated text\n\n```{r}\nsummary(cars)\n```\n"),
      initial.map((chunk) => ({
        chunkId: chunk.identity.chunkId,
        contentHash: chunk.identity.contentHash,
        headerHash: chunk.identity.headerHash,
        bodyHash: chunk.identity.bodyHash,
        language: chunk.language,
        label: chunk.label,
        startLine: chunk.startLine,
        header: chunk.header
      }))
    );

    assert.equal(updated[0].identity.chunkId, initial[0].identity.chunkId);
    assert.equal(updated[0].identity.contentHash, initial[0].identity.contentHash);
  });

  it("keeps the same chunk id and changes content hash when the body changes", () => {
    const initial = assignChunkIdentities(
      "file:///doc.qmd",
      parseExecutableChunks("file:///doc.qmd", "```{r}\nsummary(cars)\n```\n")
    );
    const updated = assignChunkIdentities(
      "file:///doc.qmd",
      parseExecutableChunks("file:///doc.qmd", "```{r}\nplot(cars)\n```\n"),
      initial.map((chunk) => ({
        chunkId: chunk.identity.chunkId,
        contentHash: chunk.identity.contentHash,
        headerHash: chunk.identity.headerHash,
        bodyHash: chunk.identity.bodyHash,
        language: chunk.language,
        label: chunk.label,
        startLine: chunk.startLine,
        header: chunk.header
      }))
    );

    assert.equal(updated[0].identity.chunkId, initial[0].identity.chunkId);
    assert.notEqual(updated[0].identity.contentHash, initial[0].identity.contentHash);
  });

  it("remaps moved labeled chunks by label and language", () => {
    const initial = assignChunkIdentities(
      "file:///doc.qmd",
      parseExecutableChunks(
        "file:///doc.qmd",
        ["```{r chunk-a}", "1 + 1", "```", "", "```{r chunk-b}", "2 + 2", "```"].join("\n")
      )
    );
    const updated = assignChunkIdentities(
      "file:///doc.qmd",
      parseExecutableChunks(
        "file:///doc.qmd",
        ["Intro", "", "```{r chunk-b}", "2 + 2", "```", "", "```{r chunk-a}", "1 + 1", "```"].join("\n")
      ),
      initial.map((chunk) => ({
        chunkId: chunk.identity.chunkId,
        contentHash: chunk.identity.contentHash,
        headerHash: chunk.identity.headerHash,
        bodyHash: chunk.identity.bodyHash,
        language: chunk.language,
        label: chunk.label,
        startLine: chunk.startLine,
        header: chunk.header
      }))
    );

    const byLabel = new Map(updated.map((chunk) => [chunk.label, chunk.identity.chunkId]));
    assert.equal(byLabel.get("chunk-a"), initial[0].identity.chunkId);
    assert.equal(byLabel.get("chunk-b"), initial[1].identity.chunkId);
  });
});
