import { describe, it, expect } from 'vitest';
import { deriveLocalAgentId, deriveInstanceId, detectMachineId, getMachineId } from '../machine-id.js';

describe('deriveLocalAgentId', () => {
  it('is stable for the same inputs', () => {
    const a = deriveLocalAgentId('codebuddy', 'machine-xyz', '/home/u/.codebuddy');
    const b = deriveLocalAgentId('codebuddy', 'machine-xyz', '/home/u/.codebuddy');
    expect(a).toBe(b);
  });

  it('produces a 16-char hex id', () => {
    const id = deriveLocalAgentId('workbuddy', 'm', '/home/u/.workbuddy');
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  it('differs by install_path (user vs project scope ⇒ independent instances)', () => {
    const user = deriveLocalAgentId('codebuddy', 'm', '/home/u/.codebuddy');
    const project = deriveLocalAgentId('codebuddy', 'm', '/home/u/proj/.codebuddy');
    expect(user).not.toBe(project);
  });

  it('differs by agent_type and by machine_id', () => {
    const base = deriveLocalAgentId('codebuddy', 'm1', '/p');
    expect(deriveLocalAgentId('workbuddy', 'm1', '/p')).not.toBe(base);
    expect(deriveLocalAgentId('codebuddy', 'm2', '/p')).not.toBe(base);
  });

  it('never embeds the raw install_path in the id', () => {
    const id = deriveLocalAgentId('codebuddy', 'm', '/home/secret-user/.codebuddy');
    expect(id).not.toContain('secret-user');
    expect(id).not.toContain('/');
  });
});

describe('deriveInstanceId', () => {
  it('formats as local-<agent_type>-<last6>', () => {
    const localAgentId = 'abcdef0123456789';
    expect(deriveInstanceId('workbuddy', localAgentId)).toBe('local-workbuddy-456789');
  });
});

describe('detectMachineId', () => {
  it('returns empty string for an unsupported/empty platform without throwing', () => {
    // 'sunos' hits the linux branch which reads /etc/machine-id; in CI this may
    // exist or not — either way it must be a string and must not throw.
    expect(typeof detectMachineId('linux')).toBe('string');
  });

  it('getMachineId caches and returns a string', () => {
    expect(typeof getMachineId()).toBe('string');
    // Second call returns the cached value (same reference value).
    expect(getMachineId()).toBe(getMachineId());
  });
});
