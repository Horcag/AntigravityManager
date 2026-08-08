import { isNil, isString } from 'lodash-es';
import { asString, toRecord } from '../../../common/utils/json-record';
import { resolveImageUrl } from '../media/openai-inline-image-payload';
import type { OpenAIContentPart } from '../../../common/interfaces/request-interfaces';

/**
 * Flattens a Responses `input` value that is not an item array into one string.
 */
export function normalizeResponsesInput(input: unknown): string {
  if (isString(input)) {
    return input;
  }

  if (Array.isArray(input)) {
    return input
      .map((item) => {
        if (isString(item)) {
          return item;
        }
        const itemRecord = toRecord(item);
        const content = asString(itemRecord?.content);
        if (content) {
          return content;
        }
        return JSON.stringify(item);
      })
      .join('\n');
  }

  if (isNil(input)) {
    return '';
  }

  return JSON.stringify(input);
}

/**
 * Converts a Responses message's `content` into the Chat Completions shape.
 *
 * Text blocks collapse into one string; when the message also carries images or
 * files the result becomes a content-part array with the merged text first.
 */
export function normalizeResponsesMessageContent(content: unknown): string | OpenAIContentPart[] {
  if (isString(content)) {
    return content;
  }

  if (!Array.isArray(content)) {
    return normalizeResponsesInput(content);
  }

  const textParts: string[] = [];
  const imageParts: OpenAIContentPart[] = [];

  for (const item of content) {
    const block = toRecord(item);
    if (!block) {
      continue;
    }

    const blockType = asString(block.type);
    if (blockType === 'input_text' || blockType === 'text' || blockType === 'output_text') {
      const text = asString(block.text);
      if (text) {
        textParts.push(text);
      }
      continue;
    }

    if (blockType === 'input_file') {
      // `input_file` by file_id is resolved into inline base64 upstream of
      // this call, so only `file_data` can be carried onward.
      const fileData = asString(block.file_data);
      if (fileData) {
        imageParts.push({
          type: 'file',
          file: {
            file_data: fileData,
            ...(asString(block.filename) ? { filename: block.filename as string } : {}),
          },
        });
      }
      continue;
    }

    if (blockType === 'input_image' || blockType === 'image_url') {
      const imageUrl = resolveImageUrl(block);
      if (imageUrl) {
        imageParts.push({
          type: 'image_url',
          image_url: {
            url: imageUrl,
          },
        });
      }
    }
  }

  if (imageParts.length === 0) {
    return textParts.join('\n');
  }

  const merged: OpenAIContentPart[] = [];
  if (textParts.length > 0) {
    merged.push({
      type: 'text',
      text: textParts.join('\n'),
    });
  }
  merged.push(...imageParts);
  return merged;
}

/**
 * Recovers the tool arguments object for one Responses call item.
 *
 * `local_shell_call` and `web_search_call` carry their arguments in a typed
 * `action` field rather than the JSON `arguments` string the function calls use.
 */
export function resolveToolArguments(
  type: string,
  item: Record<string, unknown>,
): Record<string, unknown> {
  if (type === 'local_shell_call') {
    const action = toRecord(item.action);
    const exec = action ? toRecord(action.exec) : null;
    const command = asString(exec?.command);
    return {
      command: command ? [command] : [],
    };
  }

  if (type === 'web_search_call') {
    const action = toRecord(item.action);
    return {
      query: asString(action?.query) ?? '',
    };
  }

  const raw = item.arguments;
  if (isString(raw)) {
    try {
      const parsed = JSON.parse(raw);
      const parsedRecord = toRecord(parsed);
      if (parsedRecord) {
        return parsedRecord;
      }
      return {
        value: parsed,
      };
    } catch {
      return {
        raw,
      };
    }
  }

  const rawRecord = toRecord(raw);
  if (rawRecord) {
    return rawRecord;
  }

  return {};
}

export function normalizeResponsesOutput(output: unknown): string {
  if (isString(output)) {
    return output;
  }
  const outputRecord = toRecord(output);
  const content = asString(outputRecord?.content);
  if (content) {
    return content;
  }
  if (isNil(output)) {
    return '';
  }
  return JSON.stringify(output);
}
