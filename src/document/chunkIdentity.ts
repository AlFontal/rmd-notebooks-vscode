import { sha1 } from "../util/hash";
import { ChunkIdentitySeed, ExecutableChunk, ParsedExecutableChunk } from "./chunkTypes";

const POSITION_MATCH_WINDOW = 25;

interface ChunkIdentityWork {
  chunk: ParsedExecutableChunk;
  bodyHash: string;
  headerHash: string;
  contentHash: string;
  chunkId?: string;
}

export function assignChunkIdentities(
  documentUri: string,
  parsedChunks: ParsedExecutableChunk[],
  previousSeeds: ChunkIdentitySeed[] = []
): ExecutableChunk[] {
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

  const work: ChunkIdentityWork[] = parsedChunks.map((chunk) => {
    const bodyHash = sha1(normalizeBody(chunk.body));
    const headerHash = sha1(normalizeHeader(chunk.header));
    const contentHash = sha1(`${headerHash}:${bodyHash}`);
    return { chunk, bodyHash, headerHash, contentHash };
  });

  // Exact content matches are claimed across every chunk first, so a fuzzy
  // (label/position) match on one chunk can never steal a seed that another
  // chunk matches exactly.
  for (const entry of work) {
    const matched = takeExactMatch(exactCandidates, entry.contentHash, usedPreviousIds);
    if (matched) {
      entry.chunkId = matched.chunkId;
      usedPreviousIds.add(matched.chunkId);
    }
  }

  for (const entry of work) {
    if (entry.chunkId) {
      continue;
    }
    const matched = takeNearestMatch(
      labelCandidates.get(getLabelKey(entry.chunk.language, entry.chunk.label)),
      entry.chunk.startLine,
      usedPreviousIds
    );
    if (matched) {
      entry.chunkId = matched.chunkId;
      usedPreviousIds.add(matched.chunkId);
    }
  }

  for (const entry of work) {
    if (entry.chunkId) {
      continue;
    }
    const matched = takeNearestMatch(languageCandidates.get(entry.chunk.language), entry.chunk.startLine, usedPreviousIds);
    if (matched) {
      entry.chunkId = matched.chunkId;
      usedPreviousIds.add(matched.chunkId);
    }
  }

  for (const entry of work) {
    if (entry.chunkId) {
      continue;
    }
    entry.chunkId = generateUniqueChunkId(documentUri, entry, usedPreviousIds);
    usedPreviousIds.add(entry.chunkId);
  }

  return work.map((entry) => ({
    ...entry.chunk,
    identity: {
      chunkId: entry.chunkId as string,
      contentHash: entry.contentHash,
      headerHash: entry.headerHash,
      bodyHash: entry.bodyHash
    }
  }));
}

function generateUniqueChunkId(documentUri: string, entry: ChunkIdentityWork, usedPreviousIds: Set<string>): string {
  const base = `${documentUri}:${entry.chunk.language}:${entry.chunk.label ?? ""}:${entry.chunk.startLine}:${entry.headerHash}`;
  let chunkId = sha1(base);
  let salt = 0;
  // The base id is derived from the chunk position/header, so it can collide
  // with a previously generated id of the same shape. Salt until it is unique.
  while (usedPreviousIds.has(chunkId)) {
    salt += 1;
    chunkId = sha1(`${base}:${salt}`);
  }
  return chunkId;
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
