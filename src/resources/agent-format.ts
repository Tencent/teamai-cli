import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import matter from 'gray-matter';
import { stringify as stringifyToml, parse as parseToml } from 'smol-toml';

// ─── Tool name type ──────────────────────────────────────────────────────────

export type ToolName = 'claude' | 'claude-internal' | 'tclaude' | 'codebuddy' | 'codex' | 'codex-internal' | 'tcodex' | 'cursor';

export const ALL_SUPPORTED_TOOLS: ToolName[] = [
  'claude',
  'claude-internal',
  'tclaude',
  'codebuddy',
  'codex',
  'codex-internal',
  'tcodex',
  'cursor',
];

// ─── Intermediate format ─────────────────────────────────────────────────────

/**
 * Intermediate YAML representation of a subagent definition.
 * This is the canonical format stored in the team repo (agents/<name>.yaml).
 * Each tool renderer translates this into its native format.
 */
export interface AgentSpec {
  /** Agent name, must match the YAML filename stem. */
  name: string;
  /** Single-line description shown in tool UI. */
  description: string;
  /** Main prompt / instructions body (multi-line). */
  instructions: string;
  /** Optional model override. */
  model?: string;
  /** Optional tool whitelist (claude / codebuddy / cursor use this). */
  tools?: string[];
  /**
   * Per-tool private fields that are not part of the common schema.
   * Passed through verbatim when rendering for the matching tool,
   * and collected when reversing from a tool's native format.
   */
  tool_extras?: {
    claude?: Record<string, unknown>;
    'claude-internal'?: Record<string, unknown>;
    tclaude?: Record<string, unknown>;
    codebuddy?: Record<string, unknown>;
    codex?: Record<string, unknown>;
    'codex-internal'?: Record<string, unknown>;
    tcodex?: Record<string, unknown>;
    cursor?: Record<string, unknown>;
  };
  /**
   * Which tools this agent should be deployed to.
   * When undefined, the agent is deployed to ALL installed supported tools.
   */
  targets?: ToolName[];
}

// ─── Parse intermediate YAML ─────────────────────────────────────────────────

/**
 * Result type for parseAgentYaml — avoids throwing on bad input.
 */
export type ParseResult =
  | { ok: true; spec: AgentSpec }
  | { ok: false; reason: string };

/**
 * Parse a team-repo YAML file into an AgentSpec.
 *
 * Returns a ParseResult instead of throwing, so a single malformed file
 * does not abort the entire pull operation.
 *
 * @param content  - Raw YAML string content.
 * @param filename - Filename used for error messages.
 * @returns ParseResult — ok=true with spec on success, ok=false with reason on failure.
 */
export function parseAgentYaml(content: string, filename: string): ParseResult {
  let raw: unknown;
  try {
    raw = parseYaml(content);
  } catch (err) {
    return { ok: false, reason: `${filename} parse error: ${(err as Error).message}` };
  }

  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, reason: `${filename} must be a YAML object` };
  }

  const obj = raw as Record<string, unknown>;

  for (const field of ['name', 'description', 'instructions'] as const) {
    if (!obj[field] || typeof obj[field] !== 'string' || (obj[field] as string).trim() === '') {
      return { ok: false, reason: `${filename} missing required field ${field}` };
    }
  }

  return {
    ok: true,
    spec: {
      name: obj['name'] as string,
      description: obj['description'] as string,
      instructions: obj['instructions'] as string,
      ...(obj['model'] !== undefined ? { model: obj['model'] as string } : {}),
      ...(obj['tools'] !== undefined ? { tools: obj['tools'] as string[] } : {}),
      ...(obj['tool_extras'] !== undefined ? { tool_extras: obj['tool_extras'] as AgentSpec['tool_extras'] } : {}),
      ...(obj['targets'] !== undefined ? { targets: obj['targets'] as ToolName[] } : {}),
    },
  };
}

// ─── Serialize intermediate YAML ─────────────────────────────────────────────

/**
 * Serialize an AgentSpec back to canonical team-repo YAML format.
 *
 * @param spec - The AgentSpec to serialize.
 * @returns YAML string.
 */
export function serializeAgentYaml(spec: AgentSpec): string {
  return stringifyYaml(spec, { lineWidth: 120 });
}

// ─── Render: AgentSpec → tool-native format ───────────────────────────────────

