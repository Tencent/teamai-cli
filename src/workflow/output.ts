import type { OutputSchema } from './types.js';

/** Return an English mismatch, or null when `value` fits the shorthand. */
export function outputMismatch(schema: OutputSchema, value: unknown, path = 'output'): string | null {
  switch (schema.type) {
    case 'string':
      return typeof value === 'string' ? null : `${path} must be a string`;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? null : `${path} must be a number`;
    case 'boolean':
      return typeof value === 'boolean' ? null : `${path} must be a boolean`;
    case 'enum':
      return typeof value === 'string' && schema.values.includes(value)
        ? null
        : `${path} must be one of ${schema.values.join(', ')}`;
    case 'array':
      if (!Array.isArray(value)) return `${path} must be an array`;
      for (let index = 0; index < value.length; index += 1) {
        const mismatch = outputMismatch(schema.items, value[index], `${path}[${index}]`);
        if (mismatch) return mismatch;
      }
      return null;
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return `${path} must be an object`;
      // Extra keys are allowed. Only declared fields are checked.
      const record = value as Record<string, unknown>;
      for (const [key, child] of Object.entries(schema.fields)) {
        if (!Object.prototype.hasOwnProperty.call(record, key)) return `${path}.${key} is missing`;
        const mismatch = outputMismatch(child, record[key], `${path}.${key}`);
        if (mismatch) return mismatch;
      }
      return null;
    }
    default:
      return `${path} is not a supported shorthand`;
  }
}
