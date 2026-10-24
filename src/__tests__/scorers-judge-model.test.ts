import { describe, expect, it } from 'vitest';
import { chooseJudgeModel } from '../scorers/judge-model.js';
import { localAliasesPath, type ModelAliases } from '../models/aliases.js';

const aliases = (patch: Partial<Extract<ModelAliases, { ok: true }>> = {}): ModelAliases => ({
  ok: true, names: new Set(['strong']), team: new Map(), local: new Map(), inactive: new Map(), warnings: [], switches: {}, ...patch,
});
const scorer = (model?: string) => ({ name: 'quality', ...(model !== undefined ? { model } : {}) });

describe('judge model policy', () => {
  it('uses the first declared tool that resolves the scorer alias, and keeps the alias', () => {
    const loaded = aliases({ team: new Map([['strong', { source: 'models/aliases.yaml', entries: { claude: 'sonnet' } }]]) });
    expect(chooseJudgeModel(loaded, scorer('strong'), ['codex', 'claude'])).toEqual({
      ok: true, choice: { tool: 'claude', model: { name: 'sonnet' }, by: 'scorer', alias: 'strong' },
    });
  });
  it('keeps a member-selected local or switched default, with the alias and why', () => {
    expect(chooseJudgeModel(aliases({ local: new Map([['strong', { claude: null }]]) }), scorer('strong'), ['claude'])).toEqual({
      ok: true, choice: { tool: 'claude', by: 'tool_default', noModel: 'local', alias: 'strong' },
      note: `Scorer "quality" asks for model alias "strong", which ${localAliasesPath()} turns off for claude, so claude judges with its default model.`,
    });
    expect(chooseJudgeModel(aliases({ team: new Map([['strong', { source: 'models/aliases.yaml', entries: { codex: 'gpt-6' } }]]), switches: { codex: { ok: true, switched: true } } }), scorer('strong'), ['codex']))
      .toEqual({
        ok: true, choice: { tool: 'codex', by: 'tool_default', noModel: 'switched', alias: 'strong' },
        note: 'Scorer "quality" asks for model alias "strong", which gives no model for codex while teamai models switch points codex at a model profile, so codex judges with its default model.',
      });
    expect(chooseJudgeModel(aliases(), scorer(), ['opencode'])).toEqual({ ok: true, choice: { tool: 'opencode', by: 'tool_default' } });
  });
  it('fails an alias no tool maps, or that cannot be resolved, saying which and where', () => {
    expect(chooseJudgeModel(aliases(), scorer('strong'), ['claude', 'codex'])).toEqual({
      ok: false, code: 'judge_model_unavailable', reason: 'unmapped',
      message: 'Scorer "quality" asks for model alias "strong", which has no model for claude, codex in models/aliases.yaml. Add one, or remove model from the scorer.',
    });
    expect(chooseJudgeModel({ ok: false, reason: 'broken YAML' }, scorer('strong'), ['claude'])).toEqual({
      ok: false, code: 'judge_model_unavailable', reason: 'unresolved',
      message: 'Scorer "quality" asks for model alias "strong", which cannot be resolved for claude: broken YAML. Fix that, or remove model from the scorer.',
    });
  });
  it('gives a CodeBuddy judge no effort, which its launch cannot pass', () => {
    const loaded = aliases({ team: new Map([['strong', { source: 'models/aliases.yaml', entries: { codebuddy: { model: 'glm-5', effort: 'high' }, claude: { model: 'opus', effort: 'high' } } }]]) });
    expect(chooseJudgeModel(loaded, scorer('strong'), ['codebuddy'])).toMatchObject({ ok: true, choice: { tool: 'codebuddy', model: { name: 'glm-5' } } });
    expect(chooseJudgeModel(loaded, scorer('strong'), ['codebuddy'])).not.toMatchObject({ choice: { model: { effort: expect.anything() } } });
    expect(chooseJudgeModel(loaded, scorer('strong'), ['claude'])).toMatchObject({ ok: true, choice: { model: { name: 'opus', effort: 'high' } } });
  });
});
