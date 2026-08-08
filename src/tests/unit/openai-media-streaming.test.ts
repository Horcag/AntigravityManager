import { lastValueFrom, Observable, of, Subject, toArray } from 'rxjs';
import { describe, expect, it } from 'vitest';

import {
  mapGeminiAudioTranscriptionStream,
  mapOpenAIImageStream,
} from '@/modules/proxy-gateway/server/modules/openai/media/openai-media-streaming';

const pngFrame = (marker: number): string =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([marker]),
  ]).toString('base64');

const audioTextEvent = (text: string): string =>
  `data: ${JSON.stringify({
    candidates: [{ content: { parts: [{ text }] }, index: 0 }],
  })}\n\n`;

const chatImageEvent = (data: string): string =>
  `data: ${JSON.stringify({
    choices: [
      {
        delta: {
          content: `![Generated Image](data:image/png;base64,${data})`,
        },
        index: 0,
      },
    ],
  })}\n\n`;

describe('OpenAI media upstream stream adapters', () => {
  it('maps Gemini audio text chunks to transcript deltas and one terminal event', async () => {
    const first = JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'hello ' }] }, index: 0 }],
    });
    const second = JSON.stringify({
      candidates: [
        {
          content: {
            parts: [{ text: 'private reasoning', thought: true }, { text: 'world' }],
          },
          index: 0,
        },
      ],
    });
    const source = of(`data: ${first.slice(0, 19)}`, `${first.slice(19)}\n\ndata: ${second}\n\n`);

    const chunks = await lastValueFrom(mapGeminiAudioTranscriptionStream(source).pipe(toArray()));

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toContain('event: transcript.text.delta');
    expect(chunks[0]).toContain('"delta":"hello "');
    expect(chunks[1]).toContain('"delta":"world"');
    expect(chunks[1]).not.toContain('private reasoning');
    expect(chunks[2]).toContain('event: transcript.text.done');
    expect(chunks[2]).toContain('"text":"hello world"');
  });

  it('fails a malformed Gemini audio event instead of synthesizing a completion', async () => {
    await expect(
      lastValueFrom(mapGeminiAudioTranscriptionStream(of('data: {not-json}\n\n')).pipe(toArray())),
    ).rejects.toThrow(/invalid.*SSE/i);
  });

  it('keeps transcript state isolated for each subscription', async () => {
    const event = `data: ${JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'once' }] }, index: 0 }],
    })}\n\n`;
    const mapped = mapGeminiAudioTranscriptionStream(of(event));

    const first = await lastValueFrom(mapped.pipe(toArray()));
    const second = await lastValueFrom(mapped.pipe(toArray()));

    expect(first).toEqual(second);
    expect(second.at(-1)).toContain('"text":"once"');
  });

  /**
   * The point of these three is timing, not shape. Asserting on the assembled `text` alone would
   * pass against an implementation that buffers the whole upstream response and synthesises the
   * events at the end, so each one drives the upstream by hand and asserts on what the client
   * already holds *while the upstream is still open*.
   */
  it('delivers each transcript delta before the upstream stream completes', () => {
    const upstream = new Subject<string>();
    const received: string[] = [];
    let completed = false;

    const subscription = mapGeminiAudioTranscriptionStream(upstream).subscribe({
      next: (chunk) => received.push(chunk),
      complete: () => {
        completed = true;
      },
    });

    upstream.next(audioTextEvent('first '));
    expect(completed).toBe(false);
    expect(received).toHaveLength(1);
    expect(received[0]).toContain('event: transcript.text.delta');
    expect(received[0]).toContain('"delta":"first "');

    upstream.next(audioTextEvent('second'));
    expect(completed).toBe(false);
    expect(received).toHaveLength(2);
    expect(received[1]).toContain('"delta":"second"');
    // A buffering implementation could not have produced either delta by this point, and the
    // terminal event must not appear until the upstream actually ends.
    expect(received.some((chunk) => chunk.includes('transcript.text.done'))).toBe(false);

    upstream.complete();
    expect(completed).toBe(true);
    expect(received).toHaveLength(3);
    expect(received[2]).toContain('event: transcript.text.done');
    expect(received[2]).toContain('"text":"first second"');

    subscription.unsubscribe();
  });

  it('trips the transcript byte limit on the running total while the upstream is still open', () => {
    const megabyte = 'x'.repeat(1024 * 1024);
    const upstream = new Subject<string>();
    const received: string[] = [];
    let failure: unknown;
    let completed = false;

    mapGeminiAudioTranscriptionStream(upstream).subscribe({
      next: (chunk) => received.push(chunk),
      error: (error) => {
        failure = error;
      },
      complete: () => {
        completed = true;
      },
    });

    // The limit is 4 MiB, so four deltas pass and the fifth must be refused mid-stream. Enforcing
    // the cap on the final assembly instead would let all five through and only fail on complete().
    for (let index = 0; index < 5; index += 1) {
      upstream.next(audioTextEvent(megabyte));
    }

    expect(received).toHaveLength(4);
    expect(completed).toBe(false);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/transcript exceeds/i);
  });

  it('surfaces a mid-stream upstream failure without retracting or completing the sent deltas', () => {
    const upstream = new Subject<string>();
    const received: string[] = [];
    let failure: unknown;
    let completed = false;

    mapGeminiAudioTranscriptionStream(upstream).subscribe({
      next: (chunk) => received.push(chunk),
      error: (error) => {
        failure = error;
      },
      complete: () => {
        completed = true;
      },
    });

    upstream.next(audioTextEvent('partial words'));
    expect(received).toHaveLength(1);

    upstream.error(new Error('upstream transcription stream aborted'));

    // Deltas already on the wire stay on the wire; the stream errors rather than inventing a
    // `transcript.text.done` that would claim the partial transcript was the whole transcript.
    expect(received).toHaveLength(1);
    expect(received[0]).toContain('"delta":"partial words"');
    expect(completed).toBe(false);
    expect((failure as Error).message).toBe('upstream transcription stream aborted');
  });

  it('emits an image partial only after a later upstream image proves it was intermediate', async () => {
    const first = pngFrame(1);
    const final = pngFrame(2);
    const source = of(chatImageEvent(first), chatImageEvent(final), 'data: [DONE]\n\n');

    const chunks = await lastValueFrom(
      mapOpenAIImageStream(source, {
        partialImages: 1,
        path: '/v1/images/generations',
        quality: 'high',
        size: '1024x1024',
      }).pipe(toArray()),
    );

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toContain('event: image_generation.partial_image');
    expect(chunks[0]).toContain(`"b64_json":"${first}"`);
    expect(chunks[0]).toContain('"partial_image_index":0');
    expect(chunks[1]).toContain('event: image_generation.completed');
    expect(chunks[1]).toContain(`"b64_json":"${final}"`);
  });

  it('does not relabel a single final upstream image as a partial frame', async () => {
    const final = pngFrame(3);

    const chunks = await lastValueFrom(
      mapOpenAIImageStream(of(chatImageEvent(final), 'data: [DONE]\n\n'), {
        partialImages: 3,
        path: '/v1/images/edits',
      }).pipe(toArray()),
    );

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('event: image_edit.completed');
    expect(chunks[0]).not.toContain('partial_image');
  });

  it('reassembles an inline image split across upstream content deltas', async () => {
    const final = pngFrame(4);
    const markdown = `![Generated Image](data:image/png;base64,${final})`;
    const splitAt = Math.floor(markdown.length / 2);
    const chunk = (content: string) =>
      `data: ${JSON.stringify({
        choices: [{ delta: { content }, index: 0 }],
      })}\n\n`;

    const chunks = await lastValueFrom(
      mapOpenAIImageStream(
        of(chunk(markdown.slice(0, splitAt)), chunk(markdown.slice(splitAt)), 'data: [DONE]\n\n'),
        {
          partialImages: 0,
          path: '/v1/images/generations',
        },
      ).pipe(toArray()),
    );

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain(`"b64_json":"${final}"`);
  });

  it('fails an image stream that completes without upstream inline image data', async () => {
    const textOnly = `data: ${JSON.stringify({
      choices: [{ delta: { content: 'No image available' }, index: 0 }],
    })}\n\n`;

    await expect(
      lastValueFrom(
        mapOpenAIImageStream(of(textOnly, 'data: [DONE]\n\n'), {
          partialImages: 0,
          path: '/v1/images/generations',
        }).pipe(toArray()),
      ),
    ).rejects.toThrow(/inline image/i);
  });

  it('unsubscribes the upstream media stream when the downstream client disconnects', () => {
    let upstreamUnsubscribed = false;
    const source = new Observable<string>((subscriber) => {
      subscriber.next('data: {"candidates":[]}\n\n');
      return () => {
        upstreamUnsubscribed = true;
      };
    });

    const subscription = mapGeminiAudioTranscriptionStream(source).subscribe();
    subscription.unsubscribe();

    expect(upstreamUnsubscribed).toBe(true);
  });
});
