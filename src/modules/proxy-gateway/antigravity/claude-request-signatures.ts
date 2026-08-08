import type { SignatureKey, SignatureStore } from './SignatureStore';
import type { Message } from './types';

export interface RequestSignatureState {
  accountId: string;
  store: SignatureStore;
}

export type SignatureLookup = (toolCallId: string) => string | null;

export const NO_SIGNATURE_LOOKUP: SignatureLookup = () => null;

/**
 * Minimum length for a valid thought_signature
 */
const MIN_SIGNATURE_LENGTH = 10;

export function createSignatureLookup(
  state: RequestSignatureState | undefined,
  effectiveModel: string,
): SignatureLookup {
  const accountId = state?.accountId?.trim();
  const model = effectiveModel.trim();
  if (!state?.store || !accountId || !model) {
    return NO_SIGNATURE_LOOKUP;
  }

  return (toolCallId: string): string | null => {
    const key: SignatureKey = { accountId, model, toolCallId };
    return state.store.get(key);
  };
}

/**
 * Check if we have any valid signature available for function calls
 * @param messages  Messages from ClaudeRequest
 * @param lookupSignature  Exact account/model/tool-call lookup
 * @returns  True if any valid signature is available for function calls
 */
export function hasValidSignatureForFunctionCalls(
  messages: Message[],
  lookupSignature: SignatureLookup,
): boolean {
  // Traverse in reverse to prefer the most recent explicit or exact-keyed signature.
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'assistant') {
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (
            block.type === 'thinking' &&
            block.signature &&
            block.signature.length >= MIN_SIGNATURE_LENGTH
          ) {
            return true;
          }
          if (
            block.type === 'tool_use' &&
            ((block.signature && block.signature.length >= MIN_SIGNATURE_LENGTH) ||
              (block.id && (lookupSignature(block.id)?.length ?? 0) >= MIN_SIGNATURE_LENGTH))
          ) {
            return true;
          }
        }
      }
    }
  }
  return false;
}
