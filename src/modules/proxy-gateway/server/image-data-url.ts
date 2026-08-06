const IMAGE_DATA_URL_PATTERN =
  /^data:(?<mime>image\/[A-Za-z0-9!#$&^_.+-]+)(?:;[A-Za-z0-9!#$&^_.+-]+=(?:[A-Za-z0-9!#$&^_.+%+-]+|"[^"]*"))*;base64,(?<data>[\s\S]*)$/i;

export interface ImageDataUrl {
  mimeType: string;
  data: string;
}

/**
 * Parses image data URLs accepted by the OpenAI-compatible boundary into the
 * normalized representation expected by every downstream request mapper.
 */
export function parseImageDataUrl(value: string): ImageDataUrl | null {
  const match = value.match(IMAGE_DATA_URL_PATTERN);
  const mimeType = match?.groups?.mime?.toLowerCase();
  const data = match?.groups?.data?.replace(/\s+/g, '');
  if (!mimeType || !data || !isValidBase64(data)) {
    return null;
  }

  return { mimeType, data };
}

function isValidBase64(data: string): boolean {
  if (data.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
    return false;
  }

  return (
    Buffer.from(data, 'base64').toString('base64').replace(/=+$/, '') === data.replace(/=+$/, '')
  );
}
