import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderForTool, reverseByTool } from '../resources/agent-format.js';
import { ensureAgyPluginManifest, removeAgyPluginManifest } from '../resources/agy-plugin.js';
import { renderRuleForTool } from '../resources/rule-format.js';

describe('Antigravity CLI agents', () => {
  const spec = {
    name: 'reviewer',
    description: 'Reviews a diff for bugs',
    instructions: 'Review the change.',
    model: 'sonnet',
    tools: ['Read', 'Bash'],
  };

  it('writes a model resolved for agy, never the team one', () => {
    expect(renderForTool({ ...spec, tools: undefined }, 'agy', { model: 'gemini-3.8-flash-high' }).content)
      .toBe('---\nname: reviewer\ndescription: Reviews a diff for bugs\nmodel: gemini-3.8-flash-high\n---\nReview the change.\n');
  });

  // agy 1.4.8 gives a subagent with no `tools` no run_command, so teamai-recall (Bash, Read, Grep, Glob) could not run `teamai recall`.
  it("lists agy's own names for the Claude tools the agent names, and leaves out those agy has none for", () => {
    const recall = { ...spec, tools: ['Bash', 'Read', 'Grep', 'Glob', 'mcp__jira__search'] };
    expect(renderForTool(recall, 'agy').content).toBe([
      '---', 'name: reviewer', 'description: Reviews a diff for bugs',
      'tools:', '  - run_command', '  - view_file', '  - read_file', '  - grep_search', '  - find_by_name',
      '---', 'Review the change.', '',
    ].join('\n'));
  });

  it("pushes an agy file's own model and tools back as tool_extras.agy", () => {
    const pushed = reverseByTool('agy', 'reviewer.md', '---\nname: reviewer\ndescription: Reviews\nmodel: gemini-3.8-flash-high\ntools: [view_file]\n---\nReview.\n');
    expect(pushed).toEqual({
      ok: true,
      spec: {
        name: 'reviewer',
        description: 'Reviews',
        instructions: 'Review.',
        tool_extras: { agy: { model: 'gemini-3.8-flash-high', tools: ['view_file'] } },
      },
    });
  });
});

describe('Antigravity CLI rules', () => {
  // agy 1.4.8 CLI never shows a `trigger: glob` rule to the model; a model_decision rule it lists with its description.
  it('turns a path-scoped rule into a model_decision rule that names its globs', () => {
    expect(renderRuleForTool('agy', '---\npaths:\n  - "src/**/*.{ts,tsx}"\n---\n\nUse strict types.\n'))
      .toBe('---\ntrigger: model_decision\ndescription: "Applies when reading or editing files matching src/**/*.ts, src/**/*.tsx"\n---\n\nUse strict types.\n');
  });
});

describe('Antigravity CLI project MCP plugin', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-plugin-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('makes the directory a plugin, then takes the manifest and the directory away once emptied', async () => {
    const mcpFile = path.join(dir, 'plugins', 'teamai', 'mcp_config.json');
    fs.mkdirSync(path.dirname(mcpFile), { recursive: true });
    await ensureAgyPluginManifest(mcpFile);
    expect(JSON.parse(fs.readFileSync(path.join(path.dirname(mcpFile), 'plugin.json'), 'utf8'))).toEqual({ name: 'teamai' });
    await removeAgyPluginManifest(mcpFile);
    expect(fs.existsSync(path.join(dir, 'plugins'))).toBe(false);
  });

  it("leaves a plugin.json beside another tool's emptied MCP file", async () => {
    const mcpFile = path.join(dir, 'project', '.mcp.json');
    const manifest = path.join(dir, 'project', 'plugin.json');
    fs.mkdirSync(path.dirname(mcpFile), { recursive: true });
    fs.writeFileSync(manifest, '{"name":"teamai"}');
    await removeAgyPluginManifest(mcpFile);
    expect(fs.readFileSync(manifest, 'utf8')).toBe('{"name":"teamai"}');
  });

  it("keeps a member's own plugin manifest", async () => {
    const mcpFile = path.join(dir, 'plugins', 'teamai', 'mcp_config.json');
    const manifest = path.join(path.dirname(mcpFile), 'plugin.json');
    fs.mkdirSync(path.dirname(mcpFile), { recursive: true });
    fs.writeFileSync(manifest, '{"name":"teamai","description":"mine"}');
    await ensureAgyPluginManifest(mcpFile);
    await removeAgyPluginManifest(mcpFile);
    expect(fs.readFileSync(manifest, 'utf8')).toBe('{"name":"teamai","description":"mine"}');
  });
});
