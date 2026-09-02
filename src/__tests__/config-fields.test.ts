import { describe, it, expect } from 'vitest';
import type { ZodObject, ZodTypeAny } from 'zod';
import { LocalConfigSchema } from '../types.js';
import { CONFIG_FIELDS, INTERNAL_CONFIG_KEYS, findFieldSpec } from '../config-fields.js';

/** All dot-paths the LocalConfigSchema knows: top-level leaf keys + repo.* keys. */
function schemaKeys(): string[] {
  const keys: string[] = [];
  for (const key of Object.keys(LocalConfigSchema.shape)) {
    const shape = (LocalConfigSchema.shape as Record<string, ZodTypeAny>)[key];
    const nested = shape && (shape as unknown as { shape?: Record<string, ZodTypeAny> }).shape;
    if (nested) {
      // Object containers (repo) are classified by their leaf keys, not themselves.
      for (const sub of Object.keys(nested)) {
        keys.push(`${key}.${sub}`);
      }
    } else {
      keys.push(key);
    }
  }
  return keys;
}

describe('config field registry coverage', () => {
  it('classifies every LocalConfigSchema key exactly once (editable, read-only, or internal)', () => {
    const classified = new Map<string, number>();
    for (const field of CONFIG_FIELDS) {
      classified.set(field.key, (classified.get(field.key) ?? 0) + 1);
    }
    for (const key of INTERNAL_CONFIG_KEYS) {
      classified.set(key, (classified.get(key) ?? 0) + 1);
    }

    // No duplicates anywhere.
    for (const [key, count] of classified) {
      expect(count, `key "${key}" classified ${count} times`).toBe(1);
    }

    // Every schema key is classified.
    const unclassified = schemaKeys().filter((k) => !classified.has(k));
    expect(unclassified).toEqual([]);

    // Nothing invented outside the schema.
    const schemaSet = new Set(schemaKeys());
    const invented = [...classified.keys()].filter((k) => !schemaSet.has(k));
    expect(invented).toEqual([]);
  });

  it('has no duplicate registry keys', () => {
    const keys = CONFIG_FIELDS.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('marks exactly the intended fields read-only, with empty scopes and a hint', () => {
    const readOnly = CONFIG_FIELDS.filter((f) => f.readOnly);
    expect(readOnly.map((f) => f.key).sort()).toEqual(
      [
        'disabledAgents',
        'enabledAgents',
        'repo.kind',
        'repo.localPath',
        'repo.remote',
        'scope',
        'username',
      ].sort(),
    );
    for (const field of readOnly) {
      expect(field.scopes, `readOnly field ${field.key} must have no scopes`).toEqual([]);
      expect(field.readOnlyHint, `readOnly field ${field.key} should carry a CLI hint`).toBeTruthy();
    }
  });

  it('static enums match the zod schema', () => {
    const updatePolicy = findFieldSpec('updatePolicy')!;
    expect(updatePolicy.enumValues).toEqual(['auto', 'prompt', 'skip']);
    // updatePolicy is z.enum([...]).optional() — unwrap the optional first.
    const wrapped = LocalConfigSchema.shape.updatePolicy as unknown as {
      _def?: { innerType?: { options?: string[] } };
    };
    const schemaEnumOptions = wrapped._def?.innerType?.options;
    expect(schemaEnumOptions).toEqual([...updatePolicy.enumValues!]);
  });

  it('gives every editable field at least one scope and a valid type', () => {
    const validTypes = new Set(['string', 'enum', 'boolean', 'boolean-tri', 'string[]']);
    for (const field of CONFIG_FIELDS) {
      if (field.readOnly) continue;
      expect(field.scopes.length, `editable field ${field.key} needs scopes`).toBeGreaterThan(0);
      expect(validTypes.has(field.type), `field ${field.key} has invalid type ${field.type}`).toBe(true);
      expect(field.label, `field ${field.key} needs a label`).toBeTruthy();
      expect(field.description, `field ${field.key} needs a description`).toBeTruthy();
    }
  });

  it('restricts inheritUserScope to project scope only', () => {
    expect(findFieldSpec('inheritUserScope')!.scopes).toEqual(['project']);
  });

  it('wires the documented side effects', () => {
    expect(typeof findFieldSpec('repo.branch')!.afterSave).toBe('function');
    expect(typeof findFieldSpec('recallEnabled')!.afterSave).toBe('function');
    expect(typeof findFieldSpec('excludedSkills')!.afterSave).toBe('function');
    // Plain writes: no afterSave.
    expect(findFieldSpec('updatePolicy')!.afterSave).toBeUndefined();
    expect(findFieldSpec('coAuthorEnabled')!.afterSave).toBeUndefined();
  });
});
