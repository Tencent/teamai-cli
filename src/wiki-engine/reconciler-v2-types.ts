import type { WikiConfidence } from './core/wiki-protocol.js';

// ─── Numeric Confidence ─────────────────────────────────────────────────────

export interface ConfidenceFactor {
  name: string;
  weight: number;
  detail?: string;
}

export interface NumericConfidence {
  score: number;
  label: WikiConfidence;
  factors: ConfidenceFactor[];
}

/** Convert legacy WikiConfidence string to NumericConfidence */
export function fromLegacyConfidence(confidence: WikiConfidence): NumericConfidence {
  const DEFAULTS: Record<WikiConfidence, number> = {
    EXTRACTED: 1.0,
    INFERRED: 0.75,
    AMBIGUOUS: 0.2
  };
  return {
    score: DEFAULTS[confidence],
    label: confidence,
    factors: [{ name: "legacy_conversion", weight: DEFAULTS[confidence], detail: `Converted from ${confidence}` }]
  };
}

/** Derive label from numeric score */
export function labelFromScore(score: number): WikiConfidence {
  if (score >= 0.8) return "EXTRACTED";
  if (score >= 0.5) return "INFERRED";
  return "AMBIGUOUS";
}

/** Build a NumericConfidence from factors (average of weights) */
export function buildConfidence(factors: ConfidenceFactor[]): NumericConfidence {
  if (factors.length === 0) return { score: 0, label: "AMBIGUOUS", factors: [] };
  const score = factors.reduce((sum, f) => sum + f.weight, 0) / factors.length;
  const clamped = Math.min(1, Math.max(0, score));
  return { score: clamped, label: labelFromScore(clamped), factors };
}

// ─── API↔Interface Matching ─────────────────────────────────────────────────

export interface ApiInterfaceMatch {
  apiPagePath: string;
  interfacePagePath: string;
  method: string;
  path: string;
  confidence: NumericConfidence;
}

// ─── Rule↔Code Matching ─────────────────────────────────────────────────────

export interface RuleCodeMatch {
  rulePagePath: string;
  codePagePath: string;
  matchedPattern: string;
  confidence: NumericConfidence;
}

// ─── Stale Warning ──────────────────────────────────────────────────────────

export interface ReconcileStaleWarning {
  mappingFrom: string;
  mappingTo: string;
  fromUpdated: string;
  toUpdated: string;
  daysDrift: number;
  severity: "warning" | "critical";
}

// ─── Reconcile Log Entry ────────────────────────────────────────────────────

export interface ReconcileLogEntry {
  timestamp: string;
  runId: string;
  dryRun: boolean;
  mappingsCount: number;
  gapsCount: number;
  conflictsCount: number;
  staleWarningsCount: number;
  apiMatchesCount: number;
  ruleMatchesCount: number;
  durationMs: number;
  summary: string;
}

// ─── Reconcile Stats ────────────────────────────────────────────────────────

export interface ReconcileStats {
  totalProductPages: number;
  totalCodePages: number;
  mappingsCreated: number;
  gapsDetected: number;
  conflictsDetected: number;
  apiMatchesFound: number;
  ruleMatchesFound: number;
  staleWarningsRaised: number;
  averageConfidence: number;
  durationMs: number;
}

// ─── Enhanced ReconcileFullResult (V2 extension fields) ─────────────────────

export interface ReconcileV2Extensions {
  staleWarnings: ReconcileStaleWarning[];
  apiMatches: ApiInterfaceMatch[];
  ruleMatches: RuleCodeMatch[];
  reconcileLogPath?: string;
  stats: ReconcileStats;
}