/** Result of rendering an AgentSpec for a specific tool. */
export interface RenderResult {
  ext: '.md' | '.toml';
  content: string;
}

/**
 * Render an AgentSpec for Claude / Claude Code.
 * Output: YAML frontmatter (.md) with optional model/tools and tool_extras.claude fields.
 */
export function renderForClaude(spec: AgentSpec): RenderResult {
  return { ext: '.md', content: renderMarkdownAgent(spec, spec.tool_extras?.['claude']) };
}

/**
 * Render an AgentSpec for Claude Internal.
 * Same format as Claude — YAML frontmatter + body.
 */
export function renderForClaudeInternal(spec: AgentSpec): RenderResult {
  return { ext: '.md', content: renderMarkdownAgent(spec, spec.tool_extras?.['claude-internal']) };
}

/**
 * Render an AgentSpec for CodeBuddy.
 * Same format as Claude, but merges tool_extras.codebuddy into frontmatter.
 */
export function renderForCodebuddy(spec: AgentSpec): RenderResult {
  return { ext: '.md', content: renderMarkdownAgent(spec, spec.tool_extras?.['codebuddy']) };
}

/**
 * Render an AgentSpec for Codex.
 * Output: TOML with developer_instructions and flattened tool_extras.codex fields.
 */
export function renderForCodex(spec: AgentSpec): RenderResult {
  return { ext: '.toml', content: renderTomlAgent(spec, spec.tool_extras?.['codex']) };
}

/**
 * Render an AgentSpec for Codex Internal.
 * Same format as Codex — TOML with developer_instructions.
 */
export function renderForCodexInternal(spec: AgentSpec): RenderResult {
  return { ext: '.toml', content: renderTomlAgent(spec, spec.tool_extras?.['codex-internal']) };
}

/**
 * Render an AgentSpec for Cursor.
 * Output: YAML frontmatter (.md) using agent_id instead of name.
 */
export function renderForCursor(spec: AgentSpec): RenderResult {
  const frontmatterData: Record<string, unknown> = {
    agent_id: spec.name,
    description: spec.description,
  };
  if (spec.tools !== undefined && spec.tools.length > 0) {
    frontmatterData['tools'] = spec.tools;
  }
  // Flatten tool_extras.cursor into frontmatter
  const extras = spec.tool_extras?.['cursor'];
  if (extras) {
    for (const [key, value] of Object.entries(extras)) {
      frontmatterData[key] = value;
    }
  }
  const content = matter.stringify(spec.instructions, frontmatterData);
  return { ext: '.md', content };
}

// ─── Internal render helpers ─────────────────────────────────────────────────

/**
 * Build a gray-matter .md file: YAML frontmatter (name/description/model?/tools?/extras) + body.
 */
function renderMarkdownAgent(spec: AgentSpec, extras?: Record<string, unknown>): string {
  const frontmatterData: Record<string, unknown> = {
    name: spec.name,
    description: spec.description,
  };
  if (spec.model !== undefined) {
    frontmatterData['model'] = spec.model;
  }
  if (spec.tools !== undefined && spec.tools.length > 0) {
    frontmatterData['tools'] = spec.tools;
  }
  // Flatten tool-private extras into frontmatter
  if (extras) {
    for (const [key, value] of Object.entries(extras)) {
      frontmatterData[key] = value;
    }
  }
  return matter.stringify(spec.instructions, frontmatterData);
}

/**
 * Build a smol-toml TOML file: name/description/developer_instructions/model?/extras.
 * Note: `tools` is intentionally omitted from TOML output — Codex uses mcp_servers instead.
 */
function renderTomlAgent(spec: AgentSpec, extras?: Record<string, unknown>): string {
  const tomlData: Record<string, unknown> = {
    name: spec.name,
    description: spec.description,
    developer_instructions: spec.instructions,
  };
  if (spec.model !== undefined) {
    tomlData['model'] = spec.model;
  }
  // Flatten tool-private extras into top-level TOML fields
  if (extras) {
    for (const [key, value] of Object.entries(extras)) {
      tomlData[key] = value;
    }
  }
  return stringifyToml(tomlData);
}

// ─── Reverse: tool-native format → AgentSpec ────────────────────────────────

/** Result of reversing a tool-native agent file. */
export type ReverseResult =
  | { ok: true; spec: AgentSpec }
  | { ok: false; reason: string };

