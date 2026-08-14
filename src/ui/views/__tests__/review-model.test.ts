/**
 * Unit tests for the DOM-free import-review logic (K8g).
 *
 * The invariants under test are the correctness guarantees of spec §16:
 * an unresolved metric can never be accepted, "Accept all" only touches
 * resolved rows, and the commit list excludes anything rejected, pending or
 * unresolved.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { ReviewItem } from '../../../core/contracts';
import type { Metric, MetricId, ProfileData, ProposedMeasurement } from '../../../core/types';
import {
  buildMetricHistory,
  bulkDecideUndecided,
  canAccept,
  canCommit,
  downgradeHiddenResolutions,
  groupConflictsByMetric,
  hiddenPackCounts,
  isResolved,
  needsUnit,
  suggestMetrics,
  summarize,
  toCommitList,
  type MetricSuggestion,
} from '../review-model';
import { CURRENT_SCHEMA_VERSION } from '../../../core/types';
import type { ProfileId } from '../../../core/types';
import { activatePack } from '../../../core/packs';
import type { ConflictChoice, ConflictGroup } from '../../../core/conflicts';
import { createCatalog } from '../../../core/catalog';
import { createUnitsEngine } from '../../../core/units';
import { t, setLocale, type StringKey } from '../../../i18n/index';

const mid = (s: string): MetricId => s as unknown as MetricId;

/** Build a review item with the parts a test cares about. */
function item(opts: {
  resolvedMetricId?: string;
  decision: ReviewItem['decision'];
  name?: string;
}): ReviewItem {
  const proposed: ProposedMeasurement = {
    metric: opts.resolvedMetricId
      ? mid(opts.resolvedMetricId)
      : { unresolvedName: opts.name ?? 'Unknown' },
    value: 1,
    unit: 'mmol/L',
    confidence: 'high',
  };
  return {
    proposed,
    ...(opts.resolvedMetricId ? { resolvedMetricId: mid(opts.resolvedMetricId) } : {}),
    decision: opts.decision,
  };
}

/**
 * A resolved row the file left unitless, on a metric with several candidate
 * units — what `prepare` produces for e.g. "B_Hematokrit 0,466".
 */
function unitlessItem(opts: {
  resolvedMetricId: string;
  decision: ReviewItem['decision'];
  unitChoice?: string;
}): ReviewItem {
  return {
    proposed: {
      metric: mid(opts.resolvedMetricId),
      value: 0.466,
      confidence: 'medium',
    },
    resolvedMetricId: mid(opts.resolvedMetricId),
    decision: opts.decision,
    unitChoices: ['L/L', '%'],
    ...(opts.unitChoice ? { unitChoice: opts.unitChoice } : {}),
  };
}

function emptyProfile(): ProfileData {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    profile: { id: 'p1' as ProfileId, name: 'T', createdAt: '2026-07-21' },
    metrics: [],
    sources: [],
    measurements: [],
    settings: {},
  };
}

describe('downgradeHiddenResolutions (offerHiddenMetrics === false gate)', () => {
  const name = (m: Metric): string => m.customName ?? m.nameKey ?? m.key ?? '';

  it('downgrades a resolution that landed on a hidden metric to unresolved', () => {
    const data = emptyProfile(); // hormones off → fsh hidden
    const catalog = createCatalog(data);
    const fsh = catalog.byKey('fsh')!;
    const items: ReviewItem[] = [
      { proposed: { metric: { unresolvedName: 'FSH' }, value: 1, confidence: 'high' }, resolvedMetricId: fsh.id, decision: 'accept' },
    ];
    const out = downgradeHiddenResolutions(items, data, catalog, name);
    expect(out[0].resolvedMetricId).toBeUndefined();
    expect(out[0].decision).toBe('pending');
    expect(out[0].proposed.metric).toEqual({ unresolvedName: 'FSH' });
    // The input item is not mutated in place.
    expect(items[0].resolvedMetricId).toBe(fsh.id);
  });

  it('uses the metric display name when the plugin resolved by id (no raw name)', () => {
    const data = emptyProfile();
    const catalog = createCatalog(data);
    const fsh = catalog.byKey('fsh')!;
    const items: ReviewItem[] = [
      { proposed: { metric: fsh.id, value: 1, confidence: 'high' }, resolvedMetricId: fsh.id, decision: 'accept' },
    ];
    const out = downgradeHiddenResolutions(items, data, catalog, name);
    const m = out[0].proposed.metric;
    expect('unresolvedName' in m && m.unresolvedName).toBe(name(fsh));
  });

  it('leaves a VISIBLE resolution intact', () => {
    const data = emptyProfile();
    const catalog = createCatalog(data);
    const glucose = catalog.byKey('glucose')!; // visible (core)
    const items: ReviewItem[] = [
      { proposed: { metric: glucose.id, value: 5, confidence: 'high' }, resolvedMetricId: glucose.id, decision: 'accept' },
    ];
    const out = downgradeHiddenResolutions(items, data, catalog, name);
    expect(out[0]).toBe(items[0]); // unchanged reference
  });

  it('leaves the resolution intact once its pack is active (the true path keeps it)', () => {
    const data = emptyProfile();
    const catalog = createCatalog(data);
    activatePack(data, catalog, 'bundled:hormones');
    const fsh = catalog.byKey('fsh')!;
    const items: ReviewItem[] = [
      { proposed: { metric: fsh.id, value: 1, confidence: 'high' }, resolvedMetricId: fsh.id, decision: 'accept' },
    ];
    const out = downgradeHiddenResolutions(items, data, catalog, name);
    expect(out[0].resolvedMetricId).toBe(fsh.id);
  });
});

