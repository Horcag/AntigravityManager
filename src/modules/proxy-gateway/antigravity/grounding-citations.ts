import type { GroundingChunk, GroundingMetadata, GroundingSupport } from './types';

/**
 * Grounding rendering shared by every response surface.
 *
 * Google returns web-search grounding as three parallel structures on
 * `candidates[].groundingMetadata`: the queries it ran, the sources it read
 * (`groundingChunks`), and the mapping from answer spans to sources
 * (`groundingSupports`). Only the first two were ever rendered here, so an
 * answer arrived with a source list appended but nothing saying which sentence
 * came from which source. `applyGroundingCitations` supplies the missing half.
 */

/** Rendered when a chunk carries no title of its own. */
const UNTITLED_SOURCE = 'Web source';

/** Rendered when a chunk carries no URI of its own. */
const MISSING_SOURCE_URI = '#';

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

interface CitationInsertion {
  /** UTF-8 byte offset the marker is inserted at. */
  byteOffset: number;
  marker: string;
}

function collectCitationInsertions(
  supports: readonly GroundingSupport[],
  sourceCount: number,
): CitationInsertion[] {
  const insertions: CitationInsertion[] = [];

  for (const support of supports) {
    const byteOffset = support.segment?.endIndex;
    if (!isNonNegativeInteger(byteOffset)) {
      continue;
    }

    const marker = (support.groundingChunkIndices ?? [])
      .filter(
        (chunkIndex) =>
          isNonNegativeInteger(chunkIndex) && (!sourceCount || chunkIndex < sourceCount),
      )
      // Markers are 1-based and concatenated without a separator: `[1][3]`.
      .map((chunkIndex) => `[${chunkIndex + 1}]`)
      .join('');
    if (!marker) {
      continue;
    }

    insertions.push({ byteOffset, marker });
  }

  return insertions;
}

/**
 * Splices `[n]` citation markers into `text` at the spans `supports` describes.
 *
 * Two details decide whether this is correct or silently destructive:
 *
 * 1. `segment.endIndex` is a **UTF-8 byte offset**, not a UTF-16 code-unit
 *    index. Slicing the JavaScript string at those numbers lands mid-character
 *    on any non-ASCII answer — Cyrillic, CJK, emoji — and mangles it. The text
 *    is therefore encoded once and spliced in the byte domain.
 * 2. Insertions are applied from the end backwards, so an earlier insertion
 *    never shifts a later offset.
 *
 * Offsets past the end of the text are clamped rather than dropped, matching
 * the upstream client's behaviour when a segment overruns the response.
 */
export function applyGroundingCitations(
  text: string,
  supports: readonly GroundingSupport[] | undefined,
  sourceCount = 0,
): string {
  if (!text || !supports?.length) {
    return text;
  }

  const insertions = collectCitationInsertions(supports, sourceCount);
  if (insertions.length === 0) {
    return text;
  }

  // Descending, so each splice happens beyond every offset still to be applied.
  insertions.sort((left, right) => right.byteOffset - left.byteOffset);

  const encoder = new TextEncoder();
  const textBytes = encoder.encode(text);
  const segments: Uint8Array[] = [];
  let lastOffset = textBytes.length;

  for (const insertion of insertions) {
    const offset = Math.min(insertion.byteOffset, lastOffset);
    segments.unshift(textBytes.subarray(offset, lastOffset));
    segments.unshift(encoder.encode(insertion.marker));
    lastOffset = offset;
  }
  segments.unshift(textBytes.subarray(0, lastOffset));

  const totalLength = segments.reduce((sum, segment) => sum + segment.length, 0);
  const merged = new Uint8Array(totalLength);
  let writeOffset = 0;
  for (const segment of segments) {
    merged.set(segment, writeOffset);
    writeOffset += segment.length;
  }

  return new TextDecoder().decode(merged);
}

/** `[1] Title (uri)` lines, one per web chunk, in provider order. */
export function formatGroundingSourceList(
  chunks: readonly GroundingChunk[] | undefined | null,
): string[] {
  return (chunks ?? []).flatMap((chunk, index) => {
    if (!chunk?.web) {
      return [];
    }
    return [
      `[${index + 1}] ${chunk.web.title || UNTITLED_SOURCE} (${chunk.web.uri || MISSING_SOURCE_URI})`,
    ];
  });
}

/**
 * The trailing grounding block appended to a grounded answer.
 *
 * Kept byte-identical to what the three response mappers emitted separately
 * before they shared this helper, so existing clients see no change.
 */
export function renderGroundingMarkdown(
  webSearchQueries: readonly string[] | undefined | null,
  chunks: readonly GroundingChunk[] | undefined | null,
): string {
  let groundingText = '';

  if (webSearchQueries && webSearchQueries.length > 0) {
    groundingText += `\n\n---\n**🔍 Searched for you:** ${webSearchQueries.join(', ')}`;
  }

  const links = (chunks ?? []).flatMap((chunk, index) => {
    if (!chunk?.web) {
      return [];
    }
    const title = chunk.web.title || UNTITLED_SOURCE;
    const uri = chunk.web.uri || MISSING_SOURCE_URI;
    return [`[${index + 1}] [${title}](${uri})`];
  });

  if (links.length > 0) {
    groundingText += `\n\n**🌐 Citations:**\n` + links.join('\n');
  }

  return groundingText;
}

export interface GroundingAccumulator {
  webSearchQueries: string[];
  groundingChunks: GroundingChunk[];
  groundingSupports: GroundingSupport[];
}

export function createGroundingAccumulator(): GroundingAccumulator {
  return { webSearchQueries: [], groundingChunks: [], groundingSupports: [] };
}

/**
 * Merges one streamed frame's grounding into `accumulator`.
 *
 * Grounding rides on the ordinary generate call, so a streamed answer reports
 * it on whichever SSE frames happen to carry it. Queries are de-duplicated;
 * chunks and supports are appended, because `groundingChunkIndices` refer to
 * positions in the accumulated chunk list.
 */
export function accumulateGroundingMetadata(
  accumulator: GroundingAccumulator,
  grounding: GroundingMetadata | undefined | null,
): void {
  if (!grounding) {
    return;
  }

  for (const query of grounding.webSearchQueries ?? []) {
    if (query && !accumulator.webSearchQueries.includes(query)) {
      accumulator.webSearchQueries.push(query);
    }
  }

  for (const chunk of grounding.groundingChunks ?? []) {
    if (chunk) {
      accumulator.groundingChunks.push(chunk);
    }
  }

  for (const support of grounding.groundingSupports ?? []) {
    if (support) {
      accumulator.groundingSupports.push(support);
    }
  }
}
