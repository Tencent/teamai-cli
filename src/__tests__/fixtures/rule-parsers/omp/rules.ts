/**
 * Oh My Pi's rule parser, vendored so teamai's OMP render is read back by the
 * code that reads it (#946). Source: @oh-my-pi/pi-coding-agent and
 * @oh-my-pi/pi-utils 18.2.1 (https://github.com/can1357/oh-my-pi):
 *
 *   parseFrontmatter          pi-utils/src/frontmatter.ts
 *   loadRulesDir              coding-agent/src/discovery/builtin.ts (loadRules) + helpers.ts (loadFilesFromDir)
 *   buildRule, discoverRuleFromMarkdown  coding-agent/src/discovery/helpers.ts
 *   parseRuleConditionAndScope, parseRuleAgents  coding-agent/src/capability/rule.ts
 *   bucketRules               coding-agent/src/capability/rule-buckets.ts
 *
 * Changes from the source, all needed to run outside Bun: Bun's `YAML.parse`
 * is the `yaml` package's; the native `glob` that lists a rules directory is
 * `readdirSync` with the same non-recursive `*.{md,mdc}` pattern, hidden
 * files skipped; `Bun.Glob` in `ruleAppliesToAgent` is an exact match (teamai
 * writes no `agents`); the TTSR manager is an interface that never accepts a
 * rule (teamai writes no `condition`); the frontmatter warning is dropped.
 * Update it from a new OMP release by re-copying these functions.
 *
 * MIT License
 *
 * Copyright (c) 2025 Mario Zechner
 * Copyright (c) 2025-2026 Can Bölük
 * Copyright (c) 2026 Stencil Labs, Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

export interface Rule {
  name: string;
  path: string;
  content: string;
  globs?: string[];
  alwaysApply?: boolean;
  description?: string;
  condition?: string[];
  astCondition?: string[];
  scope?: string[];
  agents?: string[];
  interruptMode?: 'never' | 'prose-only' | 'tool-only' | 'always';
}

type RuleFrontmatter = Record<string, unknown>;

// ─── pi-utils/src/frontmatter.ts ─────────────────────────────────────────

function stripHtmlComments(content: string): string {
  return content.replace(/<!--[\s\S]*?-->/g, '');
}

function kebabToCamel(key: string): string {
  if (!key.includes('-')) return key;
  return key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

function normalizeFrontmatterKeys<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) {
    let changed = false;
    const out: unknown[] = Array.from({ length: obj.length });
    for (let i = 0; i < obj.length; i++) {
      const v: unknown = obj[i];
      const nv = normalizeFrontmatterKeys(v);
      out[i] = nv;
      if (nv !== v) changed = true;
    }
    return (changed ? (out as unknown) : obj) as T;
  }
  let changed = false;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const nk = key.includes('-') ? kebabToCamel(key) : key;
    const nv = normalizeFrontmatterKeys(value);
    result[nk] = nv;
    if (nk !== key || nv !== value) changed = true;
  }
  return (changed ? result : obj) as T;
}

const PLAIN_SCALAR_KEY_VALUE = /^(\s*[A-Za-z_][\w-]*:\s+)(\S.*?)(\s*)$/;
const FLOW_OR_EXPLICIT_VALUE_START = new Set(['"', "'", '[', '{', '|', '>', '!', '&', '*', '#']);

function quoteAmbiguousPlainScalars(metadata: string): string | undefined {
  let changed = false;
  const lines = metadata.split('\n').map((line) => {
    const match = line.match(PLAIN_SCALAR_KEY_VALUE);
    if (!match) return line;
    const [, prefix, rawValue, suffix] = match;
    const value = rawValue.trimEnd();
    if (!value.includes(': ')) return line;
    if (FLOW_OR_EXPLICIT_VALUE_START.has(value[0])) return line;
    changed = true;
    return `${prefix}${JSON.stringify(value)}${suffix}`;
  });
  return changed ? lines.join('\n') : undefined;
}

function parseYamlRecord(metadata: string, repairTabs: boolean): Record<string, unknown> | null {
  const loaded: unknown = YAML.parse(repairTabs ? metadata.replaceAll('\t', '  ') : metadata);
  if (loaded === null || loaded === undefined) return null;
  if (typeof loaded !== 'object' || Array.isArray(loaded)) return null;
  return loaded as Record<string, unknown>;
}

export function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const frontmatter: Record<string, unknown> = {};

  const newlineNormalized = content.replace(/\r\n?/g, '\n');
  const normalized = stripHtmlComments(newlineNormalized);
  if (!normalized.startsWith('---')) {
    return { frontmatter, body: normalized };
  }

  const endIndex = normalized.indexOf('\n---', 3);
  if (endIndex === -1) {
    return { frontmatter, body: normalized };
  }

  const metadata = normalized.slice(4, endIndex);
  const body = normalized.slice(endIndex + 4).trim();

  try {
    const loaded = parseYamlRecord(metadata, true);
    return { frontmatter: normalizeFrontmatterKeys({ ...frontmatter, ...loaded }), body };
  } catch {
    const quotedMetadata = quoteAmbiguousPlainScalars(metadata);
    if (quotedMetadata) {
      try {
        const loaded = parseYamlRecord(quotedMetadata, true);
        return { frontmatter: normalizeFrontmatterKeys({ ...frontmatter, ...loaded }), body };
      } catch {
        // Fall through to the simple key/value fallback.
      }
    }

    for (const line of metadata.split('\n')) {
      const match = line.match(/^([\w-]+):\s*(.*)$/);
      if (!match) continue;
      const raw = match[2].trim();
      let value: unknown = raw;
      if (raw.length > 0) {
        try {
          const parsed: unknown = YAML.parse(raw);
          if (parsed !== null && typeof parsed !== 'object') value = parsed;
          else if (Array.isArray(parsed)) value = parsed;
        } catch {
          // keep the raw string
        }
      }
      frontmatter[match[1]] = value;
    }

    return { frontmatter: normalizeFrontmatterKeys(frontmatter), body };
  }
}

// ─── coding-agent/src/capability/rule.ts ─────────────────────────────────

const CONDITION_GLOB_SCOPE_TOOLS = ['edit', 'write'] as const;

function normalizeRuleField(value: unknown): string[] | undefined {
  if (typeof value === 'string') {
    const token = value.trim();
    return token.length > 0 ? [token] : undefined;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }

  const tokens = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (tokens.length === 0) {
    return undefined;
  }

  return Array.from(new Set(tokens));
}

function splitScopeTokens(value: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (quote) {
      current += char;
      if (char === quote && value[i - 1] !== '\\') {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === '(') {
      parenDepth++;
      current += char;
      continue;
    }
    if (char === ')') {
      parenDepth = Math.max(0, parenDepth - 1);
      current += char;
      continue;
    }
    if (char === '[') {
      bracketDepth++;
      current += char;
      continue;
    }
    if (char === ']') {
      bracketDepth = Math.max(0, bracketDepth - 1);
      current += char;
      continue;
    }
    if (char === '{') {
      braceDepth++;
      current += char;
      continue;
    }
    if (char === '}') {
      braceDepth = Math.max(0, braceDepth - 1);
      current += char;
      continue;
    }
    if (char === ',' && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      const token = current.trim();
      if (token.length > 0) {
        tokens.push(token);
      }
      current = '';
      continue;
    }
    current += char;
  }

  const tail = current.trim();
  if (tail.length > 0) {
    tokens.push(tail);
  }

  return tokens;
}

function normalizeScopeField(value: unknown): string[] | undefined {
  const normalized = normalizeRuleField(value);
  if (!normalized) {
    return undefined;
  }

  const tokens = normalized
    .flatMap(splitScopeTokens)
    .map((token) => {
      const quote = token[0];
      if (token.length >= 2 && (quote === '"' || quote === "'") && token[token.length - 1] === quote) {
        return token.slice(1, -1).trim();
      }
      return token;
    })
    .filter((item) => item.length > 0);
  if (tokens.length === 0) {
    return undefined;
  }
  return Array.from(new Set(tokens));
}

function parseRuleAgents(value: unknown): string[] | undefined {
  const tokens = normalizeScopeField(value);
  if (!tokens) {
    return undefined;
  }
  return Array.from(new Set(tokens.map((token) => token.replace(/\s*,\s*/g, ',').toLowerCase())));
}