/** Common fields that belong in the AgentSpec root (not tool_extras). */
const COMMON_CLAUDE_FIELDS = new Set(['name', 'description', 'model', 'tools']);
const COMMON_CURSOR_FIELDS = new Set(['agent_id', 'description', 'model', 'tools']);
const COMMON_CODEX_FIELDS = new Set(['name', 'description', 'developer_instructions', 'model']);

/**
 * Reverse a Claude-format .md file into an AgentSpec.
 * claude-internal reuses this same function.
 *
 * @param filePath - Absolute path, used to derive the agent name.
 * @param content  - File content string.
 */
export function reverseFromClaude(filePath: string, content: string): ReverseResult {
  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(content);
  } catch (err) {
    return { ok: false, reason: `parse error: ${(err as Error).message}` };
  }

  const fm = parsed.data as Record<string, unknown>;
  const body = parsed.content.trim();

  const name = (fm['name'] as string | undefined) ?? path.basename(filePath, '.md');
  if (!name) return { ok: false, reason: 'missing field name' };
  if (!fm['description']) return { ok: false, reason: 'missing field description' };
  if (!body) return { ok: false, reason: 'missing field instructions (empty body)' };

  // Collect non-common frontmatter fields as tool_extras
  const extras: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fm)) {
    if (!COMMON_CLAUDE_FIELDS.has(key)) {
      extras[key] = value;
    }
  }

  const spec: AgentSpec = {
    name,
    description: fm['description'] as string,
    instructions: body,
  };
  if (fm['model'] !== undefined) spec.model = fm['model'] as string;
  if (fm['tools'] !== undefined) spec.tools = fm['tools'] as string[];
  if (Object.keys(extras).length > 0) spec.tool_extras = { claude: extras };

  return { ok: true, spec };
}

/**
 * Reverse a CodeBuddy-format .md file into an AgentSpec.
 * Format is identical to Claude, but tool_extras key is 'codebuddy'.
 */
export function reverseFromCodebuddy(filePath: string, content: string): ReverseResult {
  const result = reverseFromClaude(filePath, content);
  if (!result.ok) return result;

  const spec = result.spec;
  // Move extras from 'claude' to 'codebuddy'
  if (spec.tool_extras?.['claude']) {
    spec.tool_extras = { codebuddy: spec.tool_extras['claude'] };
  }
  return { ok: true, spec };
}

/**
 * Reverse a Codex-format .toml file into an AgentSpec.
 * codex-internal reuses this same function.
 *
 * @param filePath - Absolute path, used to derive the agent name.
 * @param content  - File content string.
 */
export function reverseFromCodex(filePath: string, content: string): ReverseResult {
  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(content) as Record<string, unknown>;
  } catch (err) {
    return { ok: false, reason: `parse error: ${(err as Error).message}` };
  }

  const name = (parsed['name'] as string | undefined) ?? path.basename(filePath, '.toml');
  if (!name) return { ok: false, reason: 'missing field name' };
  if (!parsed['description']) return { ok: false, reason: 'missing field description' };
  if (!parsed['developer_instructions']) return { ok: false, reason: 'missing field developer_instructions' };

  // Collect non-common fields as tool_extras
  const extras: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!COMMON_CODEX_FIELDS.has(key)) {
      extras[key] = value;
    }
  }

  const spec: AgentSpec = {
    name,
    description: parsed['description'] as string,
    instructions: parsed['developer_instructions'] as string,
  };
  if (parsed['model'] !== undefined) spec.model = parsed['model'] as string;
  if (Object.keys(extras).length > 0) spec.tool_extras = { codex: extras };

  return { ok: true, spec };
}

/**
 * Reverse a Cursor-format .md file into an AgentSpec.
 * Uses agent_id instead of name in the frontmatter.
 */
export function reverseFromCursor(filePath: string, content: string): ReverseResult {
  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(content);
  } catch (err) {
    return { ok: false, reason: `parse error: ${(err as Error).message}` };
  }

  const fm = parsed.data as Record<string, unknown>;
  const body = parsed.content.trim();

  const name = (fm['agent_id'] as string | undefined) ?? path.basename(filePath, '.md');
  if (!name) return { ok: false, reason: 'missing field agent_id' };
  if (!fm['description']) return { ok: false, reason: 'missing field description' };
  if (!body) return { ok: false, reason: 'missing field instructions (empty body)' };

  // Collect non-common frontmatter fields as tool_extras
  const extras: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fm)) {
    if (!COMMON_CURSOR_FIELDS.has(key)) {
      extras[key] = value;
    }
  }

  const spec: AgentSpec = {
    name,
    description: fm['description'] as string,
    instructions: body,
  };
  if (fm['model'] !== undefined) spec.model = fm['model'] as string;
  if (fm['tools'] !== undefined) spec.tools = fm['tools'] as string[];
  if (Object.keys(extras).length > 0) spec.tool_extras = { cursor: extras };

  return { ok: true, spec };
}

