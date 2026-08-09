export interface OpenAIResponsesReasoningOutputItem {
  content: Array<{
    text: string;
    type: 'reasoning_text';
  }>;
  id: string;
  status: 'completed' | 'incomplete';
  summary: Array<{
    text: string;
    type: 'summary_text';
  }>;
  type: 'reasoning';
}

interface ActiveReasoningOutput {
  item: OpenAIResponsesReasoningOutputItem;
  itemId: string;
  outputIndex: number;
  text: string;
}

interface OpenAIResponsesReasoningEventsDependencies {
  nextOutputIndex: () => number;
  createItemId: () => string;
  emitOutputItem: (item: OpenAIResponsesReasoningOutputItem) => void;
  serialize: (event: Record<string, unknown>) => string;
}

export interface ParsedReasoningChunk {
  text: string;
  isWrappedReasoning: boolean;
}

export function removeThinkingMarkers(rawText: string): string {
  return rawText
    .replaceAll('<think>\n', '')
    .replaceAll('<think>', '')
    .replaceAll('\n</think>', '')
    .replaceAll('</think>', '');
}

export function parsePotentialWrappedReasoning(rawText: string): ParsedReasoningChunk {
  const trimmed = rawText.trim();
  const isWrappedReasoning =
    trimmed.startsWith('<think>') && trimmed.endsWith('</think>') && trimmed.includes('</think>');
  return {
    isWrappedReasoning,
    text: isWrappedReasoning ? removeThinkingMarkers(rawText) : rawText,
  };
}

/**
 * Normalize thought text for direct reasoning emission.
 */
export function normalizeReasoningText(rawText: string): string {
  return removeThinkingMarkers(rawText);
}

/**
 * Emits OpenAI Responses reasoning output-item lifecycle events.
 *
 * This class owns reasoning start/delta/done and final item emission.
 * `OpenAIResponsesStreamingMapper` keeps outer stream ordering and final
 * completion semantics; this class is responsible only for reasoning events.
 */
export class OpenAIResponsesReasoningEventEmitter {
  private activeThought: ActiveReasoningOutput | null = null;

  constructor(private readonly deps: OpenAIResponsesReasoningEventsDependencies) {}

  public isActiveReasoning(): boolean {
    return this.activeThought !== null;
  }

  public closeThought(status: 'completed' | 'incomplete' = 'completed'): string[] {
    const thought = this.activeThought;
    if (!thought) {
      return [];
    }
    this.activeThought = null;

    thought.item.content = [{ text: thought.text, type: 'reasoning_text' }];
    thought.item.status = status;
    thought.item.summary =
      thought.text.length > 0 ? [{ text: thought.text, type: 'summary_text' }] : [];

    const events: string[] = [
      this.deps.serialize({
        content_index: 0,
        item_id: thought.itemId,
        output_index: thought.outputIndex,
        text: thought.text,
        type: 'response.reasoning_text.done',
      }),
    ];

    if (thought.item.summary.length > 0) {
      events.push(
        this.deps.serialize({
          content_index: 0,
          item_id: thought.itemId,
          output_index: thought.outputIndex,
          delta: thought.text,
          type: 'response.reasoning_summary_text.delta',
        }),
        this.deps.serialize({
          content_index: 0,
          item_id: thought.itemId,
          output_index: thought.outputIndex,
          text: thought.text,
          type: 'response.reasoning_summary_text.done',
        }),
      );
    }

    events.push(
      this.deps.serialize({
        item: thought.item,
        output_index: thought.outputIndex,
        type: 'response.output_item.done',
      }),
    );
    return events;
  }

  public processThought(rawText: string): string[] {
    const cleanText = normalizeReasoningText(rawText);
    if (!cleanText) {
      return [];
    }

    const events: string[] = [];

    if (!this.activeThought) {
      const outputIndex = this.deps.nextOutputIndex();
      const itemId = this.deps.createItemId();
      const item: OpenAIResponsesReasoningOutputItem = {
        content: [{ text: '', type: 'reasoning_text' }],
        id: itemId,
        status: 'completed',
        summary: [],
        type: 'reasoning',
      };
      this.activeThought = {
        item,
        itemId,
        outputIndex,
        text: '',
      };
      this.deps.emitOutputItem(item);
      events.push(
        this.deps.serialize({
          item: {
            content: [],
            id: itemId,
            status: 'in_progress',
            summary: [],
            type: 'reasoning',
          },
          output_index: outputIndex,
          type: 'response.output_item.added',
        }),
      );
    }

    // The opening chunk carries text like every other one. Emitting only the
    // item for it would drop the first slice of the chain, which is exactly
    // what the unary path does not do.
    const thought = this.activeThought;
    thought.text += cleanText;
    events.push(
      this.deps.serialize({
        content_index: 0,
        delta: cleanText,
        item_id: thought.itemId,
        output_index: thought.outputIndex,
        type: 'response.reasoning_text.delta',
      }),
    );
    return events;
  }
}