describe('hiddenPackCounts (bulk activate-for-all offer)', () => {
  /** A resolved review item pointing at a catalog metric id. */
  function resolved(id: MetricId): ReviewItem {
    return {
      proposed: { metric: id, value: 1, confidence: 'high' },
      resolvedMetricId: id,
      decision: 'accept',
    };
  }

  it('counts ≥2 rows hidden by the same disabled pack', () => {
    const data = emptyProfile(); // hormones off → fsh + lh hidden
    const catalog = createCatalog(data);
    const fsh = catalog.byKey('fsh')!;
    const lh = catalog.byKey('lh')!;
    const glucose = catalog.byKey('glucose')!; // visible core → ignored
    const items = [
      resolved(fsh.id),
      resolved(lh.id),
      resolved(glucose.id),
      item({ decision: 'pending', name: 'Mystery' }), // unresolved → ignored
    ];
    const counts = hiddenPackCounts(items, data, catalog);
    expect(counts.get('bundled:hormones')).toBe(2);
    expect(counts.size).toBe(1);
  });

  it('excludes a pack that hides only ONE row (below the bulk threshold)', () => {
    const data = emptyProfile();
    const catalog = createCatalog(data);
    const fsh = catalog.byKey('fsh')!;
    const counts = hiddenPackCounts([resolved(fsh.id)], data, catalog);
    expect(counts.size).toBe(0);
  });

  it('is empty once the pack is active (its metrics are visible again)', () => {
    const data = emptyProfile();
    const catalog = createCatalog(data);
    activatePack(data, catalog, 'bundled:hormones');
    const fsh = catalog.byKey('fsh')!;
    const lh = catalog.byKey('lh')!;
    const counts = hiddenPackCounts([resolved(fsh.id), resolved(lh.id)], data, catalog);
    expect(counts.size).toBe(0);
  });
});

describe('isResolved / canAccept', () => {
  it('treats a row with a metric id as resolved and acceptable', () => {
    const row = item({ resolvedMetricId: 'builtin:glucose', decision: 'pending' });
    expect(isResolved(row)).toBe(true);
    expect(canAccept(row)).toBe(true);
  });

  it('an unresolved row is never acceptable', () => {
    const row = item({ decision: 'pending', name: 'Mystery marker' });
    expect(isResolved(row)).toBe(false);
    expect(canAccept(row)).toBe(false);
  });
});


describe('toCommitList', () => {
  it('excludes rejected, pending and unresolved rows', () => {
    const accepted = item({ resolvedMetricId: 'builtin:glucose', decision: 'accept' });
    const items = [
      accepted,
      item({ resolvedMetricId: 'builtin:hba1c', decision: 'reject' }), // rejected
      item({ resolvedMetricId: 'builtin:crp', decision: 'pending' }), // pending
      item({ decision: 'accept', name: 'Mystery marker' }), // accepted but unresolved
    ];

    const commit = toCommitList(items);

    expect(commit).toHaveLength(1);
    expect(commit[0]).toBe(accepted);
  });

  it('canCommit reflects whether any row will be committed', () => {
    expect(canCommit([])).toBe(false);
    expect(
      canCommit([item({ decision: 'accept', name: 'Mystery marker' })]),
    ).toBe(false);
    expect(
      canCommit([item({ resolvedMetricId: 'builtin:glucose', decision: 'accept' })]),
    ).toBe(true);
  });
});

