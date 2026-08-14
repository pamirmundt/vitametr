/**
 * DOM-free logic for the import review screen (K8g).
 *
 * The review screen lets the user confirm a batch of proposed measurements
 * before anything is stored. Correctness over convenience (spec §16): a
 * proposal whose metric the catalog could not resolve must be resolved by the
 * user first — it can never be accepted (and therefore never committed) while
 * unresolved. All of that decision arithmetic lives here, free of the DOM, so
 * it can be unit-tested in isolation; `review.ts` is only the glue to the DOM.
 */

import type { Catalog, ReviewItem, UnitsEngine } from '../../core/contracts';
import type {
  Measurement,
  Metric,
  MetricId,
  ProfileData,
  SourceId,
  TimePrecision,
} from '../../core/types';
import type { ConflictChoice, ConflictGroup } from '../../core/conflicts';
import { isUnitCompatibleWithMetric } from '../../core/units';
import { hiddenMetricState, isMetricVisible } from '../../core/packs';
import { normalizeUnit } from '../../core/normalize';

/** Aggregate counts used by the header/footer of the review screen. */
export interface ReviewSummary {
  /** Every proposed row. */
  total: number;
  /** Rows whose metric resolved against the catalog. */
  resolved: number;
  /** Rows still lacking a resolved metric. */
  unresolved: number;
  /** Rows the user marked to keep. */
  accepted: number;
  /** Resolved rows blocked on the user picking which unit the value is in. */
  awaitingUnit: number;
}

/** A row is resolved once it carries a concrete catalog metric id. */
export function isResolved(item: ReviewItem): boolean {
  return item.resolvedMetricId !== undefined;
}

/**
 * Whether the row is a resolved one whose value has no unit yet: the file stated
 * none and the metric admits several, so `prepare` left the candidates on the
 * item. The user must say which one before the row means anything.
 */
export function needsUnit(item: ReviewItem): boolean {
  return (
    (item.unitChoices?.length ?? 0) > 0 &&
    item.unitChoice === undefined &&
    item.proposed.unit === undefined
  );
}

/**
 * Whether a row may be accepted. Two blockers, both "never guess" (spec §16):
 * an unresolved row (the metric must be assigned or created first), and a
 * resolved row still waiting for the user to pick its unit.
 */
export function canAccept(item: ReviewItem): boolean {
  return isResolved(item) && !needsUnit(item);
}

/** Count totals across a batch of review items. */
export function summarize(items: readonly ReviewItem[]): ReviewSummary {
  let resolved = 0;
  let accepted = 0;
  let awaitingUnit = 0;
  for (const item of items) {
    if (isResolved(item)) resolved += 1;
    if (item.decision === 'accept') accepted += 1;
    if (isResolved(item) && needsUnit(item)) awaitingUnit += 1;
  }
  return {
    total: items.length,
    resolved,
    unresolved: items.length - resolved,
    accepted,
    awaitingUnit,
  };
}

/**
 * The rows that will actually be committed: accepted *and* acceptable. Excludes
 * rejected, still-pending, unresolved and unit-less rows. Mirrors the pipeline's
 * own `commit` filter, so the UI can preview the exact count before persisting.
 */
export function toCommitList(items: readonly ReviewItem[]): ReviewItem[] {
  return items.filter((item) => item.decision === 'accept' && canAccept(item));
}

/** True when there is at least one accepted, resolved row to import. */
export function canCommit(items: readonly ReviewItem[]): boolean {
  return toCommitList(items).length > 0;
}

// ---------------------------------------------------------------------------
// Hidden-metric gate (offerHiddenMetrics === false)
// ---------------------------------------------------------------------------

/**
 * Downgrade any prepared item that resolved ONLY to a currently-hidden metric
 * (its providing pack inactive) back to unresolved, so it flows into the normal
 * create-new / skip path instead of being silently attached to a hidden metric.
 * This is the `offerHiddenMetrics === false` gate; the caller applies it only
 * when the setting is off (when on, review surfaces the hidden-pack row itself).
 *
 * A downgraded item loses its `resolvedMetricId`, returns to a `pending`
 * decision, and gets a `{ unresolvedName }` proposal — the name it originally
 * matched, or the metric's display name when the plugin resolved it by id/code.
 * A visible resolution is returned unchanged. Pure — no DOM, no mutation of the
 * inputs (new item objects are produced for downgraded rows).
 */
