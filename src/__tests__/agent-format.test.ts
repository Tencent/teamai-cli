import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fse from 'fs-extra';

vi.mock('../utils/logger.js', () => ({
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    dim: vi.fn(),
  },
  spinner: vi.fn(() => ({
    start: vi.fn().mockReturnThis(),
    succeed: vi.fn().mockReturnThis(),
    fail: vi.fn().mockReturnThis(),
  })),
}));

import {
  parseAgentYaml,
  serializeAgentYaml,
  renderForClaude,
  renderForClaudeInternal,
  renderForCodebuddy,
  renderForCodex,
  renderForCodexInternal,
  renderForCursor,
  reverseFromClaude,
  reverseFromCodebuddy,
  reverseFromCodex,
  reverseFromCursor,
  mergeReverseResults,
} from '../resources/agent-format.js';
import type { AgentSpec, ToolName, ParseResult } from '../resources/agent-format.js';
import { AgentsHandler } from '../resources/agents.js';
import type { AgentResourceItem } from '../resources/agents.js';
import type { TeamaiConfig, LocalConfig } from '../types.js';

// ─── Test helpers ─────────────────────────────────────────────────────────────

/** Minimal AgentSpec for testing. */
function makeSpec(overrides: Partial<AgentSpec> = {}): AgentSpec {
  return {
    name: 'test-agent',
    description: 'A test agent for unit tests',
    instructions: 'You are a helpful assistant.\nDo things well.',
    ...overrides,
  };
}

function buildTeamConfig(toolPaths: TeamaiConfig['toolPaths']): TeamaiConfig {
  return {
    team: 'test',
    description: '',
    repo: 'https://example.com/test/repo.git',
    provider: 'tgit' as const,
    reviewers: [],
    sharing: {
      skills: {},
      rules: { enforced: [] },
      docs: { localDir: '' },
      env: { injectShellProfile: true },
    },
    toolPaths,
  } as TeamaiConfig;
}

// ─── parseAgentYaml ───────────────────────────────────────────────────────────

describe('parseAgentYaml', () => {
  it('parses a valid YAML spec', () => {
    const yaml = `name: my-agent\ndescription: Does stuff\ninstructions: Be helpful\nmodel: claude-opus-4\n`;
    const result: ParseResult = parseAgentYaml(yaml, 'my-agent.yaml');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.name).toBe('my-agent');
    expect(result.spec.description).toBe('Does stuff');
    expect(result.spec.instructions).toBe('Be helpful');
    expect(result.spec.model).toBe('claude-opus-4');
  });

  it('parses optional fields: tools, targets, tool_extras', () => {
    const yaml = `name: a\ndescription: b\ninstructions: c\ntools:\n  - Bash\n  - Read\ntargets:\n  - claude\n  - codex\n`;
    const result = parseAgentYaml(yaml, 'a.yaml');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.tools).toEqual(['Bash', 'Read']);
    expect(result.spec.targets).toEqual(['claude', 'codex']);
  });

  it('returns ok=false on missing required field: name', () => {
    const yaml = `description: b\ninstructions: c\n`;
    const result = parseAgentYaml(yaml, 'bad.yaml');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('missing required field name');
  });

  it('returns ok=false on missing required field: description', () => {
    const yaml = `name: a\ninstructions: c\n`;
    const result = parseAgentYaml(yaml, 'bad.yaml');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('missing required field description');
  });

  it('returns ok=false on missing required field: instructions', () => {
    const yaml = `name: a\ndescription: b\n`;
    const result = parseAgentYaml(yaml, 'bad.yaml');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('missing required field instructions');
  });

  it('returns ok=false on YAML syntax error', () => {
    const yaml = `name: [unclosed`;
    const result = parseAgentYaml(yaml, 'bad.yaml');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('parse error');
  });
});

// ─── renderForClaude / ClaudeInternal / Codebuddy ────────────────────────────

