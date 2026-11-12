// -*- coding: utf-8 -*-
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parsePromotionThresholds, resolvePromotionThresholds } from '../maintenance/promotion-thresholds.js';
import { DEFAULT_PROMOTION_THRESHOLDS } from '../maintenance/promote.js';
import { syncScorersThenWorkflows } from '../scorers/team-sync.js';
import type { LocalConfig } from '../types.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function testConfig(): LocalConfig {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'teamai-promotion-thresholds-'));
  dirs.push(root);
  const knowledge = path.join(root, 'knowledge');
  fs.mkdirSync(path.join(knowledge, 'workflows'), { recursive: true });

  return {
    repo: { localPath: knowledge, remote: 'local', kind: 'self' },
    username: 'tester',
    scope: 'project',
    additionalRoles: [],
    projectRoot: root,
    dataHome: path.join(root, 'data'),
  };
}

const replaced = (defaults: string) => `schemaVersion: v1alpha1
name: teamai-promote-learning
description: Promote with the bar this team can reach.
inputs: { learning: string, category: string, min_confidence: number, min_upvoted: number, min_users: number, min_age_days: number }
defaults:
  inputs: { ${defaults} }
steps:
  - id: learning
    command: teamai recall maintenance promote-candidate --learning "$ID"
    env: { ID: "{{ inputs.learning }}" }
    output: { title: string, content: string, suggested: string }
`;

describe('parsePromotionThresholds', () => {
  it('ships the defaults when the workflow names no gates', () => {
    expect(parsePromotionThresholds(undefined, 'teamai-promote-learning.yaml')).toEqual(DEFAULT_PROMOTION_THRESHOLDS);
    expect(parsePromotionThresholds({}, 'teamai-promote-learning.yaml')).toEqual(DEFAULT_PROMOTION_THRESHOLDS);
  });

  it('merges a partial override, each named gate on its own', () => {
    expect(parsePromotionThresholds({ min_confidence: 0.7 }, 'wf.yaml')).toEqual({ ...DEFAULT_PROMOTION_THRESHOLDS, minConfidence: 0.7 });
    expect(parsePromotionThresholds({ min_age_days: 7, min_users: 3 }, 'wf.yaml')).toEqual({ ...DEFAULT_PROMOTION_THRESHOLDS, minAgeDays: 7, minUsers: 3 });
  });

  it('accepts the boundary values', () => {
    expect(parsePromotionThresholds({ min_confidence: 0, min_age_days: 0, min_upvoted: 1, min_users: 1 }, 'wf.yaml'))
      .toEqual({ minConfidence: 0, minUpvoted: 1, minUsers: 1, minAgeDays: 0 });
  });

  it.each([
    ['min_confidence', 1.5], ['min_confidence', 'high'], ['min_confidence', -0.1],
    ['min_upvoted', 0], ['min_upvoted', 2.5], ['min_users', 0], ['min_age_days', -1],
  ])('refuses %s = %j with the field and the file named', (key, value) => {
    expect(() => parsePromotionThresholds({ [key]: value }, 'workflows/teamai-promote-learning.yaml'))
      .toThrow(`workflows/teamai-promote-learning.yaml: defaults.inputs.${key} must be`);
  });
});

describe('resolvePromotionThresholds', () => {
  it('resolves the shipped defaults while the team replaces no workflow', async () => {
    const config = testConfig();
    await syncScorersThenWorkflows(config);

    expect(await resolvePromotionThresholds(config)).toEqual(DEFAULT_PROMOTION_THRESHOLDS);
  });

  it('resolves the gates of the workflow file the team replaced it with', async () => {
    const config = testConfig();
    fs.writeFileSync(path.join(config.repo.localPath, 'workflows', 'teamai-promote-learning.yaml'), replaced('min_confidence: 0.7, min_upvoted: 3, min_users: 2, min_age_days: 7'));
    await syncScorersThenWorkflows(config);

    expect(await resolvePromotionThresholds(config)).toEqual({ minConfidence: 0.7, minUpvoted: 3, minUsers: 2, minAgeDays: 7 });
  });

  it('refuses a replaced workflow whose gate is out of range', async () => {
    const config = testConfig();
    fs.writeFileSync(path.join(config.repo.localPath, 'workflows', 'teamai-promote-learning.yaml'), replaced('min_confidence: 2'));
    await syncScorersThenWorkflows(config);

    await expect(resolvePromotionThresholds(config)).rejects.toThrow('defaults.inputs.min_confidence must be');
  });
});
