import { v4 as uuidv4 } from 'uuid';

export const ANTHROPIC_MESSAGE_ID_PREFIX = 'msg_';

export function toAnthropicMessageId(responseId?: string | null): string {
  if (typeof responseId === 'string' && responseId.startsWith(ANTHROPIC_MESSAGE_ID_PREFIX)) {
    return responseId;
  }

  return `${ANTHROPIC_MESSAGE_ID_PREFIX}${responseId?.trim() || uuidv4()}`;
}