export function downgradeHiddenResolutions(
  items: readonly ReviewItem[],
  data: ProfileData,
  catalog: Catalog,
  metricName: (metric: Metric) => string,
): ReviewItem[] {
  return items.map((item) => {
    if (item.resolvedMetricId === undefined) return item;
    const metric = catalog.byId(item.resolvedMetricId);
    if (!metric || isMetricVisible(data, metric)) return item;
    const proposedMetric = item.proposed.metric;
    const name =
      typeof proposedMetric === 'object' && 'unresolvedName' in proposedMetric
        ? proposedMetric.unresolvedName
        : metricName(metric);
    return {
      ...item,
      resolvedMetricId: undefined,
      decision: 'pending',
      proposed: { ...item.proposed, metric: { unresolvedName: name } },
    };
  });
}

/**
 * Per-pack count of review rows whose resolved metric is hidden by that SAME
 * disabled pack — restricted to packs covering ≥2 rows, the threshold at which a
 * single bulk "activate the pack for all N" beats N per-row activations.
 *
 * Only resolved rows count (an unresolved row has no metric yet); a row whose
 * metric is currently visible, or hidden with no pack that would reveal it, is
 * ignored. The returned map's values are therefore all ≥2. Pure — no DOM, no
 * mutation; the caller (review view) applies the offer-hidden-metrics gate.
 */
export function hiddenPackCounts(
  items: readonly ReviewItem[],
  data: ProfileData,
  catalog: Catalog,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    if (item.resolvedMetricId === undefined) continue;
    const metric = catalog.byId(item.resolvedMetricId);
    if (!metric) continue;
    const state = hiddenMetricState(data, catalog, metric);
    if (!state.hidden || state.suggestedPackId === undefined) continue;
    counts.set(state.suggestedPackId, (counts.get(state.suggestedPackId) ?? 0) + 1);
  }
  for (const [packId, n] of [...counts]) if (n < 2) counts.delete(packId);
  return counts;
}

// ---------------------------------------------------------------------------
// Grouping many conflicts by metric + bulk resolution
// ---------------------------------------------------------------------------

/** Conflicts that share one metric, kept in their original stable order. */
export interface MetricConflictGroup {
  metricId: MetricId;
  groups: ConflictGroup[];
}

/**
 * Group conflict groups by their metric so a large reimport can be resolved a
 * metric at a time. The most-painful metric (most conflicts) comes first; ties
 * keep the metric's first-seen order, and each metric keeps its conflicts in the
 * order `detectConflicts` produced (stable, file order). Pure — no DOM.
 */
export function groupConflictsByMetric(
  groups: readonly ConflictGroup[],
): MetricConflictGroup[] {
  const byMetric = new Map<MetricId, MetricConflictGroup>();
  const ordered: MetricConflictGroup[] = [];
  for (const group of groups) {
    let bucket = byMetric.get(group.metricId);
    if (!bucket) {
      bucket = { metricId: group.metricId, groups: [] };
      byMetric.set(group.metricId, bucket);
      ordered.push(bucket);
    }
    bucket.groups.push(group);
  }
  // Stable sort by conflict count descending; ties preserve first-seen order.
  return ordered
    .map((bucket, index) => ({ bucket, index }))
    .sort((a, b) => b.bucket.groups.length - a.bucket.groups.length || a.index - b.index)
    .map(({ bucket }) => bucket);
}

/**
 * Apply one bulk choice to the still-UNDECIDED conflicts among `groupKeys`,
 * leaving any conflict the user already decided individually untouched. Mutates
 * the shared `choices` map in place (the view's persisted decision map) and
 * returns how many conflicts the bulk action changed.
 */