function ruleAppliesToAgent(rule: Pick<Rule, 'agents'>, agentName: string | undefined): boolean {
  const patterns = rule.agents;
  if (!patterns || patterns.length === 0 || agentName === undefined) {
    return true;
  }
  const name = agentName.trim().toLowerCase();
  // Source: `pattern === name || new Bun.Glob(pattern).match(name)`.
  return patterns.some((pattern) => pattern === name);
}

function isLikelyFileGlob(value: string): boolean {
  const token = value.trim();
  if (token.length === 0) {
    return false;
  }
  if (/[\\^$+|()]/.test(token)) {
    return false;
  }
  if (!/[?*[\]{}]/.test(token)) {
    return false;
  }
  if (token.includes('/')) {
    return true;
  }
  return /^\*\.[^\s/]+$/.test(token);
}

function parseRuleConditionAndScope(frontmatter: RuleFrontmatter): Pick<Rule, 'condition' | 'astCondition' | 'scope'> {
  const rawCondition = frontmatter.condition ?? frontmatter.ttsr_trigger ?? frontmatter.ttsrTrigger;
  const parsedCondition = normalizeRuleField(rawCondition);
  const astCondition = normalizeRuleField(frontmatter.astCondition);
  const parsedScope = normalizeScopeField(frontmatter.scope);

  const inferredScope: string[] = [];
  const condition: string[] = [];
  for (const token of parsedCondition ?? []) {
    if (isLikelyFileGlob(token)) {
      for (const toolName of CONDITION_GLOB_SCOPE_TOOLS) {
        inferredScope.push(`tool:${toolName}(${token})`);
      }
      continue;
    }
    condition.push(token);
  }

  if (condition.length === 0 && inferredScope.length > 0) {
    condition.push('.*');
  }

  const scope = [...(parsedScope ?? []), ...inferredScope];
  return {
    condition: condition.length > 0 ? Array.from(new Set(condition)) : undefined,
    astCondition,
    scope: scope.length > 0 ? Array.from(new Set(scope)) : undefined,
  };
}

