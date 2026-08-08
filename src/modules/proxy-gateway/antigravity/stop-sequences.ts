/**
 * Anthropic stop-sequence semantics, owned by the proxy.
 *
 * The transport's finish-reason enum has no member for "a stop sequence fired",
 * and the provider removes the matched sequence from the text before returning
 * it. Between those two, a response that was cut short by a stop sequence is
 * indistinguishable from one that ended naturally, so `/v1/messages` could only
 * ever answer `stop_reason: "end_turn"` — the caller never learns that its own
 * sequence fired, which is exactly the signal clients branch on to decide
 * whether to continue a generation.
 *
 * So the Anthropic surface stops forwarding `stopSequences` upstream and cuts
 * the text here instead. The text the caller sees is identical (Anthropic also
 * excludes the matched sequence), and the match is now observable, so
 * `stop_reason` and `stop_sequence` can be reported truthfully. The cost is that
 * the model keeps generating past the cut, bounded by `max_tokens`, and only on
 * requests that actually use the feature.
 */

/** Anthropic caps `stop_sequences` at four entries; the contract layer rejects more. */
export function normalizeStopSequences(sequences?: readonly string[]): string[] {
  if (!sequences?.length) {
    return [];
  }
  // Longest first, so an overlapping pair reports the more specific match.
  return sequences.filter((sequence) => sequence.length > 0).sort((a, b) => b.length - a.length);
}

export interface StopSequenceCut {
  /** The text up to the match, with the matched sequence removed. */
  text: string;
  /** The sequence that fired, or null when none did. */
  sequence: string | null;
}

/**
 * Cuts a complete answer at the earliest stop sequence it contains.
 */
export function cutAtStopSequence(text: string, sequences: readonly string[]): StopSequenceCut {
  let cutAt = -1;
  let matched: string | null = null;

  for (const sequence of sequences) {
    const index = text.indexOf(sequence);
    if (index === -1) {
      continue;
    }
    if (cutAt === -1 || index < cutAt) {
      cutAt = index;
      matched = sequence;
    }
  }

  return matched === null
    ? { text, sequence: null }
    : { text: text.slice(0, cutAt), sequence: matched };
}

/**
 * The streaming counterpart.
 *
 * A stop sequence can straddle two upstream frames, so the tail of every chunk
 * that could still grow into one is withheld until the next chunk proves it
 * cannot. Once a sequence fires, everything after it is discarded.
 */
export class StopSequenceScanner {
  private readonly sequences: string[];
  private readonly longest: number;
  /** Text held back because it may yet turn out to be the head of a sequence. */
  private withheld = '';
  private matched: string | null = null;

  constructor(sequences: readonly string[]) {
    this.sequences = normalizeStopSequences(sequences);
    this.longest = this.sequences.reduce((max, sequence) => Math.max(max, sequence.length), 0);
  }

  /** True once no further text may be emitted. */
  public get stopped(): boolean {
    return this.matched !== null;
  }

  /** The sequence that fired, or null. */
  public get sequence(): string | null {
    return this.matched;
  }

  /** Feeds a chunk and returns the text that is now safe to emit. */
  public push(chunk: string): string {
    if (this.sequences.length === 0) {
      return chunk;
    }
    if (this.matched !== null) {
      return '';
    }

    const pending = this.withheld + chunk;
    const cut = cutAtStopSequence(pending, this.sequences);
    if (cut.sequence !== null) {
      this.matched = cut.sequence;
      this.withheld = '';
      return cut.text;
    }

    const holdBack = this.suffixThatMayGrow(pending);
    this.withheld = pending.slice(pending.length - holdBack);
    return pending.slice(0, pending.length - holdBack);
  }

  /** Releases the withheld tail once the upstream stream is complete. */
  public flush(): string {
    if (this.matched !== null) {
      return '';
    }
    const remainder = this.withheld;
    this.withheld = '';
    return remainder;
  }

  /**
   * Length of the longest suffix of `pending` that is a proper prefix of some
   * stop sequence — the only part of the text that could still complete one.
   */
  private suffixThatMayGrow(pending: string): number {
    const maxHold = Math.min(this.longest - 1, pending.length);
    for (let length = maxHold; length > 0; length--) {
      const suffix = pending.slice(pending.length - length);
      if (this.sequences.some((sequence) => sequence.startsWith(suffix))) {
        return length;
      }
    }
    return 0;
  }
}