describe('renderForClaude', () => {
  it('produces markdown with YAML frontmatter and body', () => {
    const spec = makeSpec({ model: 'claude-sonnet', tools: ['Bash'] });
    const { ext, content } = renderForClaude(spec);
    expect(ext).toBe('.md');
    expect(content).toContain('name: test-agent');
    expect(content).toContain('description: A test agent');
    expect(content).toContain('model: claude-sonnet');
    expect(content).toContain('- Bash');
    expect(content).toContain('You are a helpful assistant.');
  });

  it('omits model and tools when not present', () => {
    const { content } = renderForClaude(makeSpec());
    expect(content).not.toContain('model:');
    expect(content).not.toContain('tools:');
  });

  it('flattens tool_extras.claude into frontmatter', () => {
    const spec = makeSpec({ tool_extras: { claude: { allowedTools: ['Bash'], subagentModel: 'haiku' } } });
    const { content } = renderForClaude(spec);
    expect(content).toContain('allowedTools:');
    expect(content).toContain('subagentModel: haiku');
  });

  it('renderForClaudeInternal produces same format', () => {
    const spec = makeSpec({ tool_extras: { 'claude-internal': { extra_field: 'val' } } });
    const { ext, content } = renderForClaudeInternal(spec);
    expect(ext).toBe('.md');
    expect(content).toContain('extra_field: val');
    expect(content).toContain('name: test-agent');
  });

  it('renderForCodebuddy flattens codebuddy extras', () => {
    const spec = makeSpec({ tool_extras: { codebuddy: { permissionMode: 'strict' } } });
    const { ext, content } = renderForCodebuddy(spec);
    expect(ext).toBe('.md');
    expect(content).toContain('permissionMode: strict');
  });
});

// ─── renderForCodex / CodexInternal ─────────────────────────────────────────

describe('renderForCodex', () => {
  it('produces TOML with developer_instructions', () => {
    const spec = makeSpec({ model: 'gpt-4o' });
    const { ext, content } = renderForCodex(spec);
    expect(ext).toBe('.toml');
    expect(content).toContain('name = "test-agent"');
    expect(content).toContain('description = "A test agent');
    expect(content).toContain('developer_instructions');
    expect(content).toContain('You are a helpful assistant.');
    expect(content).toContain('model = "gpt-4o"');
  });

  it('does NOT include tools field (codex uses mcp_servers)', () => {
    const spec = makeSpec({ tools: ['Bash', 'Read'] });
    const { content } = renderForCodex(spec);
    expect(content).not.toContain('"tools"');
    expect(content).not.toContain('tools =');
  });

  it('flattens tool_extras.codex into top-level TOML fields', () => {
    const spec = makeSpec({
      tool_extras: { codex: { sandbox_mode: 'network-disabled', model_reasoning_effort: 'high' } },
    });
    const { content } = renderForCodex(spec);
    expect(content).toContain('sandbox_mode');
    expect(content).toContain('model_reasoning_effort');
  });

  it('renderForCodexInternal produces same TOML format with codex-internal extras', () => {
    const spec = makeSpec({ tool_extras: { 'codex-internal': { env_override: 'test' } } });
    const { ext, content } = renderForCodexInternal(spec);
    expect(ext).toBe('.toml');
    expect(content).toContain('env_override');
  });
});

// ─── renderForCursor ─────────────────────────────────────────────────────────

describe('renderForCursor', () => {
  it('uses agent_id instead of name in frontmatter', () => {
    const spec = makeSpec({ tools: ['Bash'] });
    const { ext, content } = renderForCursor(spec);
    expect(ext).toBe('.md');
    expect(content).toContain('agent_id: test-agent');
    expect(content).not.toContain('name: test-agent');
    expect(content).toContain('description:');
    expect(content).toContain('- Bash');
    expect(content).toContain('You are a helpful assistant.');
  });

  it('flattens tool_extras.cursor into frontmatter', () => {
    const spec = makeSpec({ tool_extras: { cursor: { composer_mode: true } } });
    const { content } = renderForCursor(spec);
    expect(content).toContain('composer_mode: true');
  });
});

// ─── reverseFromClaude ───────────────────────────────────────────────────────