export function bulkDecideUndecided(
  groupKeys: readonly string[],
  choices: Map<string, ConflictChoice>,
  choice: ConflictChoice,
): number {
  let applied = 0;
  for (const key of groupKeys) {
    if (!choices.has(key)) {
      choices.set(key, choice);
      applied += 1;
    }
  }
  return applied;
}

// ---------------------------------------------------------------------------
// Metric suggestions for an unresolved row
// ---------------------------------------------------------------------------

/**
 * Case- and diacritics-insensitive fold (mirrors the catalog's normalizeName):
 * strip combining marks, lowercase, collapse whitespace.
 */
function fold(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

/** Alphanumeric tokens of a folded string (drops punctuation and lone symbols). */
function tokenize(folded: string): string[] {
  return folded.split(/[^a-z0-9]+/).filter((t) => t.length >= 2);
}

/**
 * Whether two tokens share a stem: the shorter (≥3 chars) is a prefix of the
 * longer. Prefix — not any substring — so "trombo" matches "trombocytu" but the
 * noise pair "str" ⊂ "distr" (different word start) does not.
 */
function stemMatch(a: string, b: string): boolean {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 3 && long.startsWith(short);
}

/**
 * What the user has already measured for one metric — the "fingerprint" an
 * unknown row is matched against. Built once per review render from the profile;
 * absent for a metric the user has never recorded (a fresh profile has none).
 */
export interface MetricHistory {
  /** The unit those measurements are stored in (the most recent one's). */
  unit: string;
  /** Reference range as the SOURCE stated it — never a range this app invents. */
  refLow?: number;
  refHigh?: number;
  /**
   * The span of what the user has actually measured, in {@link unit}. Used to
   * show "your values 0.40–0.48" — their own readings, not a claim about normal.
   */
  min: number;
  max: number;
  /** The most recent reading. */
  lastValue: number;
  lastTakenAt: string;
  lastPrecision: TimePrecision;
  lastSourceId?: SourceId;
  /** How many measurements back this fingerprint. */
  count: number;
}

/**
 * Index the profile's own measurements by metric: unit, the source-stated
 * reference range, the span of readings and the latest one. This is what lets a
 * row from a new lab be matched onto the analyte the user already tracks from
 * another one.
 *
 * The fingerprint is expressed in ONE unit — the latest reading's — and only
 * measurements stored in that unit feed the span, so a series that changed units
 * mid-way never produces a mixed 0.45-to-45 range. Pure: no DOM, no clock. Ties
 * on `takenAt` keep the later array position, so a re-import that appends the
 * same instant does not flip the "last" reading.
 */
export function buildMetricHistory(data: ProfileData): Map<MetricId, MetricHistory> {
  const byMetric = new Map<MetricId, Measurement[]>();
  for (const m of data.measurements) {
    if (m.value === undefined) continue; // qualitative results carry no fingerprint
    const bucket = byMetric.get(m.metricId);
    if (bucket) bucket.push(m);
    else byMetric.set(m.metricId, [m]);
  }

  const out = new Map<MetricId, MetricHistory>();
  for (const [metricId, measurements] of byMetric) {
    let latest = measurements[0];
    for (const m of measurements) if (m.takenAt >= latest.takenAt) latest = m;

    const sameUnit = measurements.filter((m) => m.unit === latest.unit);
    let min = latest.value!;
    let max = latest.value!;
    for (const m of sameUnit) {
      if (m.value! < min) min = m.value!;
      if (m.value! > max) max = m.value!;
    }

    out.set(metricId, {
      unit: latest.unit,
      ...(latest.refLow !== undefined ? { refLow: latest.refLow } : {}),
      ...(latest.refHigh !== undefined ? { refHigh: latest.refHigh } : {}),
      min,
      max,
      lastValue: latest.value!,
      lastTakenAt: latest.takenAt,
      lastPrecision: latest.timePrecision,
      ...(latest.sourceId !== undefined ? { lastSourceId: latest.sourceId } : {}),
      count: measurements.length,
    });
  }
  return out;
}

/** The row being resolved, as the matcher sees it. */
export interface SuggestionRow {
  /** The raw analyte name from the file. */
  name: string;
  /** The parsed unit code (raw or UCUM); normalized internally. */
  unit?: string;
  value?: number;
  refLow?: number;
  refHigh?: number;
}

/** One ranked candidate plus the evidence behind it, for the review card. */
export interface MetricSuggestion {
  metric: Metric;
  /** The user's own measurements of this metric — the card's evidence. */
  history?: MetricHistory;
  /**
   * True when that history actually contributed to the rank (matching unit,
   * reference range or a value inside the known range) — as opposed to a
   * suggestion resting on the name alone.
   */
  fromHistory: boolean;
}

/** Relative tolerance when comparing this row's reference range with a stored one. */
const REF_TOLERANCE = 0.02;

/** Two reference bounds are "the same range" when they agree within 2 %. */
function sameBound(a: number | undefined, b: number | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  const scale = Math.max(Math.abs(a), Math.abs(b), 1e-9);
  return Math.abs(a - b) / scale <= REF_TOLERANCE;
}

/** Weights, tuned so the acceptance cases in review-model.test hold. */
const SCORE_EXACT = 100; // a candidate name equals the raw name
const SCORE_CONTAINS = 60; // one is a substring of the other
const SCORE_WHOLE_TOKEN = 35; // first shared whole token
const SCORE_WHOLE_TOKEN_EXTRA = 10; // each further shared whole token
const SCORE_PARTIAL_TOKEN = 12; // a raw token nested inside a candidate token (or vice versa)
const SCORE_PARTIAL_CAP = 2; // at most this many partial-token hits count
const SCORE_UNIT = 50; // the row's unit is dimensionally compatible with the metric
/**
 * History weights — the user's own data as a third signal. The reference range
 * is the sharpest of the three (a lab-stated 62–106 belongs to few analytes),
 * the stored unit is next, and a value merely landing inside a known range is
 * the weakest hint. Each is worth less than a clean name hit on its own, so
 * history sharpens the ranking without ever inventing a candidate the name and
 * unit could not justify.
 */
const SCORE_HISTORY_REF = 55; // both bounds match a range the user already stores
const SCORE_HISTORY_UNIT = 30; // the row's unit is the very unit the user stores
const SCORE_HISTORY_VALUE = 15; // the row's value lands inside the stored range
/**
 * Minimum combined score to surface a suggestion. Sits above a single
 * partial-token hit (12) — a lone weak name overlap on a unit-incompatible
 * metric is dropped — and at/below the unit bonus (50) so a unit-only match
 * still surfaces (spec §16: the unit carries the signal, never a wrong guess).
 */
const MIN_SCORE = 30;
/** Never overwhelm the row: at most this many suggestions, best first. */
const MAX_SUGGESTIONS = 3;

/** Best name-overlap score of the raw name against a metric's names/aliases. */
function nameScore(rawFold: string, rawTokens: readonly string[], candidates: readonly string[]): number {
  let best = 0;
  for (const raw of candidates) {
    const cf = fold(raw);
    if (cf === '') continue;
    if (cf === rawFold) {
      best = Math.max(best, SCORE_EXACT);
      continue;
    }
    if ((cf.length >= 3 && rawFold.includes(cf)) || (rawFold.length >= 3 && cf.includes(rawFold))) {
      best = Math.max(best, SCORE_CONTAINS);
      continue;
    }
    const candTokens = tokenize(cf);
    let whole = 0;
    let partial = 0;
    for (const rt of rawTokens) {
      if (candTokens.includes(rt)) {
        whole += 1;
      } else if (rt.length >= 3 && candTokens.some((ct) => stemMatch(rt, ct))) {
        partial += 1;
      }
    }
    let s = 0;
    if (whole > 0) s += SCORE_WHOLE_TOKEN + (whole - 1) * SCORE_WHOLE_TOKEN_EXTRA;
    s += Math.min(partial, SCORE_PARTIAL_CAP) * SCORE_PARTIAL_TOKEN;
    best = Math.max(best, s);
  }
  return best;
}

/**
 * Intelligent candidate metrics for an unresolved import row, ranked best-first.
 *
 * Pure and DOM-free so it can be unit-tested against the real built-in catalog.
 * Three signals are combined into a single rank:
 *  - **name/alias overlap** — the raw name (and its tokens) folded against each
 *    metric's localized display name plus every alias and its key: an exact
 *    match, a substring containment, shared whole tokens, or (weaker) a token
 *    nested inside another;
 *  - **unit compatibility** — a large bonus when the row's unit is the metric's
 *    canonical/listed unit or convertible to it (via {@link isUnitCompatibleWithMetric});
 *  - **the user's own history** — the reference range, unit and value of what
 *    they already measured for that metric (see {@link buildMetricHistory}). A
 *    row from a new lab is matched onto the analyte they already track, which is
 *    exactly what a lab-specific code cannot tell us. History bonuses only apply
 *    on a unit-compatible metric, so a coincidental number never drags a row onto
 *    an unrelated analyte.
 *
 * Never a silent guess (spec §16): a metric with no usable name overlap AND an
 * incompatible/absent unit scores below {@link MIN_SCORE} and is dropped, so a
 * weak batch yields `[]` (no suggestions) rather than a wrong assignment. Returns at
 * most {@link MAX_SUGGESTIONS}.
 *
 * @param row       the unresolved row: raw name, parsed unit, value, reference range
 * @param metrics   catalog metrics to rank (typically `catalog.all()`)
 * @param units     units engine, for the dimensional compatibility check
 * @param translate resolves a built-in `nameKey` to its localized display name
 * @param history   the profile's own measurements per metric; omit for none
 */
export function suggestMetrics(
  row: SuggestionRow,
  metrics: readonly Metric[],
  units: UnitsEngine,
  translate: (nameKey: string) => string,
  history?: ReadonlyMap<MetricId, MetricHistory>,
): MetricSuggestion[] {
  const rawFold = fold(row.name);
  const rawTokens = tokenize(rawFold);
  const unitCode = row.unit ? normalizeUnit(row.unit) : undefined;

  const displayName = (m: Metric): string =>
    m.customName ?? (m.nameKey ? translate(m.nameKey) : (m.key ?? ''));

  const scored: { suggestion: MetricSuggestion; score: number; order: number }[] = [];
  metrics.forEach((metric, order) => {
    if (metric.hidden) return;
    const candidates = [displayName(metric), ...metric.aliases];
    if (metric.key) candidates.push(metric.key);
    const name = nameScore(rawFold, rawTokens, candidates);
    const unitCompatible =
      unitCode !== undefined && isUnitCompatibleWithMetric(units, metric, unitCode);
    const unitBonus = unitCompatible ? SCORE_UNIT : 0;

    // The user's own data. Only consulted when the row's unit does not rule the
    // metric out — otherwise a value that happens to sit in some other analyte's
    // range would start voting.
    const known = history?.get(metric.id);
    let historyBonus = 0;
    if (known && (unitCode === undefined || unitCompatible)) {
      if (sameBound(row.refLow, known.refLow) && sameBound(row.refHigh, known.refHigh)) {
        historyBonus += SCORE_HISTORY_REF;
      }
      if (unitCode !== undefined && normalizeUnit(known.unit) === unitCode) {
        historyBonus += SCORE_HISTORY_UNIT;
      }
      if (
        row.value !== undefined &&
        known.refLow !== undefined &&
        known.refHigh !== undefined &&
        row.value >= known.refLow &&
        row.value <= known.refHigh
      ) {
        historyBonus += SCORE_HISTORY_VALUE;
      }
    }

    const score = name + unitBonus + historyBonus;
    if (score < MIN_SCORE) return;
    scored.push({
      suggestion: {
        metric,
        ...(known ? { history: known } : {}),
        fromHistory: historyBonus > 0,
      },
      score,
      order,
    });
  });

  scored.sort((a, b) => (b.score - a.score) || (a.order - b.order));
  return scored.slice(0, MAX_SUGGESTIONS).map((s) => s.suggestion);
}
