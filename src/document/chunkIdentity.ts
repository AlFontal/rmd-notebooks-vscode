import { sha1 } from "../util/hash";
import { ChunkIdentitySeed, ExecutableChunk, ParsedExecutableChunk } from "./chunkTypes";

const POSITION_MATCH_WINDOW = 25;

export function assignChunkIdentities(
  documentUri: string,
  parsedChunks: ParsedExecutableChunk[],
  previousSeeds: ChunkIdentitySeed[] = []
): ExecutableChunk[] {
  const previousPool = new Map(previousSeeds.map((seed) => [seed.chunkId, seed]));
  const usedPreviousIds = new Set<string>();

  const exactCandidates = new Map<string, ChunkIdentitySeed[]>();
  const labelCandidates = new Map<string, ChunkIdentitySeed[]>();
  const languageCandidates = new Map<string, ChunkIdentitySeed[]>();

  for (const seed of previousSeeds) {
    pushCandidate(exactCandidates, seed.contentHash, seed);
    if (seed.label) {
      pushCandidate(labelCandidates, getLabelKey(seed.language, seed.label), seed);
    }
    pushCandidate(languageCandidates, seed.language, seed);
  }

  return parsedChunks.map((chunk, index) => {
    const bodyHash = sha1(normalizeBody(chunk.body));
    const headerHash = sha1(normalizeHeader(chunk.header));
    const contentHash = sha1(`${headerHash}:${bodyHash}`);

    const matchedSeed =
      takeExactMatch(exactCandidates, contentHash, usedPreviousIds) ??
      takeNearestMatch(labelCandidates.get(getLabelKey(chunk.language, chunk.label)), chunk.startLine, usedPreviousIds) ??
      takeNearestMatch(languageCandidates.get(chunk.language), chunk.startLine, usedPreviousIds);

    const chunkId =
      matchedSeed?.chunkId ??
      sha1(`${documentUri}:${chunk.language}:${chunk.label ?? ""}:${chunk.startLine}:${headerHash}`);

    usedPreviousIds.add(chunkId);
    previousPool.delete(chunkId);

    return {
      ...chunk,
      identity: {
        chunkId,
        contentHash,
        headerHash,
        bodyHash
      }
    };
  });
}

export function createIdentitySeed(chunk: ExecutableChunk): ChunkIdentitySeed {
  return {
    chunkId: chunk.identity.chunkId,
    contentHash: chunk.identity.contentHash,
    headerHash: chunk.identity.headerHash,
    bodyHash: chunk.identity.bodyHash,
    language: chunk.language,
    label: chunk.label,
    startLine: chunk.startLine,
    header: chunk.header,
    body: chunk.body
  };
}

export function normalizeHeader(header: string): string {
  return header.trim();
}

export function normalizeBody(body: string): string {
  const normalized = body.replace(/\r\n/g, "\n");
  const trimmedRight = normalized
    .split("\n")
    .map((line) => line.replace(/\s+$/g, ""))
    .join("\n");

  return trimmedRight.replace(/\n+$/g, "");
}

function pushCandidate(map: Map<string, ChunkIdentitySeed[]>, key: string, seed: ChunkIdentitySeed): void {
  const current = map.get(key) ?? [];
  current.push(seed);
  map.set(key, current);
}

function takeExactMatch(
  candidatesByHash: Map<string, ChunkIdentitySeed[]>,
  contentHash: string,
  usedPreviousIds: Set<string>
): ChunkIdentitySeed | undefined {
  const candidates = candidatesByHash.get(contentHash);
  if (!candidates) {
    return undefined;
  }

  return candidates.find((candidate) => !usedPreviousIds.has(candidate.chunkId));
}

function takeNearestMatch(
  candidates: ChunkIdentitySeed[] | undefined,
  line: number,
  usedPreviousIds: Set<string>
): ChunkIdentitySeed | undefined {
  if (!candidates || candidates.length === 0) {
    return undefined;
  }

  const available = candidates
    .filter((candidate) => !usedPreviousIds.has(candidate.chunkId))
    .map((candidate) => ({
      candidate,
      distance: Math.abs(candidate.startLine - line)
    }))
    .filter((entry) => entry.distance <= POSITION_MATCH_WINDOW)
    .sort((left, right) => left.distance - right.distance);

  return available[0]?.candidate;
}

function getLabelKey(language: string, label?: string): string {
  return `${language}:${label ?? ""}`;
}
