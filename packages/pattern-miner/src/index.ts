export interface MinerWorkflow {
  id: string;
  fingerprint: string;
  primaryDomain: string;
  stepCount: number;
  lastSeenAt: string;
}

export interface DetectedPattern {
  fingerprint: string;
  occurrenceCount: number;
  workflowIds: string[];
  domains: string[];
  exampleWorkflowId: string;
}

export interface DetectPatternsOptions {
  minOccurrences?: number;
  /** Fraction of steps whose labels must match (0–1). Default 0.8. */
  labelOverlap?: number;
  /** When false, only exact fingerprint matches cluster. Default true. */
  fuzzy?: boolean;
}

export interface MergeJudgment {
  samePattern: boolean;
  confidence: number;
  reasoning: string;
}

export type MergeJudgeFn = (a: MinerWorkflow, b: MinerWorkflow) => Promise<MergeJudgment>;

export interface DetectPatternsWithMergeOptions extends DetectPatternsOptions {
  /** Cap LLM merge comparisons per mining run. Default 30. */
  maxPairs?: number;
  /** Minimum LLM confidence to merge clusters. Default 0.7. */
  minMergeConfidence?: number;
  /** Max extra steps in the longer workflow for near-match. Default 3. */
  maxStepGap?: number;
  /** Min fraction of shorter workflow that must align. Default 0.75. */
  nearMatchThreshold?: number;
}

const DEFAULT_MIN_OCCURRENCES = 3;
export const DEFAULT_LABEL_OVERLAP = 0.8;
const DEFAULT_MAX_STEP_GAP = 3;
const DEFAULT_NEAR_MATCH_THRESHOLD = 0.75;
const MIN_NEAR_MATCH_STEPS = 3;

interface ParsedStep {
  action: string;
  label: string;
}

class UnionFind {
  private readonly parent: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, i) => i);
  }

  find(i: number): number {
    let root = i;
    while (this.parent[root] !== root) {
      root = this.parent[root];
    }
    let curr = i;
    while (this.parent[curr] !== root) {
      const next = this.parent[curr];
      this.parent[curr] = root;
      curr = next;
    }
    return root;
  }

  union(a: number, b: number): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) this.parent[rootB] = rootA;
  }
}

/** Parse `action:label|action:label` fingerprint tokens. */
export function parseFingerprint(fingerprint: string): ParsedStep[] {
  if (!fingerprint) return [];
  return fingerprint.split('|').map((token) => {
    const sep = token.indexOf(':');
    if (sep === -1) return { action: token.toLowerCase(), label: '' };
    return {
      action: token.slice(0, sep).toLowerCase(),
      label: token.slice(sep + 1),
    };
  });
}

function normalizeLabel(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function levenshteinRatio(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  const rows = a.length + 1;
  const cols = b.length + 1;
  const matrix: number[][] = Array.from({ length: rows }, () => Array(cols).fill(0));

  for (let i = 0; i < rows; i++) matrix[i][0] = i;
  for (let j = 0; j < cols; j++) matrix[0][j] = j;

  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
    }
  }

  const distance = matrix[a.length][b.length];
  return 1 - distance / Math.max(a.length, b.length);
}

/** Whether two step labels refer to the same UI target. */
export function labelsSimilar(a: string, b: string, threshold = DEFAULT_LABEL_OVERLAP): boolean {
  const na = normalizeLabel(a);
  const nb = normalizeLabel(b);
  if (na === nb) return true;
  if (!na || !nb) return false;
  if (na.includes(nb) || nb.includes(na)) return true;
  return levenshteinRatio(na, nb) >= threshold;
}

