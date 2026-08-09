/**
 * The JSON Schema subset the checker declares to the provider and then verifies
 * the answer against.
 *
 * Deliberately tiny and dependency-free: it only has to cover the schemas this
 * checker itself sends (`type`, `properties`, `required`, `items`, `enum`,
 * `additionalProperties: false`). Anything richer would be verifying the
 * validator instead of the proxy.
 */

/**
 * @returns {string[]} one message per violation; empty when the value conforms.
 */
export function validateAgainstSchema(value, schema, path = '$') {
  if (!schema || typeof schema !== 'object') {
    return [];
  }

  const errors = [];

  if (schema.enum && !schema.enum.some((candidate) => Object.is(candidate, value))) {
    errors.push(
      `${path} must be one of ${JSON.stringify(schema.enum)}, got ${JSON.stringify(value)}`,
    );
  }

  if (schema.type && !matchesType(value, schema.type)) {
    errors.push(`${path} must be ${schema.type}, got ${describeType(value)}`);
    return errors;
  }

  if (schema.type === 'object' || (!schema.type && schema.properties)) {
    errors.push(...validateObject(value, schema, path));
  }

  if (schema.type === 'array' && Array.isArray(value) && schema.items) {
    value.forEach((entry, index) => {
      errors.push(...validateAgainstSchema(entry, schema.items, `${path}[${index}]`));
    });
  }

  return errors;
}

function validateObject(value, schema, path) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [`${path} must be object, got ${describeType(value)}`];
  }

  const errors = [];

  for (const key of schema.required ?? []) {
    if (!Object.hasOwn(value, key)) {
      errors.push(`${path}.${key} is required but missing`);
    }
  }

  if (schema.additionalProperties === false && schema.properties) {
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(schema.properties, key)) {
        errors.push(`${path}.${key} is not declared by the schema`);
      }
    }
  }

  for (const [key, propertySchema] of Object.entries(schema.properties ?? {})) {
    if (Object.hasOwn(value, key)) {
      errors.push(...validateAgainstSchema(value[key], propertySchema, `${path}.${key}`));
    }
  }

  return errors;
}

function matchesType(value, type) {
  switch (type) {
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'integer':
      return Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    default:
      return true;
  }
}

function describeType(value) {
  if (value === null) {
    return 'null';
  }

  return Array.isArray(value) ? 'array' : typeof value;
}
