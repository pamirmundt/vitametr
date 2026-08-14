/**
 * The Summary metric picker's pure model. The rules under test are the ones the
 * spec insists on: presets SET the selection, search only narrows the list, and a
 * watched metric is one selection entry shown in two places.
 */

import { describe, expect, it } from 'vitest';
import { WATCHED_TAG } from '../../../core/tags';
import type { Metric, MetricId } from '../../../core/types';
import {
  applyPreset,
  buildFilterGroups,
  describeSelection,
  groupCounts,
  matchesQuery,
  printableIds,
  startsExpanded,
  toFilterMetric,
  type FilterMetric,
} from '../report-filter-model';

function metric(id: string, tags: string[], aliases: string[] = []): Metric {
  return {
    id: id as MetricId,
    nameKey: `metric.${id}`,
    aliases,
    category: 'lab',
    valueType: 'number',
    canonicalUnit: 'mmol/L',
    units: ['mmol/L'],
    tags,
  };
}

function fm(
  id: string,
  name: string,
  opts: {
    tags?: string[];
    aliases?: string[];
    everOutOfRange?: boolean;
    hasDataInPeriod?: boolean;
  } = {},
): FilterMetric {
  return toFilterMetric(metric(id, opts.tags ?? ['lipids'], opts.aliases), name, {
    everOutOfRange: opts.everOutOfRange ?? false,
    hasDataInPeriod: opts.hasDataInPeriod ?? true,
  });
}

describe('toFilterMetric', () => {
  it('lower-cases the name and the aliases into one search haystack', () => {
    const m = fm('lym', 'Lymfocyty', { aliases: ['LYMPH', 'Lymphocytes'] });
    expect(m.terms).toEqual(['lymfocyty', 'lymph', 'lymphocytes']);
  });

  it('reads watched off the reserved tag', () => {
    expect(fm('a', 'A').watched).toBe(false);
    expect(fm('b', 'B', { tags: ['lipids', WATCHED_TAG] }).watched).toBe(true);
  });
});

describe('buildFilterGroups', () => {
  it('sorts each group by display name in the UI language, not by insertion order', () => {
    const groups = buildFilterGroups(
      [fm('kreatinin', 'Kreatinin'), fm('chol', 'Cholesterol'), fm('crp', 'CRP')],
      'cs',
    );
    expect(groups).toHaveLength(1);
    // Czech collates "ch" as one letter after "h", so CRP really does come first.
    expect(groups[0].entries.map((e) => e.name)).toEqual(['CRP', 'Cholesterol', 'Kreatinin']);
  });

  it('puts watched first while keeping the metric in its own category too', () => {
    const groups = buildFilterGroups(
      [fm('a', 'A', { tags: ['lipids', WATCHED_TAG] }), fm('b', 'B', { tags: ['kidney'] })],
      'cs',
    );
    expect(groups[0].tag).toBe(WATCHED_TAG);
    expect(groups[0].entries.map((e) => e.name)).toEqual(['A']);
    const lipids = groups.find((g) => g.tag === 'lipids');
    expect(lipids?.entries.map((e) => e.name)).toEqual(['A']);
  });
});

describe('applyPreset', () => {
  const metrics = [
    fm('w', 'Watched one', { tags: ['lipids', WATCHED_TAG], hasDataInPeriod: false }),
    fm('o', 'Outlier', { everOutOfRange: true }),
    fm('d', 'Has data'),
  ];

  it('watched picks exactly the watched metrics, data or not', () => {
    expect([...applyPreset('watched', metrics)]).toEqual(['w']);
  });

  it('outliers picks anything that was ever out of range', () => {
    expect([...applyPreset('outliers', metrics)]).toEqual(['o']);
  });

  it('with-data picks anything with a reading in the period', () => {
    expect([...applyPreset('with-data', metrics)]).toEqual(['o', 'd']);
  });

  it('all and none are the two extremes', () => {
    expect(applyPreset('all', metrics).size).toBe(3);
    expect(applyPreset('none', metrics).size).toBe(0);
  });
});

describe('describeSelection', () => {
  const metrics = [
    fm('w', 'W', { tags: [WATCHED_TAG], hasDataInPeriod: false }),
    fm('o', 'O', { everOutOfRange: true }),
    fm('d', 'D'),
  ];

  it('names the preset a selection exactly matches', () => {
    expect(describeSelection(new Set(['w'] as MetricId[]), metrics)).toBe('watched');
    expect(describeSelection(new Set(['w', 'o', 'd'] as MetricId[]), metrics)).toBe('all');
  });

  it('calls an empty selection "none" even when nothing is watched', () => {
    const unwatched = [fm('a', 'A'), fm('b', 'B')];
    expect(describeSelection(new Set(), unwatched)).toBe('none');
  });

  it('returns undefined for a hand-picked selection no chip stands for', () => {
    expect(describeSelection(new Set(['w', 'o'] as MetricId[]), metrics)).toBeUndefined();
  });
});

describe('matchesQuery', () => {
  const lym = fm('lym', 'Lymfocyty', { aliases: ['LYMPH'] });

  it('matches on a substring of the name, case-insensitively', () => {
    expect(matchesQuery(lym, 'lym')).toBe(true);
    expect(matchesQuery(lym, 'FOCY')).toBe(true);
  });

  it('matches on an alias', () => {
    expect(matchesQuery(lym, 'lymph')).toBe(true);
  });

  it('requires every word of the query to hit something', () => {
    expect(matchesQuery(lym, 'lym focy')).toBe(true);
    expect(matchesQuery(lym, 'lym glukoza')).toBe(false);
  });

  it('lets an empty query through — the box narrows, it never deselects', () => {
    expect(matchesQuery(lym, '')).toBe(true);
    expect(matchesQuery(lym, '   ')).toBe(true);
  });
});

describe('groupCounts', () => {
  it('counts only the group it is given', () => {
    const entries = [fm('a', 'A'), fm('b', 'B'), fm('c', 'C')];
    expect(groupCounts(entries, new Set(['a', 'c', 'zzz'] as MetricId[]))).toEqual({
      selected: 2,
      total: 3,
    });
  });
});

describe('startsExpanded', () => {
  const watchedGroup = { tag: WATCHED_TAG, entries: [fm('w', 'W')] };
  const other = { tag: 'lipids', entries: [fm('a', 'A'), fm('b', 'B')] };

  it('always expands watched', () => {
    expect(startsExpanded(watchedGroup, new Set(), WATCHED_TAG)).toBe(true);
  });

  it('expands a group only when it holds something selected', () => {
    expect(startsExpanded(other, new Set(), WATCHED_TAG)).toBe(false);
    expect(startsExpanded(other, new Set(['b'] as MetricId[]), WATCHED_TAG)).toBe(true);
  });
});

describe('printableIds', () => {
  it('drops selected metrics that have nothing to show in the period', () => {
    const metrics = [
      fm('a', 'A'),
      fm('b', 'B', { hasDataInPeriod: false }),
      fm('c', 'C'),
    ];
    expect(printableIds(new Set(['a', 'b'] as MetricId[]), metrics)).toEqual(['a']);
  });

  it('keeps the catalog order, not the selection order', () => {
    const metrics = [fm('a', 'A'), fm('b', 'B'), fm('c', 'C')];
    expect(printableIds(new Set(['c', 'a'] as MetricId[]), metrics)).toEqual(['a', 'c']);
  });
});