// ─── coding-agent/src/discovery/helpers.ts ───────────────────────────────

function buildRule(name: string, body: string, frontmatter: RuleFrontmatter, filePath: string): Rule {
  const { condition, astCondition, scope } = parseRuleConditionAndScope(frontmatter);

  let globs: string[] | undefined;
  if (Array.isArray(frontmatter.globs)) {
    globs = frontmatter.globs.filter((item): item is string => typeof item === 'string');
  } else if (typeof frontmatter.globs === 'string') {
    globs = [frontmatter.globs];
  }

  const resolvedName = name.replace(/\.(md|mdc)$/, '');
  const rawMode = frontmatter.interruptMode;
  const interruptMode: Rule['interruptMode'] = rawMode === 'never' || rawMode === 'prose-only' || rawMode === 'tool-only' || rawMode === 'always'
    ? rawMode
    : undefined;
  return {
    name: resolvedName,
    path: filePath,
    content: body,
    globs,
    alwaysApply: frontmatter.alwaysApply === true,
    description: typeof frontmatter.description === 'string' ? frontmatter.description : undefined,
    condition,
    astCondition,
    scope,
    agents: parseRuleAgents(frontmatter.agents),
    interruptMode,
  };
}

export function discoverRuleFromMarkdown(name: string, content: string, filePath: string): Rule | null {
  const { frontmatter, body } = parseFrontmatter(content);
  if (frontmatter.enabled === false) return null;
  return buildRule(name, body, frontmatter, filePath);
}

// ─── coding-agent/src/discovery/builtin.ts (loadRules), one rules dir ────

/**
 * The rules OMP loads from one `rules` directory (`.omp/rules`,
 * `~/.omp/agent/rules`): `*.md` and `*.mdc` at its top level only. The
 * capability then drops a rule without content (`ruleCapability.validate`).
 */
export function loadRulesDir(dir: string): Rule[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const rules: Rule[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith('.') || !/\.(md|mdc)$/.test(entry.name)) continue;
    const filePath = path.join(dir, entry.name);
    const rule = discoverRuleFromMarkdown(entry.name, fs.readFileSync(filePath, 'utf8'), filePath);
    if (rule && rule.content) rules.push(rule);
  }
  return rules;
}

// ─── coding-agent/src/capability/rule-buckets.ts ─────────────────────────

interface TtsrManager {
  addRule(rule: Rule): boolean;
}

export interface RuleBuckets {
  rulebookRules: Rule[];
  alwaysApplyRules: Rule[];
}

/**
 * Split the rules into the always-apply ones (their text in the system
 * prompt) and the rulebook (listed by name, globs and description, read on
 * demand); a rule in neither is dropped. TTSR rules are registered, not
 * bucketed.
 */
export function bucketRules(
  rules: readonly Rule[],
  ttsrManager: TtsrManager = { addRule: () => false },
  options: { agentName?: string } = { agentName: 'main' },
): RuleBuckets {
  const includedRules: Rule[] = [];
  for (const rule of rules) {
    if (!ruleAppliesToAgent(rule, options.agentName)) continue;
    includedRules.push(rule);
  }

  const rulebookRules: Rule[] = [];
  const alwaysApplyRules: Rule[] = [];

  for (const rule of includedRules) {
    const hasTtsrCondition = (rule.condition && rule.condition.length > 0) || (rule.astCondition && rule.astCondition.length > 0);
    const isTtsrRule = hasTtsrCondition ? ttsrManager.addRule(rule) : false;
    if (isTtsrRule) continue;
    if (rule.alwaysApply === true) {
      alwaysApplyRules.push(rule);
      continue;
    }
    if (rule.description) {
      rulebookRules.push(rule);
    }
  }

  return { rulebookRules, alwaysApplyRules };
}
