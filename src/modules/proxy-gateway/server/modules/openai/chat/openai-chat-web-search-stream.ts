import {
  buildOpenAIUrlCitationAnnotations,
  type OpenAIUrlCitationAnnotation,
} from '../../../../antigravity/openai-web-search';
import {
  mergeWebSearchResultSets,
  toWebSearchResultSet,
  type WebSearchResultSet,
} from '../../../../antigravity/web-search-results';
import type { GroundingMetadata } from '../../../../antigravity/types';

/**
 * The bookkeeping a streamed Chat Completion needs to cite its sources.
 *
 * Citations cannot be streamed as they are produced. The upstream reports
 * grounding on late frames, and every offset in it addresses the finished
 * answer, so the only correct moment to resolve them is when a choice finishes
 * — which means the answer text has to be accumulated alongside the deltas that
 * already went out. Per choice, because `n>1` grounds each candidate on its own.
 */
export class OpenAIChatWebSearchStream {
  private readonly textByChoice = new Map<number, string>();
  private readonly groundingByChoice = new Map<number, WebSearchResultSet | null>();

  constructor(private readonly enabled: boolean) {}

  public captureGrounding(choiceIndex: number, grounding: unknown): void {
    if (!this.enabled) {
      return;
    }
    this.groundingByChoice.set(
      choiceIndex,
      mergeWebSearchResultSets(
        this.groundingByChoice.get(choiceIndex) ?? null,
        toWebSearchResultSet(grounding as GroundingMetadata | undefined),
      ),
    );
  }

  public appendText(choiceIndex: number, text: string): void {
    if (!this.enabled) {
      return;
    }
    this.textByChoice.set(choiceIndex, (this.textByChoice.get(choiceIndex) ?? '') + text);
  }

  /** Annotations for a finished choice; empty when it was never grounded. */
  public buildAnnotations(choiceIndex: number): OpenAIUrlCitationAnnotation[] {
    if (!this.enabled) {
      return [];
    }
    return buildOpenAIUrlCitationAnnotations(
      this.textByChoice.get(choiceIndex) ?? '',
      this.groundingByChoice.get(choiceIndex) ?? null,
    );
  }
}
