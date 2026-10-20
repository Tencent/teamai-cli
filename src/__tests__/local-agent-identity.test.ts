import { describe, expect, it, vi } from 'vitest';

vi.mock('../machine-id.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../machine-id.js')>();
  return { ...original, getMachineId: () => 'test-machine-id' };
});

const { buildAgentIdentityPayload } = await import('../local-agent.js');

describe('local-agent identity payload', () => {
  it('carries machine_id / agent_type / local_agent_id', () => {
    const payload = buildAgentIdentityPayload({ cwd: '/tmp', tool: 'codebuddy', status: 'running' });
    expect(payload.machine_id).toBe('test-machine-id');
    expect(payload.agent_type).toBe('codebuddy');
    expect(payload).toHaveProperty('local_agent_id');
  });

  it('defaults agent_type to workbuddy when the context has no tool', () => {
    const payload = buildAgentIdentityPayload({ cwd: '/tmp', status: 'running' });
    expect(payload.agent_type).toBe('workbuddy');
  });
});