describe('reverseFromClaude', () => {
  it('reverses a valid claude .md file', () => {
    const content = `---\nname: my-agent\ndescription: Helps with code\nmodel: claude-sonnet\n---\nDo the thing\n`;
    const result = reverseFromClaude('/path/to/my-agent.md', content);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.name).toBe('my-agent');
    expect(result.spec.description).toBe('Helps with code');
    expect(result.spec.instructions).toBe('Do the thing');
    expect(result.spec.model).toBe('claude-sonnet');
  });

  it('infers name from filename when frontmatter lacks name', () => {
    const content = `---\ndescription: Helps\n---\nInstructions here\n`;
    const result = reverseFromClaude('/agents/inferred-name.md', content);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.name).toBe('inferred-name');
  });

  it('returns error when description is missing', () => {
    const content = `---\nname: a\n---\nBody\n`;
    const result = reverseFromClaude('/agents/a.md', content);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('description');
  });

  it('returns error when body is empty', () => {
    const content = `---\nname: a\ndescription: b\n---\n\n`;
    const result = reverseFromClaude('/agents/a.md', content);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('instructions');
  });

  it('collects non-common frontmatter fields as tool_extras.claude', () => {
    const content = `---\nname: a\ndescription: b\ncustom_field: secret\n---\nBody\n`;
    const result = reverseFromClaude('/agents/a.md', content);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.tool_extras?.['claude']).toEqual({ custom_field: 'secret' });
  });
});

// ─── reverseFromCodebuddy ────────────────────────────────────────────────────

describe('reverseFromCodebuddy', () => {
  it('reverses a codebuddy .md file and sets tool_extras.codebuddy', () => {
    const content = `---\nname: cb-agent\ndescription: Codebuddy helper\npermissionMode: strict\n---\nInstructions\n`;
    const result = reverseFromCodebuddy('/agents/cb-agent.md', content);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.tool_extras?.['codebuddy']).toEqual({ permissionMode: 'strict' });
    expect(result.spec.tool_extras?.['claude']).toBeUndefined();
  });

  it('returns error on missing description', () => {
    const content = `---\nname: a\n---\nBody\n`;
    const result = reverseFromCodebuddy('/agents/a.md', content);
    expect(result.ok).toBe(false);
  });
});

// ─── reverseFromCodex ────────────────────────────────────────────────────────

describe('reverseFromCodex', () => {
  it('reverses a valid codex .toml file', () => {
    const content = `name = "codex-agent"\ndescription = "Codex helper"\ndeveloper_instructions = "Do stuff"\n`;
    const result = reverseFromCodex('/agents/codex-agent.toml', content);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.name).toBe('codex-agent');
    expect(result.spec.instructions).toBe('Do stuff');
  });

  it('collects non-common TOML fields as tool_extras.codex', () => {
    const content = `name = "a"\ndescription = "b"\ndeveloper_instructions = "c"\nsandbox_mode = "network-disabled"\n`;
    const result = reverseFromCodex('/agents/a.toml', content);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.tool_extras?.['codex']).toEqual({ sandbox_mode: 'network-disabled' });
  });

  it('returns error on missing developer_instructions', () => {
    const content = `name = "a"\ndescription = "b"\n`;
    const result = reverseFromCodex('/agents/a.toml', content);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('developer_instructions');
  });

  it('returns error on TOML parse failure', () => {
    const content = `name = unclosed [`;
    const result = reverseFromCodex('/agents/a.toml', content);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('parse error');
  });
});

// ─── reverseFromCursor ───────────────────────────────────────────────────────

describe('reverseFromCursor', () => {
  it('reverses a valid cursor .md file using agent_id', () => {
    const content = `---\nagent_id: cursor-agent\ndescription: Cursor helper\n---\nInstructions here\n`;
    const result = reverseFromCursor('/agents/cursor-agent.md', content);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.name).toBe('cursor-agent');
    expect(result.spec.description).toBe('Cursor helper');
  });

  it('collects non-common cursor fields as tool_extras.cursor', () => {
    const content = `---\nagent_id: a\ndescription: b\ncomposer_mode: true\n---\nBody\n`;
    const result = reverseFromCursor('/agents/a.md', content);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.tool_extras?.['cursor']).toEqual({ composer_mode: true });
  });

  it('returns error on missing description', () => {
    const content = `---\nagent_id: a\n---\nBody\n`;
    const result = reverseFromCursor('/agents/a.md', content);
    expect(result.ok).toBe(false);
  });

  it('returns error on empty body', () => {
    const content = `---\nagent_id: a\ndescription: b\n---\n\n`;
    const result = reverseFromCursor('/agents/a.md', content);
    expect(result.ok).toBe(false);
  });
});

// ─── mergeReverseResults ─────────────────────────────────────────────────────