// ─── Merge multi-tool reverse results ───────────────────────────────────────

/** Conflict details when merging results from multiple tools. */
export interface MergeConflict {
  field: string;
  values: Record<string, unknown>;
}

/** Result of merging multiple tool AgentSpecs into one canonical AgentSpec. */
export type MergeResult =
  | { ok: true; spec: AgentSpec }
  | { ok: false; conflicts: MergeConflict[] };

/** Common fields subject to conflict detection during merge. */
const MERGE_COMMON_FIELDS: Array<keyof AgentSpec> = [
  'name',
  'description',
  'instructions',
  'model',
  'tools',
];

/**
 * Merge AgentSpec results from multiple tools into a single canonical AgentSpec.
 *
 * Common fields (name, description, instructions, model, tools) are compared
 * across tools — any discrepancy is reported as a conflict.
 * Tool-private fields (tool_extras) are merged by union, as they are independent.
 *
 * @param perTool - Map of tool name → AgentSpec (only successful reverses included).
 * @returns Merged spec if all common fields agree, or conflict details otherwise.
 */
export function mergeReverseResults(
  perTool: Partial<Record<ToolName, AgentSpec>>,
): MergeResult {
  const entries = Object.entries(perTool) as Array<[ToolName, AgentSpec]>;
  if (entries.length === 0) {
    return { ok: false, conflicts: [{ field: 'all', values: {} }] };
  }
  if (entries.length === 1) {
    return { ok: true, spec: entries[0][1] };
  }

  const conflicts: MergeConflict[] = [];

  // Check each common field for discrepancies
  for (const field of MERGE_COMMON_FIELDS) {
    const valuesByTool: Record<string, unknown> = {};
    for (const [tool, spec] of entries) {
      const value = spec[field];
      if (value !== undefined) {
        valuesByTool[tool] = value;
      }
    }
    if (Object.keys(valuesByTool).length === 0) continue;

    // Normalize: convert to JSON for deep comparison
    const uniqueValues = new Set(Object.values(valuesByTool).map((v) => JSON.stringify(v)));
    if (uniqueValues.size > 1) {
      conflicts.push({ field, values: valuesByTool });
    }
  }

  if (conflicts.length > 0) {
    return { ok: false, conflicts };
  }

  // All common fields agree — pick values from first spec, merge tool_extras
  const baseSpec = { ...entries[0][1] };
  const mergedExtras: AgentSpec['tool_extras'] = {};

  for (const [, spec] of entries) {
    if (spec.tool_extras) {
      for (const [toolKey, extras] of Object.entries(spec.tool_extras) as Array<[ToolName, Record<string, unknown>]>) {
        if (!mergedExtras[toolKey]) {
          mergedExtras[toolKey] = {};
        }
        Object.assign(mergedExtras[toolKey]!, extras);
      }
    }
  }

  if (Object.keys(mergedExtras).length > 0) {
    baseSpec.tool_extras = mergedExtras;
  }

  return { ok: true, spec: baseSpec };
}

// ─── Dispatch helpers ─────────────────────────────────────────────────────────

/**
 * Render an AgentSpec for the specified tool.
 *
 * @param spec - The agent specification.
 * @param tool - Target tool name.
 * @returns Rendered file extension and content.
 */
export function renderForTool(spec: AgentSpec, tool: ToolName): RenderResult {
  switch (tool) {
    case 'claude': return renderForClaude(spec);
    case 'claude-internal': return renderForClaudeInternal(spec);
    case 'tclaude': return renderForClaude(spec);
    case 'codebuddy': return renderForCodebuddy(spec);
    case 'codex': return renderForCodex(spec);
    case 'codex-internal': return renderForCodexInternal(spec);
    case 'tcodex': return renderForCodex(spec);
    case 'cursor': return renderForCursor(spec);
  }
}
