/**
 * Kanban #58 unwrapped the `json_object` fence everywhere except the
 * `/v1/responses` event stream, so one request answered differently depending
 * on `stream: true`. These tests pin the streaming surface: the same proof
 * obligation, a `sequence_number` that stays monotonic and gapless, and a
 * byte-identical stream for every request that did not ask for `json_object`.
 */
import { describe, expect, it } from 'vitest';
import { lastValueFrom, Observable, of, toArray } from 'rxjs';

import { ProxyController } from '@/modules/proxy-gateway/server/proxy.controller';
import { OpenAIResponsesStreamingMapper } from '@/modules/proxy-gateway/antigravity/OpenAIResponsesStreamingMapper';
import { applyOpenAIJsonObjectFence } from '@/modules/proxy-gateway/server/modules/openai/chat/openai-json-object-fence';
import type { OpenAIChatRequest } from '@/modules/proxy-gateway/server/common/interfaces/request-interfaces';

const JSON_OBJECT_REQUEST: OpenAIChatRequest = {
  model: 'gemini-3-flash',
  messages: [{ role: 'user', content: 'return json' }],
  response_format: { type: 'json_object' },
};

const PLAIN_REQUEST: OpenAIChatRequest = {
  model: 'gemini-3-flash',
  messages: [{ role: 'user', content: 'return json' }],
};

interface FixtureOptions {
  finishReason?: string;
  toolCall?: { args: Record<string, unknown>; name: string };
}

/**
 * A real Responses event stream, produced by the shipping mapper rather than
 * hand-written, so the fixture cannot drift away from the protocol under test.
 */
function responsesFixture(textChunks: string[], options: FixtureOptions = {}): string[] {
  const mapper = new OpenAIResponsesStreamingMapper({
    model: 'gemini-3-flash',
    responseId: 'resp_fixture',
  });
  const frames = [mapper.createResponseCreatedEvent(), mapper.createResponseInProgressEvent()];
  for (const chunk of textChunks) {
    frames.push(...mapper.processPart({ text: chunk }));
  }
  if (options.toolCall) {
    frames.push(
      ...mapper.processPart({
        functionCall: { args: options.toolCall.args, id: 'call_1', name: options.toolCall.name },
      }),
    );
  }
  frames.push(...mapper.complete(options.finishReason ?? 'STOP'));
  return frames;
}

function runResponsesStream(request: OpenAIChatRequest, frames: string[]): Promise<string[]> {
  const result = applyOpenAIJsonObjectFence(request, of(...frames), 'responses');
  return lastValueFrom((result as Observable<string>).pipe(toArray()));
}

function parseEvent(frame: string): Record<string, unknown> {
  const dataAt = frame.indexOf('\ndata: ');
  if (dataAt < 0) {
    throw new Error(`Not a Responses event frame: ${frame}`);
  }
  return JSON.parse(frame.slice(dataAt + '\ndata: '.length).trim()) as Record<string, unknown>;
}

function eventTypes(frames: string[]): string[] {
  return frames.map((frame) => String(parseEvent(frame).type));
}

function sequenceNumbers(frames: string[]): number[] {
  return frames.map((frame) => Number(parseEvent(frame).sequence_number));
}

function deltaText(frames: string[]): string {
  return frames
    .map(parseEvent)
    .filter((event) => event.type === 'response.output_text.delta')
    .map((event) => String(event.delta))
    .join('');
}

function findEvent(frames: string[], type: string): Record<string, unknown> {
  const found = frames.map(parseEvent).find((event) => event.type === type);
  if (!found) {
    throw new Error(`No ${type} event in the stream`);
  }
  return found;
}

/** The text a client sees on the terminal payload, per message output item. */
function completedMessageTexts(frames: string[]): string[] {
  const completed = findEvent(frames, 'response.completed');
  const response = completed.response as { output: Record<string, unknown>[] };
  return response.output
    .filter((item) => item.type === 'message')
    .flatMap((item) => (item.content as { text: string; type: string }[]) ?? [])
    .filter((part) => part.type === 'output_text')
    .map((part) => part.text);
}

