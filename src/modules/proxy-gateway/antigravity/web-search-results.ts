import type { GroundingChunk, GroundingMetadata, GroundingSupport } from './types';

/**
 * The one protocol-agnostic reading of Google's web-search grounding.
 *
 * Three surfaces have to render the same upstream facts — Anthropic Messages,
 * OpenAI Chat Completions and OpenAI Responses — and each wants a different
 * wire shape. Parsing `groundingMetadata` once here, into a value that names
 * nothing protocol-specific, is what stops three parallel copies of the same
 * fragile offset arithmetic from drifting apart.
 *
 * The awkward part it hides: `groundingSupports[].segment` addresses the answer
 * in **UTF-8 bytes**, while every JavaScript consumer indexes in UTF-16 code
 * units. On an all-ASCII answer the two agree and a naive implementation looks
 * correct; on Cyrillic, CJK or emoji it silently points at the wrong characters.
 * {@link resolveWebSearchCitations} does the conversion in one place.
 */

/** A page the provider read, in the order it reported it. */
export interface WebSearchSource {
  url: string;
  title: string;
  /**
   * Absent for every source Google returns. Kept in the type because the
   * Anthropic surface has a field for it and omitting the key is honest,
   * whereas emitting a fabricated age would not be.
   */
  pageAge?: string;
}

/** A span of the answer the provider attributed to specific sources. */
export interface WebSearchByteSpan {
  /** UTF-8 byte offset the span starts at. */
  startByte: number;
  /** UTF-8 byte offset the span ends at. */
  endByte: number;
  /** Indexes into {@link WebSearchResultSet.sources}. */
  sourceIndexes: number[];
}

export interface WebSearchResultSet {
  /** Queries the provider actually ran, de-duplicated, in report order. */
  queries: string[];
  sources: WebSearchSource[];
  spans: WebSearchByteSpan[];
  /** How many searches the provider ran; one per reported query. */
  requestCount: number;
}

/** A citation resolved against a concrete answer string. */
export interface ResolvedWebSearchCitation {
  /** UTF-16 code-unit offset into the answer text. */
  startIndex: number;
  /** UTF-16 code-unit offset, exclusive. */
  endIndex: number;
  citedText: string;
  sources: WebSearchSource[];
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function collectSources(chunks: readonly GroundingChunk[] | undefined | null): {
  sources: WebSearchSource[];
  chunkIndexToSource: Map<number, number>;
} {
  const sources: WebSearchSource[] = [];
  const chunkIndexToSource = new Map<number, number>();

  (chunks ?? []).forEach((chunk, chunkIndex) => {
    const web = chunk?.web;
    if (!web) {
      return;
    }
    chunkIndexToSource.set(chunkIndex, sources.length);
    sources.push({ url: web.uri ?? '', title: web.title ?? '' });
  });

  return { sources, chunkIndexToSource };
}

function collectSpans(
  supports: readonly GroundingSupport[] | undefined | null,
  chunkIndexToSource: ReadonlyMap<number, number>,
): WebSearchByteSpan[] {
  const spans: WebSearchByteSpan[] = [];

  for (const support of supports ?? []) {
    const endByte = support?.segment?.endIndex;
    if (!isNonNegativeInteger(endByte)) {
      continue;
    }
    const startByte = isNonNegativeInteger(support.segment?.startIndex)
      ? support.segment.startIndex
      : 0;
    if (endByte <= startByte) {
      continue;
    }

    const sourceIndexes: number[] = [];
    for (const chunkIndex of support.groundingChunkIndices ?? []) {
      const sourceIndex = isNonNegativeInteger(chunkIndex)
        ? chunkIndexToSource.get(chunkIndex)
        : undefined;
      if (sourceIndex !== undefined && !sourceIndexes.includes(sourceIndex)) {
        sourceIndexes.push(sourceIndex);
      }
    }
    if (sourceIndexes.length === 0) {
      continue;
    }

    spans.push({ startByte, endByte, sourceIndexes });
  }

  spans.sort((left, right) => left.startByte - right.startByte || left.endByte - right.endByte);
  return spans;
}

/**
 * Reads one candidate's `groundingMetadata`, or null when it grounded nothing.
 *
 * Null rather than an empty result set, because "the model answered without
 * searching" and "the model searched and found nothing" are different answers
 * and only the caller knows which one its protocol should report.
 */
export function toWebSearchResultSet(
  grounding: GroundingMetadata | undefined | null,
): WebSearchResultSet | null {
  if (!grounding) {
    return null;
  }

  const queries: string[] = [];
  for (const query of grounding.webSearchQueries ?? []) {
    if (typeof query === 'string' && query.trim() && !queries.includes(query)) {
      queries.push(query);
    }
  }

  const { sources, chunkIndexToSource } = collectSources(grounding.groundingChunks);
  if (queries.length === 0 && sources.length === 0) {
    return null;
  }

  return {
    queries,
    sources,
    spans: collectSpans(grounding.groundingSupports, chunkIndexToSource),
    // A provider that returned sources without naming a query still ran one search.
    requestCount: Math.max(queries.length, 1),
  };
}

/** Merges the grounding of several streamed frames into one result set. */
export function mergeWebSearchResultSets(
  left: WebSearchResultSet | null,
  right: WebSearchResultSet | null,
): WebSearchResultSet | null {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }

  const queries = [...left.queries];
  for (const query of right.queries) {
    if (!queries.includes(query)) {
      queries.push(query);
    }
  }

  // Right's span indexes address right's own source list, so they shift by the
  // number of sources already accumulated on the left.
  const offset = left.sources.length;
  const spans = [
    ...left.spans,
    ...right.spans.map((span) => ({
      ...span,
      sourceIndexes: span.sourceIndexes.map((index) => index + offset),
    })),
  ];
  spans.sort((a, b) => a.startByte - b.startByte || a.endByte - b.endByte);

  return {
    queries,
    sources: [...left.sources, ...right.sources],
    spans,
    requestCount: Math.max(queries.length, 1),
  };
}

interface OffsetTable {
  /** Cumulative UTF-8 byte count at each character boundary. */
  byteBoundaries: number[];
  /** Cumulative UTF-16 code-unit count at the same boundaries. */
  unitBoundaries: number[];
}

function utf8Length(codePoint: number): number {
  if (codePoint < 0x80) {
    return 1;
  }
  if (codePoint < 0x800) {
    return 2;
  }
  if (codePoint < 0x10000) {
    return 3;
  }
  return 4;
}

function buildOffsetTable(text: string): OffsetTable {
  const byteBoundaries = [0];
  const unitBoundaries = [0];
  let byteCount = 0;
  let unitCount = 0;

  // Iterating the string yields whole code points, so a surrogate pair is never
  // split and its 4 UTF-8 bytes line up with its 2 UTF-16 units.
  for (const character of text) {
    byteCount += utf8Length(character.codePointAt(0) ?? 0);
    unitCount += character.length;
    byteBoundaries.push(byteCount);
    unitBoundaries.push(unitCount);
  }

  return { byteBoundaries, unitBoundaries };
}

/**
 * The UTF-16 index of the first character boundary at or after `byteOffset`.
 *
 * Rounding up rather than down matters: an offset that lands inside a
 * multi-byte character would otherwise resolve to a position that cuts the
 * character in half, and every consumer of this number slices a string with it.
 */
function toUnitOffset(table: OffsetTable, byteOffset: number): number {
  const { byteBoundaries, unitBoundaries } = table;
  const last = byteBoundaries.length - 1;
  if (byteOffset <= 0) {
    return 0;
  }
  if (byteOffset >= byteBoundaries[last]) {
    return unitBoundaries[last];
  }

  let low = 0;
  let high = last;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (byteBoundaries[middle] < byteOffset) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return unitBoundaries[low];
}

/**
 * Resolves the provider's byte spans against the answer string it grounded.
 *
 * `text` must be the exact string the offsets were computed against — the model
 * output before any marker, source list or trailing block is appended to it.
 */
export function resolveWebSearchCitations(
  text: string,
  resultSet: WebSearchResultSet | null,
): ResolvedWebSearchCitation[] {
  if (!text || !resultSet?.spans.length) {
    return [];
  }

  const table = buildOffsetTable(text);
  const citations: ResolvedWebSearchCitation[] = [];

  for (const span of resultSet.spans) {
    const startIndex = toUnitOffset(table, span.startByte);
    const endIndex = toUnitOffset(table, span.endByte);
    if (endIndex <= startIndex) {
      continue;
    }
    const sources = span.sourceIndexes
      .map((index) => resultSet.sources[index])
      .filter((source): source is WebSearchSource => Boolean(source));
    if (sources.length === 0) {
      continue;
    }
    citations.push({
      startIndex,
      endIndex,
      citedText: text.slice(startIndex, endIndex),
      sources,
    });
  }

  return citations;
}

/** The single query string a protocol with only one query slot can report. */
export function describeWebSearchQuery(resultSet: WebSearchResultSet): string {
  return resultSet.queries.join(', ');
}
