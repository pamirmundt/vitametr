/**
 * Metric picker for the Summary / print report — pure, DOM- and i18n-free.
 *
 * Which metrics the summary prints is a selection, not a filter: the quick
 * presets SET the selection rather than narrow a list, and the search box narrows
 * the list without ever changing what is selected. Keeping those two ideas apart
 * is the whole design — see `docs/redesign5/ZADANI-SOUHRN-FILTR-VELICIN.md`.
 *
 * Grouping mirrors the Overview exactly (same tags, same order, watched first,
 * untagged last), so a metric is looked up in the place the user already learned.
 * A watched metric therefore appears twice — once under Watched, once under its
 * own panel — and both checkboxes stand for the ONE selection entry.
 */

import type { Metric, MetricId } from '../../core/types';
import { groupOverviewEntries, type OverviewGroup } from './overview-model';
import { isWatched } from '../../core/tags';

/** One selectable metric, with everything the panel needs pre-resolved. */
export interface FilterMetric {
  metricId: MetricId;
  /** Localized display name — what the row shows and what sorting uses. */
  name: string;
  /** The metric itself, for tag grouping. */
  tags: readonly string[];
  watched: boolean;
  /** Whether ANY reading ever fell outside the range its own source stated. */
  everOutOfRange: boolean;
  /** Whether it has at least one reading inside the summary's shown period. */
  hasDataInPeriod: boolean;
  /** Lower-cased name and aliases — the search haystack. */
  terms: readonly string[];
}

/** What a preset chip does when pressed: it REPLACES the selection. */
export type FilterPreset = 'watched' | 'outliers' | 'with-data' | 'all' | 'none';

/** Presets in the order the chips are shown. */
export const FILTER_PRESETS: readonly FilterPreset[] = [
  'watched',
  'outliers',
  'with-data',
  'all',
  'none',
];

/** Turn a catalog metric plus its facts into a picker row. */
export function toFilterMetric(
  metric: Metric,
  name: string,
  facts: { everOutOfRange: boolean; hasDataInPeriod: boolean },
): FilterMetric {
  const terms = [name, ...(metric.aliases ?? [])].map((s) => s.toLowerCase());
  return {
    metricId: metric.id,
    name,
    tags: metric.tags ?? [],
    watched: isWatched(metric),
    everOutOfRange: facts.everOutOfRange,
    hasDataInPeriod: facts.hasDataInPeriod,
    terms,
  };
}

/**
 * The picker's groups: the Overview's own grouping, with each group sorted
 * alphabetically by DISPLAY name in the UI language (never by internal id — the
 * old list put "Kreatinin" before "CRP" and looked broken).
 */
export function buildFilterGroups(
  metrics: readonly FilterMetric[],
  locale: string,
): OverviewGroup<FilterMetric>[] {
  const collator = new Intl.Collator(locale, { sensitivity: 'base', numeric: true });
  return groupOverviewEntries(metrics, { useTags: true, activeTag: undefined }).map((g) => ({
    tag: g.tag,
    entries: [...g.entries].sort((a, b) => collator.compare(a.name, b.name)),
  }));
}

/** The selection a preset stands for. Pure — the caller decides when to apply it. */
export function applyPreset(
  preset: FilterPreset,
  metrics: readonly FilterMetric[],
): Set<MetricId> {
  const picked = new Set<MetricId>();
  for (const m of metrics) {
    const take =
      preset === 'all' ||
      (preset === 'watched' && m.watched) ||
      (preset === 'outliers' && m.everOutOfRange) ||
      (preset === 'with-data' && m.hasDataInPeriod);
    if (take) picked.add(m.metricId);
  }
  return picked;
}

/**
 * Which preset (if any) EXACTLY describes the current selection, so the closed
 * state can say "Watched" instead of a bare number. `undefined` when the user has
 * hand-picked something no chip stands for.
 */
export function describeSelection(
  selected: ReadonlySet<MetricId>,
  metrics: readonly FilterMetric[],
): FilterPreset | undefined {
  // An empty selection is "none" and nothing else. Without this, a profile that
  // watches nothing would light up the Watched chip on an empty selection, because
  // "watched" happens to stand for the empty set there too.
  if (selected.size === 0) return 'none';
  for (const preset of FILTER_PRESETS) {
    const candidate = applyPreset(preset, metrics);
    if (candidate.size !== selected.size) continue;
    let same = true;
    for (const id of candidate) {
      if (!selected.has(id)) {
        same = false;
        break;
      }
    }
    if (same) return preset;
  }
  return undefined;
}

/**
 * Search: a metric matches when EVERY whitespace-separated word of the query is
 * a prefix-or-substring of its name or one of its aliases. An empty query
 * matches everything — the box narrows the list, it never changes the selection.
 */
export function matchesQuery(metric: FilterMetric, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  return words.every((w) => metric.terms.some((term) => term.includes(w)));
}

/** How many of a group's metrics are selected (the `3 / 9` next to its heading). */
export function groupCounts(
  entries: readonly FilterMetric[],
  selected: ReadonlySet<MetricId>,
): { selected: number; total: number } {
  let n = 0;
  for (const m of entries) if (selected.has(m.metricId)) n += 1;
  return { selected: n, total: entries.length };
}

/**
 * Whether a group starts expanded: Watched always, plus any group holding at
 * least one selected metric. Everything else opens on demand — with 77 metrics
 * an all-expanded panel is the very problem this replaces.
 */
export function startsExpanded(
  group: OverviewGroup<FilterMetric>,
  selected: ReadonlySet<MetricId>,
  watchedTag: string,
): boolean {
  if (group.tag === watchedTag) return true;
  return group.entries.some((m) => selected.has(m.metricId));
}

/**
 * What actually gets printed: the selection minus anything with no reading in
 * the period. A metric can stay ticked while having nothing to show — the tick
 * is the user's intent, this is the outcome.
 */
export function printableIds(
  selected: ReadonlySet<MetricId>,
  metrics: readonly FilterMetric[],
): MetricId[] {
  return metrics.filter((m) => selected.has(m.metricId) && m.hasDataInPeriod).map((m) => m.metricId);
}