describe('summarize', () => {
  it('counts totals, resolution state and acceptances', () => {
    const items = [
      item({ resolvedMetricId: 'builtin:glucose', decision: 'accept' }),
      item({ resolvedMetricId: 'builtin:hba1c', decision: 'reject' }),
      item({ decision: 'pending', name: 'A' }),
      item({ decision: 'accept', name: 'B' }), // accepted but unresolved (UI prevents this)
    ];

    expect(summarize(items)).toEqual({
      total: 4,
      resolved: 2,
      unresolved: 2,
      accepted: 2,
      awaitingUnit: 0,
    });
  });

  it('an empty batch summarizes to all zeros', () => {
    expect(summarize([])).toEqual({
      total: 0,
      resolved: 0,
      unresolved: 0,
      accepted: 0,
      awaitingUnit: 0,
    });
  });

  it('counts the rows still waiting for the user to pick a unit', () => {
    const items = [
      item({ resolvedMetricId: 'builtin:glucose', decision: 'accept' }),
      unitlessItem({ resolvedMetricId: 'builtin:hematocrit', decision: 'pending' }),
      unitlessItem({
        resolvedMetricId: 'builtin:neutrophils',
        decision: 'accept',
        unitChoice: '%',
      }),
    ];
    const summary = summarize(items);
    expect(summary.resolved).toBe(3);
    expect(summary.awaitingUnit).toBe(1); // the settled one no longer waits
  });
});

// ---------------------------------------------------------------------------
// The unit gate: a resolved row the file left unitless
// ---------------------------------------------------------------------------