describe('mergeReverseResults', () => {
  it('merges specs from multiple tools when all common fields agree', () => {
    const spec: AgentSpec = makeSpec({ model: 'gpt-4' });
    const claudeSpec: AgentSpec = { ...spec, tool_extras: { claude: { extra: 'c' } } };
    const codexSpec: AgentSpec = { ...spec, tool_extras: { codex: { sandbox_mode: 'off' } } };

    const result = mergeReverseResults({ claude: claudeSpec, codex: codexSpec });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.name).toBe('test-agent');
    expect(result.spec.tool_extras?.['claude']).toEqual({ extra: 'c' });
    expect(result.spec.tool_extras?.['codex']).toEqual({ sandbox_mode: 'off' });
  });

  it('returns conflicts when description differs across tools', () => {
    const spec1 = makeSpec({ description: 'Version A' });
    const spec2 = makeSpec({ description: 'Version B' });

    const result = mergeReverseResults({ claude: spec1, cursor: spec2 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const conflict = result.conflicts.find((c) => c.field === 'description');
    expect(conflict).toBeDefined();
    expect(conflict?.values).toMatchObject({ claude: 'Version A', cursor: 'Version B' });
  });

  it('returns conflicts when model differs across tools', () => {
    const spec1 = makeSpec({ model: 'gpt-4' });
    const spec2 = makeSpec({ model: 'claude-opus' });

    const result = mergeReverseResults({ claude: spec1, codex: spec2 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const conflict = result.conflicts.find((c) => c.field === 'model');
    expect(conflict).toBeDefined();
  });

  it('returns ok for a single tool input', () => {
    const spec = makeSpec();
    const result = mergeReverseResults({ claude: spec });
    expect(result.ok).toBe(true);
  });

  it('treats tool_extras as independent and merges them without conflict', () => {
    const spec = makeSpec();
    const result = mergeReverseResults({
      claude: { ...spec, tool_extras: { claude: { fieldA: 1 } } },
      codebuddy: { ...spec, tool_extras: { codebuddy: { fieldB: 2 } } },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.tool_extras?.['claude']).toEqual({ fieldA: 1 });
    expect(result.spec.tool_extras?.['codebuddy']).toEqual({ fieldB: 2 });
  });
});

// ─── AgentsHandler.pushItem — skip path ──────────────────────────────────────

describe('AgentsHandler.pushItem — skipReason path', () => {
  let tmpDir: string;
  let repoPath: string;
  let handler: AgentsHandler;
  let localConfig: LocalConfig;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-agents-push-test-'));
    repoPath = path.join(tmpDir, 'team-repo');
    await fse.ensureDir(path.join(repoPath, 'agents'));

    vi.stubEnv('HOME', tmpDir);

    handler = new AgentsHandler();
    localConfig = {
      repo: { localPath: repoPath, remote: 'https://example.com' },
      username: 'testuser',
      additionalRoles: [],
      scope: 'user',
    };
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  it('skips writing to team repo when skipReason is set', async () => {
    const { log: mockLog } = await import('../utils/logger.js');

    await handler.pushItem(
      {
        name: 'conflicted-agent',
        type: 'agents',
        sourcePath: path.join(tmpDir, 'conflicted-agent.md'),
        relativePath: 'agents/conflicted-agent.md',
        skipReason: 'conflicting description across tools',
      } as AgentResourceItem,
      buildTeamConfig({}),
      localConfig,
    );

    const teamYaml = path.join(repoPath, 'agents', 'conflicted-agent.yaml');
    const teamMd = path.join(repoPath, 'agents', 'conflicted-agent.md');
    expect(await fse.pathExists(teamYaml)).toBe(false);
    expect(await fse.pathExists(teamMd)).toBe(false);
    expect(mockLog.warn).toHaveBeenCalled();
  });

  it('writes YAML to team repo when mergedSpec is provided', async () => {
    const spec = makeSpec();

    await handler.pushItem(
      {
        name: 'test-agent',
        type: 'agents',
        sourcePath: path.join(tmpDir, 'test-agent.md'),
        relativePath: 'agents/test-agent.yaml',
        mergedSpec: spec,
      } as AgentResourceItem,
      buildTeamConfig({}),
      localConfig,
    );

    const teamYaml = path.join(repoPath, 'agents', 'test-agent.yaml');
    expect(await fse.pathExists(teamYaml)).toBe(true);
    const written = await fse.readFile(teamYaml, 'utf8');
    expect(written).toContain('name: test-agent');
    expect(written).toContain('description:');
    expect(written).toContain('instructions:');
  });
});

// ─── AgentsHandler.pullItem — multi-target ───────────────────────────────────

describe('AgentsHandler.pullItem — multi-target', () => {
  let tmpDir: string;
  let homeDir: string;
  let repoPath: string;
  let handler: AgentsHandler;
  let localConfig: LocalConfig;

  beforeEach(async () => {
    tmpDir = await fse.mkdtemp(path.join(os.tmpdir(), 'teamai-agents-pull-test-'));
    homeDir = path.join(tmpDir, 'home');
    repoPath = path.join(tmpDir, 'team-repo');

    await fse.ensureDir(path.join(repoPath, 'agents'));
    await fse.ensureDir(path.join(homeDir, '.claude', 'agents'));
    await fse.ensureDir(path.join(homeDir, '.codex'));

    vi.stubEnv('HOME', homeDir);

    handler = new AgentsHandler();
    localConfig = {
      repo: { localPath: repoPath, remote: 'https://example.com' },
      username: 'testuser',
      additionalRoles: [],
      scope: 'user',
    };
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fse.remove(tmpDir);
  });

  it('deploys only to spec.targets=[claude, codex] with correct extensions', async () => {
    const spec: AgentSpec = makeSpec({
      targets: ['claude', 'codex'] as ToolName[],
      model: 'claude-haiku',
    });
    const yamlContent = serializeAgentYaml(spec);
    const yamlPath = path.join(repoPath, 'agents', 'test-agent.yaml');
    await fse.writeFile(yamlPath, yamlContent);

    // Create .codex/agents directory (marks codex as installed)
    await fse.ensureDir(path.join(homeDir, '.codex', 'agents'));

    const teamConfig = buildTeamConfig({
      claude: { skills: '.claude/skills', agents: '.claude/agents' },
      codex: { skills: '.codex/skills', agents: '.codex/agents' },
      cursor: { skills: '.cursor/skills', agents: '.cursor/agents' },
    });

    await handler.pullItem(
      { name: 'test-agent', type: 'agents', sourcePath: yamlPath, relativePath: 'agents/test-agent.yaml' },
      teamConfig,
      localConfig,
    );

    // claude: .md
    expect(await fse.pathExists(path.join(homeDir, '.claude', 'agents', 'test-agent.md'))).toBe(true);
    // codex: .toml
    expect(await fse.pathExists(path.join(homeDir, '.codex', 'agents', 'test-agent.toml'))).toBe(true);
    // cursor: not in targets, should not be created
    expect(await fse.pathExists(path.join(homeDir, '.cursor', 'agents', 'test-agent.md'))).toBe(false);
  });

  it('legacy .md items are copied only to claude/codebuddy/claude-internal', async () => {
    const mdPath = path.join(repoPath, 'agents', 'legacy.md');
    await fse.writeFile(mdPath, '# legacy agent');

    await fse.ensureDir(path.join(homeDir, '.codebuddy', 'agents'));
    await fse.ensureDir(path.join(homeDir, '.codex', 'agents'));

    const teamConfig = buildTeamConfig({
      claude: { skills: '.claude/skills', agents: '.claude/agents' },
      codebuddy: { skills: '.codebuddy/skills', agents: '.codebuddy/agents' },
      codex: { skills: '.codex/skills', agents: '.codex/agents' },
    });

    await handler.pullItem(
      { name: 'legacy', type: 'agents', sourcePath: mdPath, relativePath: 'agents/legacy.md', legacy: true } as AgentResourceItem,
      teamConfig,
      localConfig,
    );

    expect(await fse.pathExists(path.join(homeDir, '.claude', 'agents', 'legacy.md'))).toBe(true);
    expect(await fse.pathExists(path.join(homeDir, '.codebuddy', 'agents', 'legacy.md'))).toBe(true);
    // codex is not a legacy target
    expect(await fse.pathExists(path.join(homeDir, '.codex', 'agents', 'legacy.md'))).toBe(false);
  });
});