describe('/v1/responses json_object fence', () => {
  it('assembles a fenced answer into parseable JSON across every event', async () => {
    const fixture = responsesFixture(['```js', 'on\n{"answer"', ': 42}\n', '```']);
    const frames = await runResponsesStream(JSON_OBJECT_REQUEST, fixture);

    const assembled = deltaText(frames);
    expect(JSON.parse(assembled)).toEqual({ answer: 42 });
    expect(findEvent(frames, 'response.output_text.done').text).toBe(assembled);
    expect((findEvent(frames, 'response.content_part.done').part as { text: string }).text).toBe(
      assembled,
    );
    const doneItem = findEvent(frames, 'response.output_item.done').item as {
      content: { text: string }[];
    };
    expect(doneItem.content[0].text).toBe(assembled);
    expect(completedMessageTexts(frames)).toEqual([assembled]);
  });

  it('keeps sequence_number monotonic and gapless once deltas are withheld', async () => {
    const fixture = responsesFixture(['```js', 'on\n{"answer"', ': 42}\n', '```']);
    const frames = await runResponsesStream(JSON_OBJECT_REQUEST, fixture);

    // Three of the four deltas are withheld and one flush delta is added, so
    // the mapper's own numbering cannot survive; the emitted one still must.
    expect(frames.length).toBeLessThan(fixture.length);
    expect(sequenceNumbers(frames)).toEqual(frames.map((_frame, index) => index));
  });

  it('leaves the event protocol otherwise untouched', async () => {
    const fixture = responsesFixture(['```js', 'on\n{"answer"', ': 42}\n', '```']);
    const frames = await runResponsesStream(JSON_OBJECT_REQUEST, fixture);
    const withoutDeltas = (types: string[]): string[] =>
      types.filter((type) => type !== 'response.output_text.delta');

    expect(withoutDeltas(eventTypes(frames))).toEqual(withoutDeltas(eventTypes(fixture)));
    expect(eventTypes(frames)).toContain('response.output_text.delta');
  });

  it('streams byte-identically when the request did not ask for json_object', async () => {
    const fixture = responsesFixture(['```js', 'on\n{"answer"', ': 42}\n', '```']);
    const source = of(...fixture);

    expect(applyOpenAIJsonObjectFence(PLAIN_REQUEST, source, 'responses')).toBe(source);
    expect(await runResponsesStream(PLAIN_REQUEST, fixture)).toEqual(fixture);
  });

  it('streams byte-identically when json_object was asked for but nothing is fenced', async () => {
    const fixture = responsesFixture(['The answer', ' is 42']);

    expect(await runResponsesStream(JSON_OBJECT_REQUEST, fixture)).toEqual(fixture);
  });

  it('returns the original text when the fence does not prove out', async () => {
    const fixture = responsesFixture(['```json\n', '{"answer": 42}\n```\n', 'Hope that helps']);
    const frames = await runResponsesStream(JSON_OBJECT_REQUEST, fixture);
    const original = '```json\n{"answer": 42}\n```\nHope that helps';

    expect(deltaText(frames)).toBe(original);
    expect(findEvent(frames, 'response.output_text.done').text).toBe(original);
    expect(completedMessageTexts(frames)).toEqual([original]);
    expect(sequenceNumbers(frames)).toEqual(frames.map((_frame, index) => index));
  });

  it('leaves a fenced body that does not parse alone', async () => {
    const fixture = responsesFixture(['```json\n', 'not json at all\n```']);
    const frames = await runResponsesStream(JSON_OBJECT_REQUEST, fixture);
    const original = '```json\nnot json at all\n```';

    expect(deltaText(frames)).toBe(original);
    expect(completedMessageTexts(frames)).toEqual([original]);
  });

  it('unwraps a message that is closed by a following tool call', async () => {
    const fixture = responsesFixture(['```json\n{"answer": 42}\n```'], {
      toolCall: { args: { query: 'docs' }, name: 'search' },
    });
    const frames = await runResponsesStream(JSON_OBJECT_REQUEST, fixture);

    expect(deltaText(frames)).toBe('{"answer": 42}');
    expect(completedMessageTexts(frames)).toEqual(['{"answer": 42}']);
    expect(findEvent(frames, 'response.function_call_arguments.done').arguments).toBe(
      '{"query":"docs"}',
    );
    expect(sequenceNumbers(frames)).toEqual(frames.map((_frame, index) => index));
  });

  it('forwards heartbeat comments verbatim', async () => {
    const fixture = responsesFixture(['```json\n{"answer": 42}\n```']);
    const withHeartbeat = [fixture[0], ': ping\n\n', ...fixture.slice(1)];
    const result = applyOpenAIJsonObjectFence(
      JSON_OBJECT_REQUEST,
      of(...withHeartbeat),
      'responses',
    );
    const frames = await lastValueFrom((result as Observable<string>).pipe(toArray()));

    expect(frames).toContain(': ping\n\n');
    expect(sequenceNumbers(frames.filter((frame) => frame.startsWith('event: ')))).toEqual(
      frames.filter((frame) => frame.startsWith('event: ')).map((_f, index) => index),
    );
  });

  it('reads the Responses spelling of the request', () => {
    const controller = new ProxyController({} as never, {} as never);
    const build: unknown = Reflect.get(controller, 'buildResponsesChatRequest');
    if (typeof build !== 'function') {
      throw new Error('buildResponsesChatRequest is unavailable');
    }
    const request = Reflect.apply(build, controller, [
      { input: 'return json', model: 'gemini-3-flash', text: { format: { type: 'json_object' } } },
    ]) as OpenAIChatRequest;

    expect(request.response_format).toEqual({ type: 'json_object' });
  });
});