describe('needsUnit', () => {
  it('blocks a resolved row whose unit the file omitted and the metric cannot fix', () => {
    const row = unitlessItem({ resolvedMetricId: 'builtin:hematocrit', decision: 'pending' });
    expect(isResolved(row)).toBe(true);
    expect(needsUnit(row)).toBe(true);
    // Resolved but NOT acceptable: 0,466 % and 0,466 L/L differ a hundredfold.
    expect(canAccept(row)).toBe(false);
    expect(toCommitList([{ ...row, decision: 'accept' }])).toEqual([]);
  });

  it('releases the row once the user picks one of the candidate units', () => {
    const row = unitlessItem({
      resolvedMetricId: 'builtin:hematocrit',
      decision: 'accept',
      unitChoice: 'L/L',
    });
    expect(needsUnit(row)).toBe(false);
    expect(canAccept(row)).toBe(true);
    expect(toCommitList([row])).toHaveLength(1);
  });

  it('leaves a row whose file DID state a unit alone', () => {
    const row = item({ resolvedMetricId: 'builtin:glucose', decision: 'accept' });
    expect(needsUnit(row)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Grouping many conflicts by metric + bulk resolution
// ---------------------------------------------------------------------------

/** A minimal ConflictGroup for the grouping/bulk tests (only metricId + key matter). */
function group(metricId: string, key: string): ConflictGroup {
  return {
    key,
    metricId: mid(metricId),
    takenAt: '2026-02-10',
    timePrecision: 'date',
    incoming: [],
    existing: [],
  };
}

describe('groupConflictsByMetric', () => {
  it('groups conflicts by metric and sorts by conflict count descending', () => {
    // Weight has 3 conflicts, glucose 1, tsh 2 — expect weight, tsh, glucose.
    const groups = [
      group('glucose', 'g1'),
      group('weight', 'w1'),
      group('tsh', 't1'),
      group('weight', 'w2'),
      group('tsh', 't2'),
      group('weight', 'w3'),
    ];
    const out = groupConflictsByMetric(groups);
    expect(out.map((g) => g.metricId)).toEqual([mid('weight'), mid('tsh'), mid('glucose')]);
    expect(out[0].groups.map((g) => g.key)).toEqual(['w1', 'w2', 'w3']);
  });

  it('10 metrics with 1 conflict each stay 10 single-conflict groups', () => {
    const groups = Array.from({ length: 10 }, (_, i) => group(`metric-${i}`, `k${i}`));
    const out = groupConflictsByMetric(groups);
    expect(out).toHaveLength(10);
    expect(out.every((g) => g.groups.length === 1)).toBe(true);
  });

  it('one metric with 10 conflicts becomes a single group preserving order', () => {
    const groups = Array.from({ length: 10 }, (_, i) => group('weight', `k${i}`));
    const out = groupConflictsByMetric(groups);
    expect(out).toHaveLength(1);
    expect(out[0].groups.map((g) => g.key)).toEqual(groups.map((g) => g.key));
  });

  it('ties on count keep first-seen metric order', () => {
    const groups = [group('a', 'a1'), group('b', 'b1')];
    expect(groupConflictsByMetric(groups).map((g) => g.metricId)).toEqual([mid('a'), mid('b')]);
  });
});

describe('bulkDecideUndecided', () => {
  it('applies the choice only to undecided conflicts', () => {
    const choices = new Map<string, ConflictChoice>();
    const applied = bulkDecideUndecided(['a', 'b', 'c'], choices, 'keep-new');
    expect(applied).toBe(3);
    expect([...choices.entries()]).toEqual([
      ['a', 'keep-new'],
      ['b', 'keep-new'],
      ['c', 'keep-new'],
    ]);
  });

  it('leaves a pre-decided conflict untouched', () => {
    const choices = new Map<string, ConflictChoice>([['b', 'keep-existing']]);
    const applied = bulkDecideUndecided(['a', 'b', 'c'], choices, 'keep-new');
    expect(applied).toBe(2); // only a and c changed
    expect(choices.get('b')).toBe('keep-existing'); // individual choice survives
    expect(choices.get('a')).toBe('keep-new');
    expect(choices.get('c')).toBe('keep-new');
  });

  it('an individual override after a bulk action wins', () => {
    const choices = new Map<string, ConflictChoice>();
    bulkDecideUndecided(['a', 'b'], choices, 'keep-new');
    choices.set('a', 'keep-existing'); // user overrides one card afterwards
    expect(choices.get('a')).toBe('keep-existing');
    expect(choices.get('b')).toBe('keep-new');
  });
});

// ---------------------------------------------------------------------------
// suggestMetrics — intelligent candidate ranking for an unresolved row
// ---------------------------------------------------------------------------

describe('suggestMetrics', () => {
  // The real built-in catalog so MPV/MCV/cholesterol are the actual seeded
  // metrics (their real names, aliases and units drive the scoring).
  const catalog = createCatalog({
    schemaVersion: 1,
    profile: { id: 'p1' as never, name: 'Test', createdAt: '2026-07-21' },
    metrics: [],
    sources: [],
    measurements: [],
    settings: {},
  } as unknown as Parameters<typeof createCatalog>[0]);
  const metrics = catalog.all();
  const units = createUnitsEngine();
  const translate = (key: string): string => t(key as StringKey);

  const idsOf = (ms: MetricSuggestion[]): string[] => ms.map((s) => s.metric.key ?? s.metric.id);

  beforeEach(() => setLocale('en'));

  it('PDW + fl surfaces platelet/RBC-volume metrics, PDW at the top, never cholesterol', () => {
    const out = suggestMetrics(
      { name: 'PDW - distr. křivka trombo', unit: 'fl' },
      metrics,
      units,
      translate,
    );
    const keys = idsOf(out);

    expect(out.length).toBeGreaterThan(0);
    // PDW itself wins now that the catalog carries it: the alias "PDW" is a
    // whole-token hit on the raw name and fl is its unit. (Before the metric
    // existed, MPV took this slot on "trombo" + fl alone.)
    expect(keys[0]).toBe('pdw');
    // MPV/MCV may appear (fl unit); cholesterol (mmol/L only) never does.
    expect(keys).toContain('mpv');
    for (const chol of ['total-cholesterol', 'ldl-cholesterol', 'hdl-cholesterol']) {
      expect(keys).not.toContain(chol);
    }
  });

  it('a clean name hit ranks its metric first (Glykémie → glucose)', () => {
    const out = suggestMetrics({ name: 'Glykémie' }, metrics, units, translate);
    expect(idsOf(out)[0]).toBe('glucose');
  });

  it('no unit and a gibberish name yields no suggestions', () => {
    expect(suggestMetrics({ name: 'qwertzuiop asdfgh' }, metrics, units, translate)).toEqual([]);
  });

  it('a unit-only match still surfaces the fl metrics (the unit carries the signal)', () => {
    const out = suggestMetrics({ name: 'zzz nonsense marker', unit: 'fl' }, metrics, units, translate);
    const keys = idsOf(out);
    expect(keys).toContain('mpv');
    expect(keys).toContain('mcv');
    for (const chol of ['total-cholesterol', 'ldl-cholesterol', 'hdl-cholesterol']) {
      expect(keys).not.toContain(chol);
    }
  });

  it('returns at most three candidates', () => {
    const out = suggestMetrics({ name: 'cholesterol', unit: 'mmol/L' }, metrics, units, translate);
    expect(out.length).toBeLessThanOrEqual(3);
  });

  it('a suggestion with no history is marked as such and carries no evidence', () => {
    const [first] = suggestMetrics({ name: 'Glykémie' }, metrics, units, translate);
    expect(first.fromHistory).toBe(false);
    expect(first.history).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// suggestMetrics — the user's own history as the third signal
// ---------------------------------------------------------------------------

describe('suggestMetrics with the profile history', () => {
  const catalog = createCatalog(emptyProfile());
  const metrics = catalog.all();
  const units = createUnitsEngine();
  const translate = (key: string): string => t(key as StringKey);
  const idsOf = (ms: MetricSuggestion[]): string[] => ms.map((s) => s.metric.key ?? s.metric.id);

  beforeEach(() => setLocale('en'));

  /** A profile that already tracks creatinine and uric acid — both in µmol/L. */
  function profileWithHistory(): ProfileData {
    const data = emptyProfile();
    data.sources = [{ id: 'src-1' as never, name: 'City Lab', kind: 'lab' } as never];
    data.measurements = [
      measurement('builtin:creatinine', 79, 'umol/L', 62, 106, '2026-03-04', 'src-1'),
      measurement('builtin:creatinine', 82, 'umol/L', 62, 106, '2026-06-11', 'src-1'),
      measurement('builtin:uric-acid', 310, 'umol/L', 202, 417, '2026-06-11', 'src-1'),
    ];
    return data;
  }

  function measurement(
    metricId: string,
    value: number,
    unit: string,
    refLow: number,
    refHigh: number,
    takenAt: string,
    sourceId: string,
  ): ProfileData['measurements'][number] {
    return {
      id: `m-${metricId}-${takenAt}` as never,
      profileId: 'p1' as ProfileId,
      metricId: mid(metricId),
      value,
      unit,
      takenAt,
      timePrecision: 'date',
      refLow,
      refHigh,
      sourceId: sourceId as never,
      status: 'confirmed',
      origin: { pluginId: 'test' },
      createdAt: takenAt,
      modifiedAt: takenAt,
    };
  }

  it('indexes the latest reading and the source-stated range per metric', () => {
    const history = buildMetricHistory(profileWithHistory());
    const creatinine = history.get(mid('builtin:creatinine'))!;
    expect(creatinine.lastValue).toBe(82); // the later of the two, not the first seen
    expect(creatinine.lastTakenAt).toBe('2026-06-11');
    expect(creatinine.count).toBe(2);
    expect(creatinine.unit).toBe('umol/L');
    expect(creatinine.refLow).toBe(62);
    expect(creatinine.refHigh).toBe(106);
  });

  it('an unreadable name is matched onto the analyte with the same stored range', () => {
    const history = buildMetricHistory(profileWithHistory());
    // A code-only row from a different lab: the name says nothing at all, but the
    // unit and the reference range are the ones the user stores for uric acid.
    const row = { name: 'XQ-114', unit: 'umol/L', value: 310, refLow: 202, refHigh: 417 };

    const withHistory = suggestMetrics(row, metrics, units, translate, history);
    expect(idsOf(withHistory)[0]).toBe('uric-acid');
    expect(withHistory[0].fromHistory).toBe(true);
    expect(withHistory[0].history?.lastValue).toBe(310);

    // Without the history every molar-concentration analyte scores the same and
    // the tie falls to catalog order — the row's own numbers are what break it.
    const withoutHistory = suggestMetrics(row, metrics, units, translate);
    expect(idsOf(withoutHistory)[0]).not.toBe('uric-acid');
    expect(withoutHistory.every((s) => !s.fromHistory)).toBe(true);
  });

  it('history never drags a row onto a dimensionally impossible metric', () => {
    const history = buildMetricHistory(profileWithHistory());
    // The same numbers, stated in a unit neither analyte can be in.
    const keys = idsOf(
      suggestMetrics(
        { name: 'XQ-114', unit: 'fl', value: 310, refLow: 202, refHigh: 417 },
        metrics,
        units,
        translate,
        history,
      ),
    );
    expect(keys).not.toContain('uric-acid');
    expect(keys).not.toContain('creatinine');
  });

  it('a name hit on a metric the user never measured stays a name hit', () => {
    const history = buildMetricHistory(profileWithHistory());
    const [first] = suggestMetrics({ name: 'Glykémie' }, metrics, units, translate, history);
    expect(first.metric.key).toBe('glucose');
    expect(first.fromHistory).toBe(false);
    expect(first.history).toBeUndefined();
  });
});
