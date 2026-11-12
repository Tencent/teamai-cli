// -*- coding: utf-8 -*-
import { z } from 'zod';

import type { JsonObject, LocalConfig } from '../types.js';
import { resolveStart } from '../workflow/cache.js';
import { DEFAULT_PROMOTION_THRESHOLDS, PromotionThresholdsSchema, type PromotionThresholds } from './promote.js';

/** The workflow that owns the promotion gates (#1829); a team tunes them by replacing this file, keeping the defaults it does not change. */
export const PROMOTION_WORKFLOW = 'teamai-promote-learning';

/**
 * The four gates out of a workflow's `defaults.inputs`, each absent key keeping its shipped default. A present key
 * that does not fit refuses the run, rather than falling back silently: a tuned gate that never took effect would
 * list what the team did not mean to promote.
 */
export function parsePromotionThresholds(inputs: JsonObject | undefined, source: string): PromotionThresholds {
  const thresholds: PromotionThresholds = { ...DEFAULT_PROMOTION_THRESHOLDS };

  if (inputs === undefined) return thresholds;

  const read = <K extends keyof PromotionThresholds>(name: K, yamlKey: string, field: z.ZodType<PromotionThresholds[K]>, range: string): void => {
    const value = inputs[yamlKey];

    if (value === undefined) return;

    const parsed = field.safeParse(value);

    if (!parsed.success) throw new Error(`${source}: defaults.inputs.${yamlKey} must be ${range}`);
    thresholds[name] = parsed.data;
  };

  const { minConfidence, minUpvoted, minUsers, minAgeDays } = PromotionThresholdsSchema.shape;

  read('minConfidence', 'min_confidence', minConfidence, 'a number from 0 to 1');
  read('minUpvoted', 'min_upvoted', minUpvoted, 'a whole number of at least 1');
  read('minUsers', 'min_users', minUsers, 'a whole number of at least 1');
  read('minAgeDays', 'min_age_days', minAgeDays, 'a whole number of at least 0');

  return thresholds;
}

/**
 * The gates this workspace's `teamai-promote-learning` resolves to: the team's replaced file's `defaults.inputs`
 * over the shipped defaults, exactly as a `recall promote <id>` run would resolve the workflow. The listing and
 * the promote step read this one resolution, so a listing never offers what the step then rejects.
 */
export async function resolvePromotionThresholds(localConfig: LocalConfig): Promise<PromotionThresholds> {
  const { workflow } = await resolveStart(localConfig, PROMOTION_WORKFLOW);

  return parsePromotionThresholds(workflow?.definition.defaults?.inputs, workflow?.relativePath ?? PROMOTION_WORKFLOW);
}
