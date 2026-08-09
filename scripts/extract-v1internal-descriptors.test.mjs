import assert from 'node:assert/strict';
import test from 'node:test';
import { parseFileDescriptor } from './extract-v1internal-descriptors.mjs';

function varint(value) {
  const bytes = [];

  while (value > 0x7f) {
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }

  bytes.push(value);
  return Buffer.from(bytes);
}

function field(number, value) {
  return Buffer.concat([varint(number * 8 + 2), varint(value.length), Buffer.from(value)]);
}

function scalarField(number, value) {
  return Buffer.concat([varint(number * 8), varint(value)]);
}

test('parses message fields and RPC input/output types from a raw descriptor fixture', () => {
  const requestField = Buffer.concat([
    field(1, 'request_id'),
    scalarField(3, 1),
    scalarField(4, 1),
    scalarField(5, 9),
    field(10, 'requestId'),
  ]);
  const requestMessage = Buffer.concat([field(1, 'ExampleRequest'), field(2, requestField)]);
  const responseMessage = field(1, 'ExampleResponse');
  const method = Buffer.concat([
    field(1, 'Example'),
    field(2, '.example.ExampleRequest'),
    field(3, '.example.ExampleResponse'),
  ]);
  const service = Buffer.concat([field(1, 'ExampleService'), field(2, method)]);
  const descriptor = Buffer.concat([
    field(1, 'example.proto'),
    field(2, 'example'),
    field(4, requestMessage),
    field(4, responseMessage),
    field(6, service),
    field(12, 'proto3'),
    Buffer.from([0]),
  ]);

  const parsed = parseFileDescriptor(descriptor, 0);

  assert.equal(parsed.fileName, 'example.proto');
  assert.deepEqual(parsed.messages, [
    {
      name: 'example.ExampleRequest',
      fields: [
        {
          name: 'request_id',
          number: 1,
          label: 1,
          type: 9,
          typeName: undefined,
          jsonName: 'requestId',
        },
      ],
    },
    { name: 'example.ExampleResponse', fields: [] },
  ]);
  assert.deepEqual(parsed.services, [
    {
      name: 'ExampleService',
      methods: [
        {
          name: 'Example',
          inputType: '.example.ExampleRequest',
          outputType: '.example.ExampleResponse',
          clientStreaming: false,
          serverStreaming: false,
        },
      ],
    },
  ]);
});
