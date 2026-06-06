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

  it("does not let an empty chunk steal a neighbour's output after a reload", () => {
    const source = ["```{r}", "print('output 1.1')", "```", "", "```{r}", "```", "", "```{r}", "print('output 1.2')", "```"].join("\n");
    const initial = assignChunkIdentities("file:///doc.Rmd", parseExecutableChunks("file:///doc.Rmd", source));

    // Only the two chunks that produced output get persisted; the empty chunk
    // was never run, so it has no seed.
    const seeds = [initial[0], initial[2]].map((chunk) => ({
      chunkId: chunk.identity.chunkId,
      contentHash: chunk.identity.contentHash,
      headerHash: chunk.identity.headerHash,
      bodyHash: chunk.identity.bodyHash,
      language: chunk.language,
      label: chunk.label,
      startLine: chunk.startLine,
      header: chunk.header
    }));

    const reloaded = assignChunkIdentities("file:///doc.Rmd", parseExecutableChunks("file:///doc.Rmd", source), seeds);

    assert.equal(reloaded[0].identity.chunkId, initial[0].identity.chunkId);
    assert.equal(reloaded[2].identity.chunkId, initial[2].identity.chunkId);
    // The empty middle chunk must not inherit either neighbour's id.
    assert.notEqual(reloaded[1].identity.chunkId, initial[0].identity.chunkId);
    assert.notEqual(reloaded[1].identity.chunkId, initial[2].identity.chunkId);
    // Every chunk keeps a distinct id, so no output is restored twice.
    const ids = new Set(reloaded.map((chunk) => chunk.identity.chunkId));
    assert.equal(ids.size, reloaded.length);
  });
});
