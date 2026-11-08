// -*- coding: utf-8 -*-
export { computeConfidence, computeAllConfidence, writeBackConfidence } from './confidence.js';

export { findPruneCandidates, executePrune } from './prune.js';

export type { PruneCandidate, PruneOptions } from './prune.js';

export { annotateHotness, HOT_THRESHOLD, ZERO_EVIDENCE_WEIGHT } from './hot-cold.js';

export { findStaleEntries, reportStaleEntries, findRelatedAdoptedLearnings, DraftLearningUpdates } from './quality-update.js';

export type { StaleEntry, QualityUpdateOptions } from './quality-update.js';

export { findPromotionCandidates, writePromotion, fetchPromotionRefs, chooseCategory, PromotionCategorySchema } from './promote.js';

export type { PromotionCandidate, PromotionCategory } from './promote.js';

export { CheckoutLockedError, CheckoutUnavailableError, SyncLockedError, resolveMaintenancePaths } from './paths.js';

export type { MaintenancePaths } from './paths.js';
