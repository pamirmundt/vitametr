/**
 * Row-trace (sparkline) model — pure, DOM- and i18n-free.
 *
 * Turns a metric's measurements into the {@link ChartPoint}s the trace draws and
 * answers the two questions the toolbar switch asks: did this metric ever leave
 * its stated range, and should this row draw a trace at all. Conversion into the
 * display unit happens here, once, so the geometry layer (`chart-model.ts`)
 * never converts.
 *
 * The time domain is NOT decided here: every row of one screen shares a single
 * domain spanning all drawn metrics, assembled in `sparkline-view.ts`.
 */

import type { UnitsEngine } from '../../core/contracts';
import type { Measurement, Metric } from '../../core/types';
import type { ChartPoint } from '../chart-model';
import { seriesFor } from '../../core/series';

/** Which rows draw a trace. Persisted per profile (overview) and per print run. */
export type SparklineMode = 'hidden' | 'outliers' | 'all';

/** The default: the metrics worth a second glance — watched or ever out of range. */
export const DEFAULT_SPARKLINE_MODE: SparklineMode = 'outliers';

/** A reading is "recent enough to call today" within this many days. */
const RECENT_DAYS = 7;

const DAY_MS = 86_400_000;

export interface SparklineSeries {
  /** Numeric readings in the display unit, ascending by time. */
  points: ChartPoint[];
  /**
   * Whether ANY reading in the available history fell outside the range its own
   * source stated — not just the latest one. Drives the "out of range" mode.
   */
  everOutOfRange: boolean;
}

/**
 * Convert a metric's measurements into trace points: numeric readings only
 * (a text/qualitative reading has no geometry), each with its value and its
 * source-stated bounds expressed in `displayUnit`. A reading that cannot be
 * converted keeps its raw value, exactly like the overview card, so the series
 * never silently loses a point. Ascending by time; unparseable instants drop.
 */
export function buildSparklineSeries(
  metric: Metric,
  measurements: readonly Measurement[],
  units: UnitsEngine,
  displayUnit: string,
): SparklineSeries {
  const series = seriesFor([...measurements], metric.id);
  const points: ChartPoint[] = [];
  let everOutOfRange = false;

  for (const m of series) {
    if (m.value === undefined) continue; // text / qualitative — never plotted
    const t = Date.parse(m.takenAt);
    if (Number.isNaN(t)) continue;

    const converted = units.convert(m.value, m.unit, displayUnit, metric);
    const toUnit = converted.ok ? displayUnit : m.unit;
    const value = converted.ok ? converted.value : m.value;
    const refLow = convertBound(m.refLow, m.unit, toUnit, units, metric);
    const refHigh = convertBound(m.refHigh, m.unit, toUnit, units, metric);

    if ((refLow !== undefined && value < refLow) || (refHigh !== undefined && value > refHigh)) {
      everOutOfRange = true;
    }
    points.push({ t, value, operator: m.operator, refLow, refHigh });
  }

  points.sort((a, b) => a.t - b.t);
  return { points, everOutOfRange };
}

function convertBound(
  bound: number | undefined,
  fromUnit: string,
  toUnit: string,
  units: UnitsEngine,
  metric: Metric,
): number | undefined {
  if (bound === undefined) return undefined;
  if (fromUnit === toUnit) return bound;
  const c = units.convert(bound, fromUnit, toUnit, metric);
  return c.ok ? c.value : bound;
}

/**
 * Keep only the readings inside the shown period (the print summary's chosen
 * range). Applied BEFORE anything else, so a metric whose data all falls outside
 * it draws nothing and widens nobody's shared axis.
 */
export function clipToPeriod(
  points: readonly ChartPoint[],
  period?: { from?: number; to?: number },
): ChartPoint[] {
  const { from, to } = period ?? {};
  if (from === undefined && to === undefined) return [...points];
  return points.filter(
    (p) => (from === undefined || p.t >= from) && (to === undefined || p.t <= to),
  );
}

/** Whether a row draws a trace at all, given the mode and what the row is. */
export function showsSparkline(
  mode: SparklineMode,
  row: { numeric: boolean; count: number; watched: boolean; everOutOfRange: boolean },
): boolean {
  if (mode === 'hidden') return false;
  if (!row.numeric || row.count < 1) return false;
  if (mode === 'all') return true;
  return row.watched || row.everOutOfRange;
}

/** Whether a reading is recent enough to be spoken as "today". */
export function isRecentReading(ms: number, nowMs: number): boolean {
  const age = nowMs - ms;
  return age >= -DAY_MS && age <= RECENT_DAYS * DAY_MS;
}
