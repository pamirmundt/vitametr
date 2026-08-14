/**
 * Row trend traces — the shared step between the pure model and the DOM.
 *
 * The Overview list and the Summary/print report draw the SAME traces from the
 * same inputs, so the build lives here once: series → shared domain → geometry →
 * axis marks → the assistive-tech sentence.
 *
 * Every row of one screen shares ONE time domain (the union of the drawn
 * metrics' readings, clipped to the print period), so the same instant lands at
 * the same x in every trace and the rows can be read against a single axis strip
 * underneath. A metric measured over part of that span draws over part of the
 * width — that gap is information, not a defect.
 */

import type { AppContext } from '../app-context';
import type { Measurement, Metric, MetricId } from '../../core/types';
import type { Locale, StringKey } from '../../i18n/index';
import { formatNumber } from '../../i18n/index';
import { isWatched } from '../../core/tags';
import { seriesFor, trend } from '../../core/series';
import {
  buildSparklineModel,
  timeTicks,
  type ChartPoint,
  type SparklineModel,
  type TimeGranularity,
} from '../chart-model';
import { unitLabel } from '../format-value';
import { sparklineAxis, sparklineRow, type SparklineTick } from '../components/sparkline';
import { resolveDisplayUnit } from './overview-model';
import {
  buildSparklineSeries,
  clipToPeriod,
  isRecentReading,
  showsSparkline,
  type SparklineMode,
} from './sparkline-model';

/** Nominal viewBox of a trace; CSS stretches it to the row's real width. */
export const TRACE_W = 300;
export const TRACE_H = 28;

const INTL_TAG: Record<Locale, string> = { cs: 'cs-CZ', en: 'en-US' };

/** Everything one row's trace needs. */
export interface TraceData {
  model: SparklineModel;
  summary: string;
}

/** What the traces of one paint pass are built from. */
export interface TraceInputs {
  ctx: AppContext;
  measurements: readonly Measurement[];
  mode: SparklineMode;
  /** Start of the shown period (print filter); absent ⇒ the data's own start. */
  periodFrom?: number;
  /** End of the shown period — the as-of cut-off, or absent when live. */
  periodTo?: number;
  /** Reference instant for "today" in the spoken summary. */
  nowMs: number;
}

/** The traces of one screen, all sharing one time domain. */
export interface TraceSet {
  /** The shared domain, or `undefined` when nothing draws a trace. */
  domain?: [number, number];
  /** Calendar marks of that domain — the axis strip and the row gridlines. */
  ticks: SparklineTick[];
  /** This metric's trace, or `undefined` when it draws none. */
  get(metricId: MetricId): TraceData | undefined;
  /** Whether any row draws a trace at all (⇒ whether to render the axis). */
  any: boolean;
}

const EMPTY_SET: TraceSet = { ticks: [], get: () => undefined, any: false };

/**
 * Build every trace of one screen in one pass: which metrics draw, the domain
 * they share, and each one's geometry against it.
 */
