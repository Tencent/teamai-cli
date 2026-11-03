import { z } from 'zod';
import type { JsonObject } from '../types.js';
import { isRecord } from './expression.js';
import type { OutputSchema } from './types.js';

/** A step's output as a lease carries it, the parsed shorthand. */
export const OutputSchemaSchema: z.ZodType<OutputSchema> = z.lazy(() => z.union([
  z.object({ type: z.enum(['string', 'number', 'boolean', 'json', 'workflow']) }),
  z.object({ type: z.literal('enum'), values: z.array(z.string()) }),
  z.object({ type: z.literal('object'), fields: z.record(z.string(), OutputSchemaSchema) }),
  z.object({ type: z.literal('array'), items: OutputSchemaSchema }),
]));

/** Return an English mismatch, or null when `value` fits the shorthand. */
// oxlint-disable-next-line teamai/no-unknown-parameters -- checks the outputs and inputs a step reported before anything reads them
export function outputMismatch(schema: OutputSchema, value: unknown, path = 'output'): string | null {
  switch (schema.type) {
    case 'string':
      return z.string().safeParse(value).success ? null : `${path} must be a string`;
    case 'number':
      // A finite number: zod refuses NaN and the infinities.
      return z.number().safeParse(value).success ? null : `${path} must be a number`;
    case 'boolean':
      return z.boolean().safeParse(value).success ? null : `${path} must be a boolean`;
    case 'enum': {
      const text = z.string().safeParse(value);

      return text.success && schema.values.includes(text.data)
        ? null
        : `${path} must be one of ${schema.values.join(', ')}`;
    }

    case 'array':
      if (!Array.isArray(value)) return `${path} must be an array`;

      for (let index = 0; index < value.length; index += 1) {
        const mismatch = outputMismatch(schema.items, value[index], `${path}[${index}]`);

        if (mismatch) return mismatch;
      }

      return null;
    case 'object': {
      if (!isRecord(value)) return `${path} must be an object`;
      // Extra keys are allowed. Only declared fields are checked.

      for (const [key, child] of Object.entries(schema.fields)) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) return `${path}.${key} is missing`;
        const mismatch = outputMismatch(child, value[key], `${path}.${key}`);

        if (mismatch) return mismatch;
      }

      return null;
    }

    case 'json':
      return value === undefined ? `${path} is missing` : null;
    case 'workflow':
      return isRecord(value) ? null : `${path} must be an object that holds a workflow definition`;
    default:
      return `${path} is not a supported shorthand`;
  }
}

/**
 * The JSON Schema of the values `outputMismatch` accepts. A workflow is held to what admission takes once the step
 * reports: `definition`, and only the keys a bundle has.
 */
function jsonSchemaOf(schema: OutputSchema): JsonObject {
  switch (schema.type) {
    case 'string':
    case 'number':
    case 'boolean':
      return { type: schema.type };
    case 'enum':
      return { type: 'string', enum: schema.values };
    case 'array':
      return { type: 'array', items: jsonSchemaOf(schema.items) };
    case 'object':
      // Every declared field is required, and extra keys are allowed.
      return {
        type: 'object',
        properties: Object.fromEntries(Object.entries(schema.fields).map(([key, child]) => [key, jsonSchemaOf(child)])),
        required: Object.keys(schema.fields),
      };
    case 'json':
      return {};
    case 'workflow':
      // The keys admission's strict `BundleSchema` takes, and no others.
      return {
        type: 'object',
        description: 'A workflow bundle, where definition is a workflow file as JSON.',
        properties: { definition: { type: 'object' }, workflows: { type: 'object' }, scorers: { type: 'object' }, teamRevision: { type: 'string' } },
        required: ['definition'],
        additionalProperties: false,
      };
    default: {
      const unhandled: never = schema;

      return unhandled;
    }
  }
}

/**
 * What a prompt step's result instruction asks its `output` to be, so every driver asks for the same thing: a value
 * that matches the step's declared output as JSON Schema, or a short summary when it declares none.
 */
export function expectedOutput(schema: OutputSchema | undefined): string {
  return schema === undefined
    ? 'a short summary of what you did, as a JSON string'
    : `a value that matches this JSON Schema: \`${JSON.stringify(jsonSchemaOf(schema))}\``;
}