function domainsMatch(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Fuzzy match: same domain, identical action sequence, ≥ labelOverlap fraction
 * of step labels similar.
 */
export function workflowsFuzzyMatch(
  a: MinerWorkflow,
  b: MinerWorkflow,
  labelOverlap = DEFAULT_LABEL_OVERLAP,
): boolean {
  if (!domainsMatch(a.primaryDomain, b.primaryDomain)) return false;
  if (a.fingerprint === b.fingerprint) return true;

  const stepsA = parseFingerprint(a.fingerprint);
  const stepsB = parseFingerprint(b.fingerprint);
  if (stepsA.length === 0 || stepsA.length !== stepsB.length) return false;

  let labelMatches = 0;
  for (let i = 0; i < stepsA.length; i++) {
    if (stepsA[i].action !== stepsB[i].action) return false;
    if (labelsSimilar(stepsA[i].label, stepsB[i].label, labelOverlap)) {
      labelMatches++;
    }
  }

  return labelMatches / stepsA.length >= labelOverlap;
}

/**
 * Near-match: shorter workflow's steps appear in order inside the longer one
 * (handles extra noise steps or missing optional clicks).
 */
export function workflowsNearMatch(
  a: MinerWorkflow,
  b: MinerWorkflow,
  options?: {
    labelOverlap?: number;
    maxStepGap?: number;
    threshold?: number;
  },
): boolean {
  if (!domainsMatch(a.primaryDomain, b.primaryDomain)) return false;
  if (workflowsFuzzyMatch(a, b, options?.labelOverlap)) return false;

  const stepsA = parseFingerprint(a.fingerprint);
  const stepsB = parseFingerprint(b.fingerprint);
  if (stepsA.length < MIN_NEAR_MATCH_STEPS || stepsB.length < MIN_NEAR_MATCH_STEPS) return false;

  const maxStepGap = options?.maxStepGap ?? DEFAULT_MAX_STEP_GAP;
  const threshold = options?.threshold ?? DEFAULT_NEAR_MATCH_THRESHOLD;
  const labelOverlap = options?.labelOverlap ?? DEFAULT_LABEL_OVERLAP;

  const [shorter, longer] = stepsA.length <= stepsB.length ? [stepsA, stepsB] : [stepsB, stepsA];
  if (longer.length - shorter.length > maxStepGap) return false;

  return subsequenceMatchScore(shorter, longer, labelOverlap) >= threshold;
}

function subsequenceMatchScore(
  shorter: ParsedStep[],
  longer: ParsedStep[],
  labelOverlap: number,
): number {
  let longerIndex = 0;
  let matches = 0;

  for (const step of shorter) {
    while (longerIndex < longer.length) {
      const candidate = longer[longerIndex];
      longerIndex++;
      if (
        candidate.action === step.action &&
        labelsSimilar(candidate.label, step.label, labelOverlap)
      ) {
        matches++;
        break;
      }
    }
  }

  return matches / shorter.length;
}

/** Pairs that code clustering missed but look like the same intent. */
export function findBorderlinePairs(
  workflows: MinerWorkflow[],
  clusterOf: ReadonlyMap<string, number>,
  options?: {
    labelOverlap?: number;
    maxStepGap?: number;
    threshold?: number;
  },
): Array<[MinerWorkflow, MinerWorkflow]> {
  const eligible = workflows.filter((wf) => wf.fingerprint);
  const pairs: Array<[MinerWorkflow, MinerWorkflow]> = [];

  for (let i = 0; i < eligible.length; i++) {
    for (let j = i + 1; j < eligible.length; j++) {
      const a = eligible[i];
      const b = eligible[j];
      const clusterA = clusterOf.get(a.id);
      const clusterB = clusterOf.get(b.id);
      if (clusterA != null && clusterA === clusterB) continue;
      if (!workflowsNearMatch(a, b, options)) continue;
      pairs.push([a, b]);
    }
  }

  return pairs;
}

function pickCanonicalFingerprint(members: MinerWorkflow[]): string {
  const counts = new Map<string, number>();
  for (const member of members) {
    counts.set(member.fingerprint, (counts.get(member.fingerprint) ?? 0) + 1);
  }

  let best = members[0].fingerprint;
  let bestCount = 0;
  for (const [fingerprint, count] of counts) {
    if (count > bestCount || (count === bestCount && fingerprint < best)) {
      best = fingerprint;
      bestCount = count;
    }
  }
  return best;
}

export function clusterWorkflows(
  workflows: MinerWorkflow[],
  labelOverlap: number,
  fuzzy: boolean,
): MinerWorkflow[][] {
  const eligible = workflows.filter((wf) => wf.fingerprint);
  if (eligible.length === 0) return [];

  const uf = new UnionFind(eligible.length);
  for (let i = 0; i < eligible.length; i++) {
    for (let j = i + 1; j < eligible.length; j++) {
      const matches = fuzzy
        ? workflowsFuzzyMatch(eligible[i], eligible[j], labelOverlap)
        : eligible[i].fingerprint === eligible[j].fingerprint;
      if (matches) uf.union(i, j);
    }
  }

  const groups = new Map<number, MinerWorkflow[]>();
  for (let i = 0; i < eligible.length; i++) {
    const root = uf.find(i);
    const list = groups.get(root) ?? [];
    list.push(eligible[i]);
    groups.set(root, list);
  }

  return [...groups.values()];
}

function clustersToPatterns(
  clusters: MinerWorkflow[][],
  options: DetectPatternsOptions = {},
): DetectedPattern[] {
  const minOccurrences = options.minOccurrences ?? DEFAULT_MIN_OCCURRENCES;
  const patterns: DetectedPattern[] = [];

  for (const members of clusters) {
    if (members.length < minOccurrences) continue;
    patterns.push({
      fingerprint: pickCanonicalFingerprint(members),
      occurrenceCount: members.length,
      workflowIds: members.map((m) => m.id),
      domains: [...new Set(members.map((m) => m.primaryDomain).filter(Boolean))],
      exampleWorkflowId: members[0].id,
    });
  }

  return patterns.sort((a, b) => b.occurrenceCount - a.occurrenceCount);
}

function buildClusterIndex(clusters: MinerWorkflow[][]): Map<string, number> {
  const clusterOf = new Map<string, number>();
  for (let i = 0; i < clusters.length; i++) {
    for (const workflow of clusters[i]) {
      clusterOf.set(workflow.id, i);
    }
  }
  return clusterOf;
}

function mergeClusterLists(clusters: MinerWorkflow[][], idxA: number, idxB: number): void {
  if (idxA === idxB) return;
  const keep = Math.min(idxA, idxB);
  const remove = Math.max(idxA, idxB);
  clusters[keep] = [...clusters[keep], ...clusters[remove]];
  clusters.splice(remove, 1);
}

/** Group workflows into patterns; fuzzy-clusters similar fingerprints on same domain. */
export function detectPatterns(
  workflows: MinerWorkflow[],
  options: DetectPatternsOptions = {},
): DetectedPattern[] {
  const labelOverlap = options.labelOverlap ?? DEFAULT_LABEL_OVERLAP;
  const fuzzy = options.fuzzy ?? true;
  const clusters = clusterWorkflows(workflows, labelOverlap, fuzzy);
  return clustersToPatterns(clusters, options);
}

/**
 * Code-first clustering, then LLM adjudication for near-miss pairs (extra/missing steps).
 */
export async function detectPatternsWithMerge(
  workflows: MinerWorkflow[],
  options: DetectPatternsWithMergeOptions,
  mergeJudge: MergeJudgeFn,
): Promise<{ patterns: DetectedPattern[]; pairsJudged: number; pairsMerged: number }> {
  const {
    maxPairs = 30,
    minMergeConfidence = 0.7,
    maxStepGap = DEFAULT_MAX_STEP_GAP,
    nearMatchThreshold = DEFAULT_NEAR_MATCH_THRESHOLD,
    labelOverlap = DEFAULT_LABEL_OVERLAP,
    fuzzy = true,
    ...detectOptions
  } = options;

  const clusters = clusterWorkflows(
    workflows.filter((wf) => wf.fingerprint),
    labelOverlap,
    fuzzy,
  );

  let clusterOf = buildClusterIndex(clusters);
  const nearOptions = { labelOverlap, maxStepGap, threshold: nearMatchThreshold };
  const borderlinePairs = findBorderlinePairs(workflows, clusterOf, nearOptions).slice(0, maxPairs);

  let pairsMerged = 0;
  for (const [a, b] of borderlinePairs) {
    const judgment = await mergeJudge(a, b);
    if (!judgment.samePattern || judgment.confidence < minMergeConfidence) continue;

    const idxA = clusterOf.get(a.id);
    const idxB = clusterOf.get(b.id);
    if (idxA == null || idxB == null || idxA === idxB) continue;

    mergeClusterLists(clusters, idxA, idxB);
    clusterOf = buildClusterIndex(clusters);
    pairsMerged++;
  }

  return {
    patterns: clustersToPatterns(clusters, detectOptions),
    pairsJudged: borderlinePairs.length,
    pairsMerged,
  };
}
