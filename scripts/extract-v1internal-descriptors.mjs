import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_BINARY_PATH =
  'C:/Users/nikit/AppData/Local/Programs/antigravity/resources/bin/language_server.exe';
const TARGET_PACKAGE = 'google.internal.cloud.code.v1internal';

function readVarint(buffer, offset) {
  let value = 0;
  let shift = 0;

  while (offset < buffer.length && shift < 64) {
    const byte = buffer[offset];
    offset += 1;
    value += (byte & 0x7f) * 2 ** shift;

    if ((byte & 0x80) === 0) {
      return { value, offset };
    }

    shift += 7;
  }

  throw new Error('Invalid protobuf varint.');
}

function readField(buffer, offset) {
  const { value: tag, offset: afterTag } = readVarint(buffer, offset);
  const number = Math.floor(tag / 8);
  const wireType = tag % 8;

  if (number === 0) {
    throw new Error('Invalid protobuf field number 0.');
  }

  if (wireType === 0) {
    const result = readVarint(buffer, afterTag);
    return { number, wireType, value: result.value, offset: result.offset };
  }

  if (wireType === 1) {
    return {
      number,
      wireType,
      value: buffer.subarray(afterTag, afterTag + 8),
      offset: afterTag + 8,
    };
  }

  if (wireType === 2) {
    const { value: length, offset: contentOffset } = readVarint(buffer, afterTag);
    const end = contentOffset + length;

    if (end > buffer.length) {
      throw new Error('Length-delimited protobuf field exceeds input.');
    }

    return { number, wireType, value: buffer.subarray(contentOffset, end), offset: end };
  }

  if (wireType === 5) {
    return {
      number,
      wireType,
      value: buffer.subarray(afterTag, afterTag + 4),
      offset: afterTag + 4,
    };
  }

  throw new Error(`Unsupported protobuf wire type ${wireType}.`);
}

function readMessage(buffer) {
  const fields = [];
  let offset = 0;

  while (offset < buffer.length) {
    const field = readField(buffer, offset);
    fields.push(field);
    offset = field.offset;
  }

  return fields;
}

function decodeString(buffer) {
  return Buffer.from(buffer).toString('utf8');
}

function fieldValue(fields, number) {
  return fields.find((field) => field.number === number)?.value;
}

function fieldValues(fields, number) {
  return fields.filter((field) => field.number === number).map((field) => field.value);
}

function parseFieldDescriptor(buffer) {
  const fields = readMessage(buffer);
  const label = fieldValue(fields, 4);
  const type = fieldValue(fields, 5);
  const typeName = fieldValue(fields, 6);

  return {
    name: decodeString(fieldValue(fields, 1)),
    number: fieldValue(fields, 3),
    label,
    type,
    typeName: typeName ? decodeString(typeName) : undefined,
    jsonName: fieldValue(fields, 10) ? decodeString(fieldValue(fields, 10)) : undefined,
  };
}

function parseMessageDescriptor(buffer, prefix) {
  const fields = readMessage(buffer);
  const name = decodeString(fieldValue(fields, 1));
  const fullName = `${prefix}.${name}`;
  const nestedMessages = fieldValues(fields, 3).flatMap((nested) =>
    parseMessageDescriptor(nested, fullName),
  );

  return [
    {
      name: fullName,
      fields: fieldValues(fields, 2).map(parseFieldDescriptor),
    },
    ...nestedMessages,
  ];
}

function parseMethodDescriptor(buffer) {
  const fields = readMessage(buffer);

  return {
    name: decodeString(fieldValue(fields, 1)),
    inputType: decodeString(fieldValue(fields, 2)),
    outputType: decodeString(fieldValue(fields, 3)),
    clientStreaming: Boolean(fieldValue(fields, 5)),
    serverStreaming: Boolean(fieldValue(fields, 6)),
  };
}

function parseServiceDescriptor(buffer) {
  const fields = readMessage(buffer);

  return {
    name: decodeString(fieldValue(fields, 1)),
    methods: fieldValues(fields, 2).map(parseMethodDescriptor),
  };
}

/**
 * Reads one FileDescriptorProto embedded as a raw byte sequence in a Go binary.
 * Raw descriptors are not length-prefixed, so a second top-level filename field
 * marks the following descriptor and is intentionally left unread.
 */
export function parseFileDescriptor(buffer, startOffset) {
  const fields = [];
  let offset = startOffset;
  let sawFileName = false;

  while (offset < buffer.length) {
    if (buffer[offset] === 0) {
      break;
    }

    const field = readField(buffer, offset);

    if (field.number === 1 && sawFileName) {
      break;
    }

    if (field.number > 12) {
      break;
    }

    if (field.number === 1) {
      sawFileName = true;
    }

    fields.push(field);
    offset = field.offset;
  }

  const packageName = decodeString(fieldValue(fields, 2));

  if (!sawFileName || !packageName) {
    throw new Error('Input does not begin with a FileDescriptorProto.');
  }

  const messages = fieldValues(fields, 4).flatMap((message) =>
    parseMessageDescriptor(message, packageName),
  );
  const services = fieldValues(fields, 6).map(parseServiceDescriptor);

  return {
    endOffset: offset,
    fileName: decodeString(fieldValue(fields, 1)),
    packageName,
    messages,
    services,
  };
}

function findRawFileDescriptors(binary) {
  const descriptors = [];
  const marker = Buffer.from('google/internal/cloud/code/v1internal/', 'utf8');
  let markerOffset = -1;

  while ((markerOffset = binary.indexOf(marker, markerOffset + 1)) !== -1) {
    for (let prefixLength = 2; prefixLength <= 6; prefixLength += 1) {
      const startOffset = markerOffset - prefixLength;

      if (startOffset < 0 || binary[startOffset] !== 0x0a) {
        continue;
      }

      try {
        const descriptor = parseFileDescriptor(binary, startOffset);

        if (
          descriptor.packageName === TARGET_PACKAGE &&
          descriptor.fileName.startsWith('google/internal/cloud/code/v1internal/') &&
          !descriptors.some((existing) => existing.fileName === descriptor.fileName)
        ) {
          descriptors.push(descriptor);
        }
      } catch {
        // Most matching strings are imports rather than a raw descriptor start.
      }
    }
  }

  return descriptors;
}

export function extractV1InternalDescriptors(binary) {
  return findRawFileDescriptors(binary);
}

function main() {
  const binaryPath = path.resolve(process.argv[2] ?? DEFAULT_BINARY_PATH);
  const binary = fs.readFileSync(binaryPath);
  const descriptors = extractV1InternalDescriptors(binary);
  const methods = descriptors.flatMap((descriptor) =>
    descriptor.services.flatMap((service) =>
      service.methods.map((method) => ({
        ...method,
        service: service.name,
        file: descriptor.fileName,
      })),
    ),
  );

  process.stdout.write(`${JSON.stringify({ binaryPath, descriptors, methods }, null, 2)}\n`);
}

if (import.meta.url === `file:///${process.argv[1]?.replaceAll('\\', '/')}`) {
  main();
}
