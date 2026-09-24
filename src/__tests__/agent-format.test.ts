import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parse as parseToml } from 'smol-toml';
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
  renderForJoycode,
  renderForOpencode,
  reverseFromClaude,
  reverseFromCodebuddy,
  reverseFromCodex,
  reverseFromCursor,
  reverseFromJoycode,
  reverseFromOpencode,
  renderForTool,
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

  // ─── #749: multi-line instructions must stay readable ──────────────────────

  it('emits a multi-line literal string for multi-line instructions', () => {
    const instructions = 'line one\nline two\nline three';
    const { content } = renderForCodex(makeSpec({ instructions }));

    // The rendered file has to keep real newlines — a single escaped `\n` line
    // makes `git diff` on a rendered prompt unreadable and forces the operator
    // to mentally un-escape what the agent will be told.
    expect(content).toContain("developer_instructions = '''");
    expect(content).not.toContain('\\n');
    // Round-trips byte-for-byte: literal strings do no escape processing.
    expect(parseToml(content).developer_instructions).toBe(instructions);
  });

  it('keeps a value that cannot be a literal string on the basic form', () => {
    // A trailing quote closes the literal early, and `'''` inside the body ends
    // it outright — those must fall back rather than emit broken TOML.
    for (const instructions of ["ends with a quote'", "contains ''' inside", 'has a CR\rhere']) {
      const { content } = renderForCodex(makeSpec({ instructions }));
      expect(parseToml(content).developer_instructions).toBe(instructions);
    }
  });

  it('leaves single-line and empty instructions on the basic form', () => {
    const single = renderForCodex(makeSpec({ instructions: 'one line only' }));
    expect(single.content).toContain('developer_instructions = "one line only"');
    expect(single.content).not.toContain("'''");

    const empty = renderForCodex(makeSpec({ instructions: '' }));
    expect(empty.content).toContain('developer_instructions = ""');
  });

  it('applies the same treatment to tool_extras.codex strings', () => {
    const spec = makeSpec({
      instructions: 'single line',
      tool_extras: { codex: { custom_prompt: 'first\nsecond\nthird' } },
    });
    const { content } = renderForCodex(spec);
    expect(content).toContain("custom_prompt = '''");
    expect(parseToml(content).custom_prompt).toBe('first\nsecond\nthird');
  });

  it('keeps $-sequences in a multi-line value verbatim', () => {
    // The substitution must use a function replacement: a string replacement
    // would expand the $-patterns inside the agent-authored prompt. A shell
    // instruction carrying $$ would silently lose a dollar and no longer
    // round-trip.
    const instructions = 'Run this:\n  echo `"$$HOME" && echo "$&done"`';
    const { content } = renderForCodex(makeSpec({ instructions }));
    expect(parseToml(content).developer_instructions).toBe(instructions);
  });

  it('keeps a U+007F DEL value on a form the document still parses from', () => {
    // TOML 1.0 bans DEL from literal strings along with C0, so the literal
    // path must refuse it. smol-toml escapes DEL on the basic form, which is
    // why the rendered agent file still parses and round-trips.
    const instructions = 'line one\nline two\x7fwith DEL';
    const { content } = renderForCodex(makeSpec({ instructions }));
    expect(content).not.toContain("developer_instructions = '''");
    expect(parseToml(content).developer_instructions).toBe(instructions);
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

// ─── renderForJoycode ────────────────────────────────────────────────────────

describe('renderForJoycode', () => {
  it('produces a Markdown agent with common YAML frontmatter', () => {
    const spec = makeSpec({ tools: ['Bash'], tool_extras: { joycode: { color: 'blue' } } });
    const { ext, content } = renderForJoycode(spec);
    expect(ext).toBe('.md');
    expect(content).toContain('name: test-agent');
    expect(content).toContain('description: A test agent');
    expect(content).toContain('- Bash');
    expect(content).toContain('color: blue');
    expect(content).toContain('You are a helpful assistant.');
  });

  it('is available through renderForTool', () => {
    expect(renderForTool(makeSpec(), 'joycode').ext).toBe('.md');
  });

  it('round-trips JoyCode-private frontmatter', () => {
    const content = renderForJoycode(
      makeSpec({ tool_extras: { joycode: { color: 'blue' } } }),
    ).content;
    const result = reverseFromJoycode('/agents/test-agent.md', content);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.tool_extras?.joycode).toEqual({ color: 'blue' });
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

// ─── renderForOpencode ───────────────────────────────────────────────────────

describe('renderForOpencode', () => {
  it('emits description + mode:subagent and omits name', () => {
    const spec = makeSpec();
    const { ext, content } = renderForOpencode(spec);
    expect(ext).toBe('.md');
    expect(content).toContain('description: A test agent for unit tests');
    expect(content).toContain('mode: subagent');
    // OpenCode derives the name from the filename — it must NOT be in frontmatter.
    expect(content).not.toMatch(/^name:/m);
    expect(content).toContain('You are a helpful assistant.');
  });

  it('includes model when present', () => {
    const spec = makeSpec({ model: 'anthropic/claude-sonnet-4' });
    const { content } = renderForOpencode(spec);
    expect(content).toContain('model: anthropic/claude-sonnet-4');
  });

  it('does NOT emit the deprecated tools field', () => {
    const spec = makeSpec({ tools: ['read', 'write'] });
    const { content } = renderForOpencode(spec);
    expect(content).not.toMatch(/^tools:/m);
  });

  it('flattens tool_extras.opencode (permission/temperature) into frontmatter', () => {
    const spec = makeSpec({ tool_extras: { opencode: { temperature: 0.1, permission: { edit: 'deny' } } } });
    const { content } = renderForOpencode(spec);
    expect(content).toContain('temperature: 0.1');
    expect(content).toContain('edit: deny');
  });

  it('renderForTool dispatches opencode to renderForOpencode', () => {
    const spec = makeSpec();
    const viaTool = renderForTool(spec, 'opencode');
    const direct = renderForOpencode(spec);
    expect(viaTool).toEqual(direct);
  });
});

// ─── reverseFromOpencode ─────────────────────────────────────────────────────

describe('reverseFromOpencode', () => {
  it('derives name from filename and reads description', () => {
    const content = `---\ndescription: OpenCode helper\nmode: subagent\n---\nInstructions here\n`;
    const result = reverseFromOpencode('/agents/oc-agent.md', content);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.name).toBe('oc-agent');
    expect(result.spec.description).toBe('OpenCode helper');
  });

  it('collects mode/permission into tool_extras.opencode', () => {
    const content = `---\ndescription: b\nmode: subagent\ntemperature: 0.2\n---\nBody\n`;
    const result = reverseFromOpencode('/agents/a.md', content);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.tool_extras?.['opencode']).toEqual({ mode: 'subagent', temperature: 0.2 });
  });

  it('moves model into the common field, not extras', () => {
    const content = `---\ndescription: b\nmodel: anthropic/claude-sonnet-4\n---\nBody\n`;
    const result = reverseFromOpencode('/agents/a.md', content);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.model).toBe('anthropic/claude-sonnet-4');
    expect(result.spec.tool_extras?.['opencode']).toBeUndefined();
  });

  it('returns error on missing description', () => {
    const content = `---\nmode: subagent\n---\nBody\n`;
    const result = reverseFromOpencode('/agents/a.md', content);
    expect(result.ok).toBe(false);
  });

  it('returns error on empty body', () => {
    const content = `---\ndescription: b\n---\n\n`;
    const result = reverseFromOpencode('/agents/a.md', content);
    expect(result.ok).toBe(false);
  });

  it('round-trips render → reverse preserving common fields', () => {
    const spec = makeSpec({ model: 'anthropic/claude-sonnet-4' });
    const { content } = renderForOpencode(spec);
    const result = reverseFromOpencode('/agents/test-agent.md', content);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.name).toBe('test-agent');
    expect(result.spec.description).toBe(spec.description);
    expect(result.spec.instructions).toBe(spec.instructions);
    expect(result.spec.model).toBe('anthropic/claude-sonnet-4');
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

  it('deploys to JoyCode when included in spec.targets', async () => {
    const spec: AgentSpec = makeSpec({
      targets: ['claude', 'codex', 'joycode'] as ToolName[],
      model: 'claude-haiku',
    });
    const yamlContent = serializeAgentYaml(spec);
    const yamlPath = path.join(repoPath, 'agents', 'test-agent.yaml');
    await fse.writeFile(yamlPath, yamlContent);

    // Create .codex/agents directory (marks codex as installed)
    await fse.ensureDir(path.join(homeDir, '.codex', 'agents'));
    await fse.ensureDir(path.join(homeDir, '.joycode', 'agents'));

    const teamConfig = buildTeamConfig({
      claude: { skills: '.claude/skills', agents: '.claude/agents' },
      codex: { skills: '.codex/skills', agents: '.codex/agents' },
      cursor: { skills: '.cursor/skills', agents: '.cursor/agents' },
      joycode: { skills: '.joycode/skills', agents: '.joycode/agents' },
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
    // joycode: .md
    expect(await fse.pathExists(path.join(homeDir, '.joycode', 'agents', 'test-agent.md'))).toBe(true);
    // cursor: not in targets, should not be created
    expect(await fse.pathExists(path.join(homeDir, '.cursor', 'agents', 'test-agent.md'))).toBe(false);
  });

  it('does not report an untouched JoyCode rendering as modified', async () => {
    const spec = makeSpec({ targets: ['joycode'], tool_extras: { cursor: { composer_mode: true } } });
    const yamlPath = path.join(repoPath, 'agents/test-agent.yaml');
    await fse.writeFile(yamlPath, serializeAgentYaml(spec));
    await fse.ensureDir(path.join(homeDir, '.joycode'));
    const config = buildTeamConfig({ joycode: { agents: '.joycode/agents' } });
    await handler.pullItem({ name: 'test-agent', type: 'agents', sourcePath: yamlPath, relativePath: 'agents/test-agent.yaml' }, config, localConfig);

    expect(await handler.scanLocalForPush(config, localConfig)).toEqual([]);
  });

  it('merges real JoyCode edits without losing canonical targets or other tools metadata', async () => {
    const spec = makeSpec({ targets: ['joycode'], model: 'test-model',
      tool_extras: { joycode: { color: 'blue' }, cursor: { composer_mode: true } } });
    const yamlPath = path.join(repoPath, 'agents/test-agent.yaml');
    await fse.writeFile(yamlPath, serializeAgentYaml(spec) + 'custom_setting: keep\n');
    await fse.ensureDir(path.join(homeDir, '.joycode'));
    const config = buildTeamConfig({ joycode: { agents: '.joycode/agents' }, codex: { agents: '.codex/agents' } });
    const item = { name: 'test-agent', type: 'agents' as const, sourcePath: yamlPath, relativePath: 'agents/test-agent.yaml' };
    await handler.pullItem(item, config, localConfig);
    const edited = { ...spec, instructions: 'Edited prompt.', tool_extras: { joycode: { color: 'red' } } };
    await fse.writeFile(path.join(homeDir, '.joycode/agents/test-agent.md'), renderForJoycode(edited).content);

    const candidates = await handler.scanLocalForPush(config, localConfig);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].skipReason).toBeUndefined();
    await handler.pushItem(candidates[0], config, localConfig);
    expect(await fse.readFile(yamlPath, 'utf-8')).toContain('custom_setting: keep');
    const result = parseAgentYaml(await fse.readFile(yamlPath, 'utf-8'), 'test-agent.yaml');
    expect(result).toEqual({ ok: true, spec: { ...spec, instructions: 'Edited prompt.',
      tool_extras: { ...spec.tool_extras, joycode: { color: 'red' } } } });
    await handler.pullItem(item, config, localConfig);
    expect(await fse.pathExists(path.join(homeDir, '.codex/agents/test-agent.toml'))).toBe(false);
    expect(await handler.scanLocalForPush(config, localConfig)).toEqual([]);
  });

  it.each(['unchanged', 'conflicting', 'invalid'] as const)('handles an %s second tool copy without data loss', async (mode) => {
    const spec = makeSpec({ targets: ['joycode', 'claude'],
      tool_extras: { cursor: { composer_mode: true } } });
    const yamlPath = path.join(repoPath, 'agents/test-agent.yaml');
    const original = serializeAgentYaml(spec);
    await fse.writeFile(yamlPath, original);
    await fse.ensureDir(path.join(homeDir, '.joycode'));
    const config = buildTeamConfig({ joycode: { agents: '.joycode/agents' }, claude: { agents: '.claude/agents' } });
    await handler.pullItem({ name: 'test-agent', type: 'agents', sourcePath: yamlPath, relativePath: 'agents/test-agent.yaml' }, config, localConfig);
    await fse.writeFile(path.join(homeDir, '.joycode/agents/test-agent.md'), renderForJoycode({ ...spec, instructions: 'JoyCode edit.' }).content);
    if (mode !== 'unchanged') {
      await fse.writeFile(path.join(homeDir, '.claude/agents/test-agent.md'), mode === 'invalid' ? 'Not an agent' : renderForClaude({ ...spec, instructions: 'Conflicting edit.' }).content);
    }
    const candidates = await handler.scanLocalForPush(config, localConfig);
    expect(candidates).toHaveLength(1);
    if (mode === 'unchanged') {
      expect(candidates[0].skipReason).toBeUndefined();
      expect(candidates[0].mergedSpec).toEqual({ ...spec, instructions: 'JoyCode edit.' });
    } else {
      expect(candidates[0].skipReason).toBeTruthy();
      await handler.pushItem(candidates[0], config, localConfig);
      expect(await fse.readFile(yamlPath, 'utf-8')).toBe(original);
    }
  });

  it('preserves canonical metadata while removing optional JoyCode fields intentionally', async () => {
    const spec = makeSpec({ targets: ['joycode'], model: 'old-model', tools: ['Read'],
      tool_extras: { joycode: { color: 'blue' }, cursor: { composer_mode: true } } });
    const yamlPath = path.join(repoPath, 'agents/test-agent.yaml');
    await fse.writeFile(yamlPath, serializeAgentYaml(spec));
    await fse.ensureDir(path.join(homeDir, '.joycode/agents'));
    await fse.writeFile(path.join(homeDir, '.joycode/agents/test-agent.md'), renderForJoycode(makeSpec()).content);
    const config = buildTeamConfig({ joycode: { agents: '.joycode/agents' } });
    const candidates = await handler.scanLocalForPush(config, localConfig);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].mergedSpec).toEqual(makeSpec({ targets: ['joycode'], tool_extras: { cursor: { composer_mode: true } } }));
  });

  it.each(['codex', 'cursor', 'opencode'] as const)('retains canonical fields not rendered by %s', async (tool) => {
    const spec = makeSpec({ targets: [tool], model: 'canonical-model', tools: ['Read'],
      tool_extras: { joycode: { color: 'blue' } } });
    const yamlPath = path.join(repoPath, 'agents/test-agent.yaml');
    await fse.writeFile(yamlPath, serializeAgentYaml(spec));
    const config = buildTeamConfig({ [tool]: { agents: `.${tool}/agents` } });
    await fse.ensureDir(path.join(homeDir, `.${tool}`));
    await handler.pullItem({ name: 'test-agent', type: 'agents', sourcePath: yamlPath, relativePath: 'agents/test-agent.yaml' }, config, localConfig);
    expect(await handler.scanLocalForPush(config, localConfig)).toEqual([]);
    const edited = renderForTool({ ...spec, instructions: 'Changed prompt.' }, tool);
    await fse.writeFile(path.join(homeDir, `.${tool}/agents/test-agent${edited.ext}`), edited.content);
    const candidates = await handler.scanLocalForPush(config, localConfig);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].mergedSpec).toEqual({ ...spec, instructions: 'Changed prompt.' });
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
