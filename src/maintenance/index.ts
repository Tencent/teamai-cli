// -*- coding: utf-8 -*-
export { computeConfidence, computeAllConfidence, writeBackConfidence } from './confidence.js';
export { findPruneCandidates, executePrune } from './prune.js';
export type { PruneCandidate, PruneOptions } from './prune.js';
export { annotateHotness, HOT_THRESHOLD, COLD_PENALTY } from './hot-cold.js';
export { findStaleEntries, reportStaleEntries, findRelatedAdoptedLearnings, generateUpdateDraft } from './quality-update.js';
export type { StaleEntry, QualityUpdateOptions } from './quality-update.js';
export { findPromotionCandidates, executePromotion } from './promote.js';
export type { PromotionCandidate, PromoteOptions } from './promote.js';
