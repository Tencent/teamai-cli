import { z } from 'zod';
import { isRecord } from './expression.js';
import type { OutputSchema } from './types.js';

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
