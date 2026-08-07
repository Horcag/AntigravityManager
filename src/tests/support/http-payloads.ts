export interface ParsedSseEvent {
  event?: string;
  data: string;
}

export interface MultipartFilePart {
  bytes: Buffer;
  field: string;
  filename: string;
  mimeType: string;
}

export function parseSseEvents(payload: string): ParsedSseEvent[] {
  return payload
    .split(/\r?\n\r?\n/u)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const lines = block.split(/\r?\n/u);
      const event = lines
        .find((line) => line.startsWith('event:'))
        ?.slice('event:'.length)
        .trim();
      const data = lines
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice('data:'.length).trimStart())
        .join('\n');
      return { ...(event ? { event } : {}), data };
    })
    .filter((event) => event.data || event.event);
}

export function createMultipartPayload(
  boundary: string,
  fields: Array<[string, string]>,
  files: MultipartFilePart[],
): Buffer {
  const chunks: Uint8Array[] = fields.map(([name, value]) =>
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    ),
  );
  for (const file of files) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\nContent-Type: ${file.mimeType}\r\n\r\n`,
      ),
      file.bytes,
      Buffer.from('\r\n'),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}
