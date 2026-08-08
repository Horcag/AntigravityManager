import { describe, expect, it } from 'vitest';

import { transformClaudeRequestIn } from '@/modules/proxy-gateway/antigravity/ClaudeRequestMapper';
import { SignatureStore } from '@/modules/proxy-gateway/antigravity/SignatureStore';
import { cleanJsonSchema } from '@/modules/proxy-gateway/antigravity/JsonSchemaUtils';
import type {
  ClaudeRequest,
  GeminiToolDeclaration,
} from '@/modules/proxy-gateway/antigravity/types';

/**
 * Schema exercising every construct the sanitiser has an opinion about:
 * $schema, $defs/$ref, anyOf, oneOf, enum, const, default, pattern, format, minimum/maximum,
 * uniqueItems, additionalProperties: false, a nullable union type and a nested object.
 */
const COMPLEX_INPUT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  $defs: {
    Passenger: {
      type: 'object',
      additionalProperties: false,
      properties: {
        first: { type: 'string', minLength: 1, pattern: '^[A-Z][a-z]+$' },
        last: { type: 'string' },
        born: { type: 'string', format: 'date' },
      },
      required: ['first', 'last'],
    },
  },
  properties: {
    passenger: { $ref: '#/$defs/Passenger' },
    seat: {
      anyOf: [
        { type: 'string', pattern: '^[0-9]{1,2}[A-F]$' },
        { type: 'object', properties: { row: { type: 'integer' } } },
      ],
    },
    payment: {
      oneOf: [
        { type: 'object', properties: { card: { type: 'string' } }, required: ['card'] },
        { type: 'object', properties: { miles: { type: 'integer' } }, required: ['miles'] },
      ],
    },
    cabin: { type: 'string', enum: ['economy', 'business'], default: 'economy' },
    bags: { type: 'integer', minimum: 0, maximum: 3 },
    contact: { type: ['string', 'null'], format: 'email' },
    tags: { type: 'array', uniqueItems: true, items: { type: 'string' } },
    nested: {
      type: 'object',
      additionalProperties: false,
      properties: {
        deep: { type: 'object', properties: { flag: { type: 'boolean', const: true } } },
      },
    },
  },
  required: ['passenger', 'seat'],
};

function renderToolPayload(model: string, inputSchema: unknown): GeminiToolDeclaration[] {
  const claudeRequest: ClaudeRequest = {
    model: 'claude-sonnet-4-5',
    messages: [{ role: 'user', content: 'book it' }],
    tools: [
      {
        name: 'book_flight',
        description: 'Book a flight',
        input_schema: inputSchema as never,
      },
    ],
  };

  const body = transformClaudeRequestIn(claudeRequest, undefined, 'unit-agent', model, {
    accountId: 'acct-unit',
    store: new SignatureStore(),
  });

  const tools = body.request.tools;
  expect(tools).toBeDefined();
  return tools as GeminiToolDeclaration[];
}