export function buildTraceSet(inputs: TraceInputs, metrics: readonly Metric[]): TraceSet {
  const { ctx, mode } = inputs;
  if (mode === 'hidden' || metrics.length === 0) return EMPTY_SET;

  // --- 1. Which metrics draw, and on what readings ---------------------------
  interface Drawn {
    metric: Metric;
    points: ChartPoint[];
    displayUnit: string;
  }
  const drawn: Drawn[] = [];
  let from = Number.POSITIVE_INFINITY;
  let to = Number.NEGATIVE_INFINITY;

  for (const metric of metrics) {
    const displayUnit = resolveDisplayUnit(metric, ctx.data().settings, ctx.locale);
    const { points, everOutOfRange } = buildSparklineSeries(
      metric,
      inputs.measurements,
      ctx.units,
      displayUnit,
    );
    const inPeriod = clipToPeriod(points, { from: inputs.periodFrom, to: inputs.periodTo });
    const show = showsSparkline(mode, {
      numeric: true,
      count: inPeriod.length,
      watched: isWatched(metric),
      everOutOfRange,
    });
    if (!show) continue;
    drawn.push({ metric, points: inPeriod, displayUnit });
    from = Math.min(from, inPeriod[0].t);
    to = Math.max(to, inPeriod[inPeriod.length - 1].t);
  }
  if (drawn.length === 0) return EMPTY_SET;

  // --- 2. The one domain they all share -------------------------------------
  const domain: [number, number] = [from, to];
  const tickTimes = timeTicks(from, to);
  const ticks: SparklineTick[] = [];

  // --- 3. Geometry, against that domain -------------------------------------
  const traces = new Map<MetricId, TraceData>();
  for (const d of drawn) {
    const model = buildSparklineModel(d.points, {
      width: TRACE_W,
      height: TRACE_H,
      domain,
      ticks: tickTimes.ticks,
    });
    if (model.isEmpty) continue;
    traces.set(d.metric.id, {
      model,
      summary: traceSummary(inputs, d.metric, d.displayUnit, model),
    });
    if (ticks.length === 0) {
      // Every model shares the domain, so any one of them yields the marks.
      for (let i = 0; i < model.grid.length; i += 1) {
        ticks.push({
          x: model.grid[i],
          label: traceLabel(tickTimes.ticks[i], tickTimes.granularity, ctx.locale),
        });
      }
    }
  }
  if (traces.size === 0) return EMPTY_SET;

  return {
    domain,
    ticks,
    get: (metricId) => traces.get(metricId),
    any: true,
  };
}

/** The sentence assistive tech reads in place of the (aria-hidden) trace. */
function traceSummary(
  inputs: TraceInputs,
  metric: Metric,
  displayUnit: string,
  model: SparklineModel,
): string {
  const { ctx } = inputs;
  const granularity = timeTicks(model.from ?? 0, model.to ?? 0).granularity;
  const fromLabel = traceLabel(model.from ?? 0, granularity, ctx.locale);
  const toLabel = isRecentReading(model.to ?? 0, inputs.nowMs)
    ? ctx.t('overview.sparklineNow')
    : traceLabel(model.to ?? 0, granularity, ctx.locale);
  const lastValue =
    model.lastValue !== undefined
      ? `${formatNumber(model.lastValue, metric.precision?.[displayUnit])} ${unitLabel(ctx.units, displayUnit, ctx.t)}`.trim()
      : '';
  return ctx.t('overview.sparklineSummary', {
    from: fromLabel,
    to: toLabel,
    n: model.count,
    value: lastValue,
    trend: longTermTrendText(ctx, metric, inputs.measurements),
  });
}

/** An axis label at the granularity the shared span calls for. */
function traceLabel(ms: number, granularity: TimeGranularity, locale: Locale): string {
  const date = new Date(ms);
  if (granularity === 'year') return String(date.getFullYear());
  // `M/YYYY` is spelled out rather than delegated, so both locales agree.
  if (granularity === 'month') return `${date.getMonth() + 1}/${date.getFullYear()}`;
  return new Intl.DateTimeFormat(INTL_TAG[locale], { day: 'numeric', month: 'numeric' }).format(date);
}

/**
 * The long-term direction as one phrase — the SAME `trend` result the summary's
 * "Long-term trend" column shows, never a second calculation.
 */
export function longTermTrendText(
  ctx: AppContext,
  metric: Metric,
  measurements: readonly Measurement[],
): string {
  const series = seriesFor([...measurements], metric.id);
  const key = TREND_PHRASE_KEY[trend(series, ctx.units, metric)];
  return key !== undefined ? ctx.t(key) : '';
}

const TREND_PHRASE_KEY: Record<ReturnType<typeof trend>, StringKey | undefined> = {
  rising: 'overview.tileTrendUp',
  falling: 'overview.tileTrendDown',
  flat: 'overview.tileTrendFlat',
  fluctuating: 'overview.tileTrendVolatile',
  insufficient: undefined,
};

/** Turn the trace data into a row element (`variant` styles the print copy). */
export function traceRow(ctx: AppContext, data: TraceData, variant?: string): HTMLElement {
  return sparklineRow({
    model: data.model,
    singleNote: ctx.t('overview.sparklineSingle'),
    summary: data.summary,
    ...(variant ? { variant } : {}),
  });
}

/** The shared axis strip that dates every trace of the set. */
export function traceAxis(set: TraceSet): HTMLElement {
  return sparklineAxis(set.ticks, TRACE_W);
}
