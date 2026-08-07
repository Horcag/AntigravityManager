import type { FastifyRequest } from 'fastify';
import type { ImageMonitoringRequest } from './image-monitoring-summary';
import {
  finalizeParsedImageEditRequest,
  normalizeImageRequestFields,
} from './image-request-contract';
import {
  OPENAI_IMAGE_MULTIPART_LIMITS,
  OPENAI_INLINE_MEDIA_BYTES_LIMIT,
  OpenAIMediaRequestError,
  normalizeMultipartMediaError,
  parseMultipartMediaFile,
  type ParsedInlineMedia,
} from './openai-media-request-contract';

const IMAGE_FIELD_PATTERN = /^image(?:\d+)?$/u;
const IMAGE_ARRAY_FIELDS = new Set(['image', 'image[]', 'images', 'images[]', 'reference_images']);

/**
 * Consume a real Fastify multipart stream and retain each file's MIME type.
 *
 * `@Body()` does not parse multipart payloads unless fields are explicitly
 * attached to the request. Streaming the parts also avoids keeping duplicate
 * binary copies in Fastify and the controller.
 */
export async function parseImageMultipartRequest(
  request: FastifyRequest,
): Promise<ImageMonitoringRequest> {
  if (!request.isMultipart()) {
    throw new OpenAIMediaRequestError('Expected a multipart/form-data request', 'content-type');
  }

  const rawFields: Record<string, unknown> = {};
  const images: ParsedInlineMedia[] = [];
  const seenScalarFields = new Set<string>();
  let mask: ParsedInlineMedia | undefined;
  let style: string | undefined;
  let imageSize: string | undefined;
  let aspectRatio: string | undefined;

  try {
    for await (const part of request.parts({ limits: OPENAI_IMAGE_MULTIPART_LIMITS })) {
      if (part.type === 'file') {
        const isNumberedImage =
          IMAGE_FIELD_PATTERN.test(part.fieldname) && part.fieldname !== 'image';
        const isImage = IMAGE_ARRAY_FIELDS.has(part.fieldname) || isNumberedImage;
        if (!isImage && part.fieldname !== 'mask') {
          part.file.resume();
          throw new OpenAIMediaRequestError(
            `Unsupported multipart file field ${part.fieldname}`,
            part.fieldname,
            'unsupported_parameter',
          );
        }

        const image = parseMultipartMediaFile(await part.toBuffer(), {
          declaredMimeType: part.mimetype,
          filename: part.filename,
          kind: 'image',
          maxBytes: OPENAI_INLINE_MEDIA_BYTES_LIMIT,
          param: part.fieldname,
        });
        if (part.fieldname === 'mask') {
          if (mask) {
            throw new OpenAIMediaRequestError('Only one mask file is allowed', 'mask');
          }
          mask = image;
        } else {
          images.push(image);
        }
        continue;
      }

      if (part.valueTruncated) {
        throw new OpenAIMediaRequestError(
          `${part.fieldname} exceeds the multipart field limit`,
          part.fieldname,
          'payload_too_large',
          413,
        );
      }
      if (seenScalarFields.has(part.fieldname)) {
        throw new OpenAIMediaRequestError(
          `${part.fieldname} must be provided at most once`,
          part.fieldname,
        );
      }
      seenScalarFields.add(part.fieldname);
      const value = String(part.value ?? '');
      switch (part.fieldname) {
        case 'model':
        case 'n':
        case 'partial_images':
        case 'prompt':
        case 'quality':
        case 'response_format':
        case 'size':
        case 'stream':
        case 'user':
          rawFields[part.fieldname] = value;
          break;
        case 'aspect_ratio':
          aspectRatio = value;
          break;
        case 'image_size':
          imageSize = value;
          break;
        case 'style':
          style = value;
          break;
        case 'background':
        case 'input_fidelity':
        case 'moderation':
        case 'output_compression':
        case 'output_format':
          rawFields[part.fieldname] = value;
          break;
        default:
          throw new OpenAIMediaRequestError(
            `Unsupported multipart field ${part.fieldname}`,
            part.fieldname,
            'unsupported_parameter',
          );
      }
    }
  } catch (error) {
    throw normalizeMultipartMediaError(error);
  }

  if (aspectRatio !== undefined) {
    if (rawFields.size !== undefined) {
      throw new OpenAIMediaRequestError(
        'Use either size or aspect_ratio, not both',
        'aspect_ratio',
      );
    }
    rawFields.size = aspectRatio;
  }
  if (imageSize !== undefined) {
    if (rawFields.quality !== undefined) {
      throw new OpenAIMediaRequestError('Use either quality or image_size, not both', 'image_size');
    }
    const qualityByImageSize: Record<string, string> = {
      '1K': 'low',
      '2K': 'medium',
      '4K': 'hd',
    };
    const quality = qualityByImageSize[imageSize];
    if (!quality) {
      throw new OpenAIMediaRequestError('image_size must be 1K, 2K, or 4K', 'image_size');
    }
    rawFields.quality = quality;
  }
  if (style) {
    rawFields.style = style;
  }

  const fields = normalizeImageRequestFields(rawFields);
  return finalizeParsedImageEditRequest(fields, images, mask);
}