describe('Antigravity tool schema fidelity', () => {
  it.each(['gemini-3-flash', 'claude-sonnet-4-6-thinking'])(
    'renders the outgoing tool payload for %s',
    (model) => {
      const tools = renderToolPayload(model, COMPLEX_INPUT_SCHEMA);

      // The wire shape is one shared functionDeclarations array carrying `parameters`.
      // Measured working live on 0.19.24-local1 for both model families; do not split it into one
      // array per declaration and do not rename the field to `parametersJsonSchema`.
      expect(tools).toEqual([
        {
          functionDeclarations: [
            {
              name: 'book_flight',
              description: 'Book a flight',
              parameters: {
                type: 'object',
                properties: {
                  // $ref is flattened inline from $defs; declared property names survive verbatim.
                  passenger: {
                    type: 'object',
                    properties: {
                      first: {
                        type: 'string',
                        description: ' [Constraint: pattern: ^[A-Z][a-z]+$, minLen: 1]',
                      },
                      last: { type: 'string' },
                      born: { type: 'string', description: ' [Constraint: format: date]' },
                    },
                    required: ['first', 'last'],
                  },
                  // anyOf collapses to its first non-null branch instead of becoming `{}`.
                  seat: {
                    type: 'string',
                    description: ' [Constraint: pattern: ^[0-9]{1,2}[A-F]$]',
                  },
                  // oneOf keeps the first branch's property names and required list.
                  payment: {
                    type: 'object',
                    properties: { card: { type: 'string' } },
                    required: ['card'],
                  },
                  cabin: {
                    type: 'string',
                    enum: ['economy', 'business'],
                    description: ' [Constraint: default: economy]',
                  },
                  bags: { type: 'integer', description: ' [Constraint: min: 0, max: 3]' },
                  contact: { type: 'string', description: ' [Constraint: format: email]' },
                  tags: { type: 'array', items: { type: 'string' } },
                  nested: {
                    type: 'object',
                    properties: {
                      deep: {
                        type: 'object',
                        properties: {
                          flag: { type: 'boolean', description: ' [Constraint: const: true]' },
                        },
                      },
                    },
                  },
                },
                required: ['passenger', 'seat'],
              },
            },
          ],
        },
      ]);
    },
  );

  it('emits no construct outside the Gemini parameters subset', () => {
    const [tool] = renderToolPayload('gemini-3-flash', COMPLEX_INPUT_SCHEMA);
    const rendered = JSON.stringify(tool);

    for (const unsupported of [
      '$schema',
      '$defs',
      '$ref',
      'anyOf',
      'oneOf',
      'allOf',
      'additionalProperties',
      'uniqueItems',
      'pattern',
      'minLength',
      'minimum',
      'maximum',
      'format',
    ]) {
      expect(rendered).not.toContain(`"${unsupported}"`);
    }
    expect(rendered).not.toContain('parametersJsonSchema');
  });
});

describe('cleanJsonSchema composition collapse', () => {
  it('adopts the first non-null branch of a nullable anyOf', () => {
    const schema: Record<string, unknown> = {
      type: 'object',
      properties: {
        note: { anyOf: [{ type: 'null' }, { type: 'string', description: 'free text' }] },
      },
    };

    cleanJsonSchema(schema);

    expect((schema.properties as Record<string, unknown>).note).toEqual({
      type: 'string',
      description: 'free text',
    });
  });

  it('merges every allOf branch because allOf is an intersection', () => {
    const schema: Record<string, unknown> = {
      allOf: [
        { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
        { properties: { b: { type: 'integer' } }, required: ['b'] },
      ],
    };

    cleanJsonSchema(schema);

    expect(schema).toEqual({
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'integer' } },
      required: ['a', 'b'],
    });
  });

  it('keeps what the node already declares and only fills the gaps from the branch', () => {
    const schema: Record<string, unknown> = {
      type: 'object',
      description: 'own description',
      properties: { keep: { type: 'string' } },
      anyOf: [
        {
          type: 'string',
          description: 'branch description',
          properties: { keep: { type: 'integer' }, added: { type: 'boolean' } },
        },
      ],
    };

    cleanJsonSchema(schema);

    expect(schema).toEqual({
      type: 'object',
      description: 'own description',
      properties: { keep: { type: 'string' }, added: { type: 'boolean' } },
    });
  });

  it('collapses composition nested inside a branch', () => {
    const schema: Record<string, unknown> = {
      oneOf: [
        {
          type: 'object',
          properties: { inner: { anyOf: [{ type: 'integer' }, { type: 'string' }] } },
        },
      ],
    };

    cleanJsonSchema(schema);

    expect(schema).toEqual({
      type: 'object',
      properties: { inner: { type: 'integer' } },
    });
  });

  it('leaves a node empty when no branch carries a usable schema', () => {
    const schema: Record<string, unknown> = { anyOf: [true, false] };

    cleanJsonSchema(schema);

    expect(schema).toEqual({});
  });
});
