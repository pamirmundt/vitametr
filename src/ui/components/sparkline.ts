/**
 * Row trend trace — the second line under a metric's row in the overview list
 * and in the print summary.
 *
 * A trace, not a chart: no Y axis, no legend, no numbers, no gridlines, no
 * intermediate dots. Layers bottom-up, matching `chart.ts`: the source-stated
 * reference band, the polyline, then the end marker. The period is named only by
 * the two labels flanking the trace — each row carries its OWN domain, so there
 * is nothing to compare across rows and no shared axis is implied.
 *
 * The SVG is stretched horizontally (`preserveAspectRatio="none"`), which would
 * squash a `<circle>` into an ellipse. Markers are therefore drawn as zero-length
 * paths with a round linecap and `vector-effect="non-scaling-stroke"`: the cap is
 * stroked in device space, so the dot stays round at any aspect ratio — the same
 * reason the trace's own stroke keeps its width.
 */

import type { SparklineModel } from '../chart-model';
import './sparkline.css';

const SVG_NS = 'http://www.w3.org/2000/svg';

export interface SparklineOptions {
  model: SparklineModel;
  /** Muted note shown over a single-reading trace ("jedno měření"). */
  singleNote?: string;
  /** Sentence read by assistive tech in place of the (aria-hidden) graphics. */
  summary?: string;
  /** Extra class, e.g. `metric-spark-row--print` for the grey print variant. */
  variant?: string;
}

/** One mark of the shared axis: its x in viewBox units and its label. */
export interface SparklineTick {
  x: number;
  label: string;
}

/**
 * Build the trace row: the stretched trace plus a visually hidden sentence
 * carrying the same information as text. The row is inert — no focus stop, no
 * tooltip; the metric row around it stays the only tap target. The period is
 * named once, by the shared axis strip below the list — not per row.
 */
export function sparklineRow(opts: SparklineOptions): HTMLElement {
  const { model } = opts;
  const row = document.createElement('div');
  row.className = opts.variant ? `metric-spark-row ${opts.variant}` : 'metric-spark-row';

  const plot = document.createElement('div');
  plot.className = 'metric-spark-plot';
  plot.append(sparklineSvg(model));
  if (model.single && opts.singleNote !== undefined) {
    // Absolutely positioned so the note never takes width from the trace.
    const note = document.createElement('span');
    note.className = 'metric-spark-single muted';
    note.textContent = opts.singleNote;
    plot.append(note);
  }
  row.append(plot);

  if (opts.summary !== undefined) {
    const sr = document.createElement('span');
    sr.className = 'visually-hidden';
    sr.textContent = opts.summary;
    row.append(sr);
  }
  return row;
}

/**
 * The shared time axis, drawn ONCE under the traces it belongs to: a hairline
 * with a tick and a label at each calendar mark. Every trace above it uses the
 * same domain, so one strip dates them all — per-row labels would repeat the
 * same period on every line and still not fit.
 *
 * Positions are percentages of the same nominal box the traces are stretched
 * from, so a mark lands exactly under the gridline inside each trace.
 */
export function sparklineAxis(ticks: readonly SparklineTick[], width: number): HTMLElement {
  const axis = document.createElement('div');
  axis.className = 'metric-spark-axis';
  axis.setAttribute('aria-hidden', 'true');
  for (const tick of ticks) {
    const pct = (tick.x / width) * 100;
    const mark = document.createElement('span');
    mark.className = 'metric-spark-tick';
    mark.style.left = `${round2(pct)}%`;
    // The end marks would overflow the strip if they stayed centred, so they
    // hang inwards instead.
    if (pct < 6) mark.style.transform = 'none';
    else if (pct > 94) mark.style.transform = 'translateX(-100%)';
    mark.textContent = tick.label;
    axis.append(mark);
  }
  return axis;
}

/** The trace itself. Aria-hidden: the row's summary sentence carries the meaning. */
export function sparklineSvg(model: SparklineModel): SVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'metric-spark-svg');
  svg.setAttribute('viewBox', `0 0 ${model.width} ${model.height}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  if (model.isEmpty) return svg;

  // 0. The shared axis marks, as hairlines behind everything: without them a row
  //    would carry no clue WHERE on the common timeline its trace sits.
  for (const x of model.grid) {
    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('class', 'metric-spark-grid');
    line.setAttribute('x1', String(x));
    line.setAttribute('x2', String(x));
    line.setAttribute('y1', '0');
    line.setAttribute('y2', String(model.height));
    line.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.append(line);
  }

  // 1. The range the SOURCE stated, stepwise. Never tinted — it is not a claim.
  for (const band of model.bands) {
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('class', 'metric-spark-band');
    rect.setAttribute('x', String(round2(band.x)));
    rect.setAttribute('y', String(round2(band.y)));
    rect.setAttribute('width', String(round2(band.width)));
    rect.setAttribute('height', String(round2(band.height)));
    svg.append(rect);
  }

  // 2. The trace.
  if (model.polyline !== '') {
    const line = document.createElementNS(SVG_NS, 'polyline');
    line.setAttribute('class', 'metric-spark-line');
    line.setAttribute('points', model.polyline);
    line.setAttribute('fill', 'none');
    line.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.append(line);
  }

  // 2b. Every other reading as a small dot, so a short series reads as a chart
  //     rather than as a line drawn across the row.
  for (const r of model.readings) {
    svg.append(dot(r.x, r.y, 'metric-spark-reading'));
  }

  // 3. Censored readings (`<` / `>`): joined by the line, marked hollow — a ring
  //    made of a filled dot with a smaller surface-coloured dot on top.
  for (const c of model.censored) {
    svg.append(dot(c.x, c.y, 'metric-spark-censored-ring'));
    svg.append(dot(c.x, c.y, 'metric-spark-censored-core'));
  }

  // 4. The end marker, warn-coloured only when the last reading is out of range.
  if (model.last !== undefined) {
    svg.append(
      dot(
        model.last.x,
        model.last.y,
        model.lastOutOfRange ? 'metric-spark-end is-out' : 'metric-spark-end',
      ),
    );
  }
  return svg;
}

/**
 * A round marker that survives the non-uniform stretch: a zero-length path whose
 * round linecap is stroked in device space. Its diameter is the CSS stroke-width.
 */
function dot(x: number, y: number, className: string): SVGElement {
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('class', className);
  path.setAttribute('d', `M${x},${y}L${x},${y}`);
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('vector-effect', 'non-scaling-stroke');
  path.setAttribute('fill', 'none');
  return path;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
