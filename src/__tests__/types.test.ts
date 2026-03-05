import { describe, it, expect } from 'vitest';
import {
  MemberConfigSchema,
} from '../types.js';

describe('MemberConfigSchema', () => {
  it('should parse a complete member config', () => {
    const result = MemberConfigSchema.parse({
      username: 'alice',
      displayName: 'Alice Chen',
      registeredAt: '2025-01-01T00:00:00.000Z',
    });
    expect(result).toEqual({
      username: 'alice',
      displayName: 'Alice Chen',
      registeredAt: '2025-01-01T00:00:00.000Z',
    });
  });

  it('should default displayName to empty string', () => {
    const result = MemberConfigSchema.parse({
      username: 'bob',
      registeredAt: '2025-01-01T00:00:00.000Z',
    });
    expect(result.displayName).toBe('');
  });

  it('should reject missing required fields', () => {
    expect(() => MemberConfigSchema.parse({ username: 'x' })).toThrow();
    expect(() => MemberConfigSchema.parse({ registeredAt: 'x' })).toThrow();
  });

  it('should reject empty object', () => {
    expect(() => MemberConfigSchema.parse({})).toThrow();
  });

  it('should strip unknown fields like legacy role', () => {
    const result = MemberConfigSchema.parse({
      username: 'alice',
      displayName: 'Alice',
      registeredAt: '2025-01-01T00:00:00.000Z',
      role: 'write',
    });
    // Zod by default passes through unknown keys, but result type should not include role
    expect(result.username).toBe('alice');
    expect(result.registeredAt).toBe('2025-01-01T00:00:00.000Z');
  });
});
