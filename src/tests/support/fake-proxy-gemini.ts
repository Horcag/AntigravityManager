/**
 * Gemini surface of the fake proxy.
 *
 * `promptTokenCount` is computed from the prompt *and* the systemInstruction,
 * which is what makes the "was the parameter actually forwarded" check
 * meaningful: a server that dropped the instruction would report the same
 * count twice.
 */

import {
  TRUNCATION_THRESHOLD,
  countTokens,
  isKnownModel,
  jsonReply,
  resolveAnswer,
  sseData,
  sseReply,
  type FakeProxyReply,
  type FakeProxyRequest,
  type SseFrame,
  FAKE_PROXY_MODELS,
  WEATHER_TOOL_ARGUMENTS,
  WEATHER_TOOL_ARGUMENTS_INVALID,
} from './fake-proxy-shared';

interface GenerateBody {
  contents?: { role?: string; parts?: { text?: string }[] }[];
  systemInstruction?: { parts?: { text?: string }[] };
  generationConfig?: {
    maxOutputTokens?: number;
    stopSequences?: string[];
    responseMimeType?: string;
  };
  tools?: { functionDeclarations?: { name?: string }[] }[];
  toolConfig?: { functionCallingConfig?: { mode?: string } };
}

const MODEL_VERSION = 'fake-conformance-001';

const MODEL_ACTION_PATTERN = /^\/v1beta\/models\/(?<model>[^:/]+):(?<action>[A-Za-z]+)$/u;

function promptOf(body: GenerateBody): string {
  return (body.contents ?? [])
    .flatMap((content) => content.parts ?? [])
    .map((part) => part.text ?? '')
    .join(' ');
}

function systemInstructionOf(body: GenerateBody): string {
  return (body.systemInstruction?.parts ?? []).map((part) => part.text ?? '').join(' ');
}

function usageMetadata(promptText: string, answerText: string) {
  const promptTokenCount = countTokens(promptText);
  const candidatesTokenCount = countTokens(answerText);
  return {
    promptTokenCount,
    candidatesTokenCount,
    totalTokenCount: promptTokenCount + candidatesTokenCount,
  };
}

function notFound(model: string): FakeProxyReply {
  return jsonReply(404, {
    error: {
      code: 404,
      message: `models/${model} is not found`,
      status: 'NOT_FOUND',
    },
  });
}

export function handleGemini(request: FakeProxyRequest): FakeProxyReply | undefined {
  if (request.method === 'GET' && request.path === '/v1beta/models') {
    return jsonReply(200, {
      models: FAKE_PROXY_MODELS.map((id) => ({
        name: `models/${id}`,
        displayName: id,
        supportedGenerationMethods: ['generateContent', 'streamGenerateContent', 'countTokens'],
      })),
    });
  }

  const match = request.method === 'POST' ? MODEL_ACTION_PATTERN.exec(request.path) : null;
  if (!match?.groups) {
    return undefined;
  }

  const { model, action } = match.groups;
  if (!isKnownModel(model)) {
    return notFound(model);
  }

  const body = request.body as GenerateBody;
  const prompt = promptOf(body);

  if (action === 'countTokens') {
    return jsonReply(200, { totalTokens: countTokens(prompt) });
  }

  if (action !== 'generateContent' && action !== 'streamGenerateContent') {
    return undefined;
  }

  const promptWithSystem = [systemInstructionOf(body), prompt].filter(Boolean).join(' ');
  const wantsJson = body.generationConfig?.responseMimeType === 'application/json';
  const truncated =
    (body.generationConfig?.maxOutputTokens ?? Number.MAX_SAFE_INTEGER) <= TRUNCATION_THRESHOLD;
  const { text } = resolveAnswer(prompt, {
    json: wantsJson,
    stopSequences: body.generationConfig?.stopSequences,
    truncated,
  });

  if (body.toolConfig?.functionCallingConfig?.mode === 'ANY') {
    return jsonReply(200, {
      candidates: [
        {
          index: 0,
          content: {
            role: 'model',
            parts: [
              {
                functionCall: {
                  name: body.tools?.[0]?.functionDeclarations?.[0]?.name ?? 'get_weather',
                  args: request.defects.has('gemini-tool-args-violate-schema')
                    ? WEATHER_TOOL_ARGUMENTS_INVALID
                    : WEATHER_TOOL_ARGUMENTS,
                },
              },
            ],
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: usageMetadata(promptWithSystem, 'function call'),
      modelVersion: MODEL_VERSION,
    });
  }

  const finishReason =
    truncated && !request.defects.has('gemini-max-tokens-as-stop') ? 'MAX_TOKENS' : 'STOP';

  if (action === 'streamGenerateContent') {
    return streamGenerateContent(text, finishReason, promptWithSystem);
  }

  return jsonReply(200, {
    candidates: [
      {
        index: 0,
        content: { role: 'model', parts: [{ text }] },
        finishReason,
      },
    ],
    usageMetadata: usageMetadata(promptWithSystem, text),
    modelVersion: MODEL_VERSION,
  });
}

function streamGenerateContent(
  text: string,
  finishReason: string,
  promptWithSystem: string,
): FakeProxyReply {
  const pieces = text.match(/\S+\s*/gu) ?? [text];
  const frames: SseFrame[] = pieces.slice(0, -1).map((piece) =>
    sseData({
      candidates: [{ index: 0, content: { role: 'model', parts: [{ text: piece }] } }],
      modelVersion: MODEL_VERSION,
    }),
  );

  frames.push(
    sseData({
      candidates: [
        {
          index: 0,
          content: { role: 'model', parts: [{ text: pieces.at(-1) ?? '' }] },
          finishReason,
        },
      ],
      usageMetadata: usageMetadata(promptWithSystem, text),
      modelVersion: MODEL_VERSION,
    }),
  );

  return sseReply(frames);
}
