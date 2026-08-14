/**
 * Health summary report — display-first.
 *
 * An on-screen summary of everything tracked: an "attention" section
 * (out-of-range / long-unmeasured / mixed-unit series), then a table per
 * category with latest value, reference position, change, long-term trend and
 * how recently it was measured. A print button reuses the same layout for a
 * doctor-ready PDF via the browser. Only descriptive, data-backed statements —
 * no diagnosis (spec §11).
 */

import './report.css';
import type { AppContext, RouteState, View } from '../app-context';
import type { StringKey } from '../../i18n/index';
import { formatDateTime, formatNumber } from '../../i18n/index';
import { unitLabel, valueWithUnitEl } from '../format-value';
import {
  ageMonths,
  buildReport,
  buildSnapshotReport,
  composeReportTitle,
  SNAPSHOT_AGE_DAYS,
  type AttentionItem,
  type AttentionReason,
  type ReportRow,
  type SnapshotReportRow,
} from './report-model';
import { profileDisplayName } from './settings-model';
import {
  applyPreset,
  buildFilterGroups,
  describeSelection,
  FILTER_PRESETS,
  groupCounts,
  matchesQuery,
  printableIds,
  startsExpanded,
  toFilterMetric,
  type FilterMetric,
  type FilterPreset,
} from './report-filter-model';
import {
  buildSparklineSeries,
  clipToPeriod,
  DEFAULT_SPARKLINE_MODE,
  type SparklineMode,
} from './sparkline-model';
import { OTHER_TAG, tagLabel, WATCHED_TAG } from '../../core/tags';
import type { Locale } from '../../i18n/index';
import {
  buildTraceSet,
  traceAxis,
  traceRow,
  type TraceInputs,
  type TraceSet,
} from './sparkline-view';
import { endOfDayMs } from '../../core/snapshot';
import type { Metric, MetricCategory, MetricId } from '../../core/types';

type ReportMode = 'range' | 'snapshot';

/**
 * A metric subset the Overview hands off when its "Summary / print" button is
 * used under an active filter: the pre-selected metric ids plus a display label
 * (a tag name, or "selection of {n} metrics"). Passed via module state — mirrors
 * review's `setPendingImport` — so the ISO-date route param stays free for the
 * snapshot date; the two compose. Read once, on the report's entry.
 */
export interface ReportSelection {
  metricIds: MetricId[];
  label?: string;
}

let pendingSelection: ReportSelection | undefined;

/** Store the subset the report should preselect on its next entry. */
export function setReportSelection(selection: ReportSelection): void {
  pendingSelection = selection;
}

/** Read (and clear) the pending subset; `undefined` ⇒ the full report. */
export function takeReportSelection(): ReportSelection | undefined {
  const selection = pendingSelection;
  pendingSelection = undefined;
  return selection;
}

/** The calendar day (YYYY-MM-DD) of an ISO instant. */
function isoDay(iso: string): string {
  return /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : iso;
}

declare const __APP_VERSION__: string;

const CATEGORY_KEY: Record<MetricCategory, StringKey> = {
  lab: 'report.category.lab',
  home: 'report.category.home',
  wearable: 'report.category.wearable',
  custom: 'report.category.custom',
};

const RANGE_KEY: Record<ReportRow['rangeState'], StringKey | undefined> = {
  below: 'range.below',
  above: 'range.above',
  'in-range': 'range.within',
  unknown: undefined,
};

const INTL_TAG: Record<Locale, string> = { cs: 'cs-CZ', en: 'en-US' };

/** Label of each quick preset — also the word the closed state uses. */
const PRESET_KEY: Record<FilterPreset, StringKey> = {
  watched: 'summary.quickWatched',
  outliers: 'summary.quickOutliers',
  'with-data': 'summary.quickWithData',
  all: 'summary.quickAll',
  none: 'summary.quickNone',
};

const TREND_KEY: Record<ReportRow['trend'], StringKey | undefined> = {
  rising: 'metric.detail.trend.rising',
  falling: 'metric.detail.trend.falling',
  fluctuating: 'metric.detail.trend.fluctuating',
  flat: 'metric.detail.trend.flat',
  insufficient: undefined,
};

export const reportView: View = {
  render(container: HTMLElement, ctx: AppContext, route: RouteState): void {
    const { t } = ctx;
    container.replaceChildren();

    const data = ctx.data();

    // A route param carrying an ISO date pre-selects snapshot mode at that date
    // (F2: the Overview "export this state" hand-off). Otherwise range mode.
    const paramDay =
      route?.param && /^\d{4}-\d{2}-\d{2}/.test(route.param) ? route.param.slice(0, 10) : undefined;
    let mode: ReportMode = paramDay ? 'snapshot' : 'range';
    let asOfIso = paramDay ?? isoDay(ctx.now());

    // The metric subset handed off by a filtered Overview (read once on entry;
    // orthogonal to the date mode, so it survives the range/snapshot toggle).
    const selection = takeReportSelection();
    const subsetLabel = selection?.label;

    // Universe of selectable metrics = every non-hidden metric with any data
    // (the full report's rows), each carrying the facts the picker's presets ask
    // about: was it ever out of range, does it have data in the shown period.
    // Rebuilt whenever the shown period changes: the ids stay, the facts behind
    // "out of range" / "with data in period" are re-derived (spec §3 — changing
    // the period recomputes the counts, never the selection).
    let universe = buildUniverse(ctx, data, undefined);
    let universePeriod: number | undefined;
    const universeIds = new Set(universe.map((u) => u.metricId));

    // The selection, in precedence order: a hand-off from a filtered Overview
    // (this visit only, never written back), else the saved per-profile choice,
    // else everything. Ids that no longer exist are dropped on read.
    const savedIds = data.settings.reportMetricIds;
    const selectedIds = new Set<MetricId>(
      selection
        ? selection.metricIds.filter((id) => universeIds.has(id))
        : savedIds
          ? savedIds.filter((id) => universeIds.has(id))
          : universe.map((u) => u.metricId),
    );
    /** Persist the current choice (never on the Overview hand-off path). */
    const saveSelection = (): void => {
      const ids = [...selectedIds];
      ctx.mutate((d) => {
        d.settings.reportMetricIds = ids;
      });
    };

    // Trend traces in the summary: their OWN setting, deliberately not shared
    // with the Overview toggle — the print may need to differ from the screen.
    let sparkMode: SparklineMode = data.settings.reportSparkline ?? DEFAULT_SPARKLINE_MODE;
    // What the checkbox restores when it is ticked again within this visit.
    let lastShownMode: SparklineMode = sparkMode === 'hidden' ? DEFAULT_SPARKLINE_MODE : sparkMode;

    const root = el('div', 'report');

    // Back to the Overview (like the metric detail); hidden when printing.
    const back = el('button', 'report-back') as HTMLButtonElement;
    back.type = 'button';
    back.textContent = `‹ ${t('metric.detail.back')}`;
    back.addEventListener('click', () => ctx.navigate('overview'));
    root.append(back);

    // Header — title and the toolbar share one aligned row; the toolbar stays in
    // .report-toolbar so it is hidden when printing.
    const header = el('header', 'report-header');
    const titleRow = el('div', 'report-titlerow');
    const h1 = textEl('h1', '');
    titleRow.append(h1);

    const toolbar = el('div', 'report-toolbar');

    // Range | As-of-date mode switch.
    const modeSeg = el('div', 'report-mode-segment');
    const modeBtns: { id: ReportMode; btn: HTMLButtonElement }[] = [];
    for (const m of [
      { id: 'range' as ReportMode, labelKey: 'export.mode.range' as StringKey },
      { id: 'snapshot' as ReportMode, labelKey: 'export.mode.snapshot' as StringKey },
    ]) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'report-mode-btn';
      btn.textContent = t(m.labelKey);
      btn.addEventListener('click', () => {
        mode = m.id;
        paint();
      });
      modeSeg.append(btn);
      modeBtns.push({ id: m.id, btn });
    }
    toolbar.append(modeSeg);

    // As-of date input (snapshot mode only).
    const dateInput = document.createElement('input');
    dateInput.type = 'date';
    dateInput.className = 'report-asof-date';
    dateInput.value = asOfIso;
    dateInput.setAttribute('aria-label', t('export.asOfDateLabel'));
    dateInput.addEventListener('change', () => {
      if (dateInput.value) asOfIso = dateInput.value;
      paint();
    });
    toolbar.append(dateInput);

    // Trend trace: a checkbox for "at all" and the same three-way choice the
    // Overview has. They are one state — unticking is "Hidden", picking "Hidden"
    // unticks — so the two controls can never disagree.
    const sparkWrap = el('div', 'report-spark-control');
    const sparkToggleLabel = el('label', 'report-spark-check');
    const sparkCheck = document.createElement('input');
    sparkCheck.type = 'checkbox';
    sparkToggleLabel.append(sparkCheck, textEl('span', t('print.sparkline')));
    const sparkSeg = el('div', 'seg report-spark-toggle');
    sparkSeg.setAttribute('role', 'group');
    sparkSeg.setAttribute('aria-label', t('overview.sparkline'));
    sparkWrap.append(sparkToggleLabel, sparkSeg);

    const sparkBtns: { mode: SparklineMode; btn: HTMLButtonElement }[] = [];
    const updateSparkControl = (): void => {
      sparkCheck.checked = sparkMode !== 'hidden';
      for (const { mode, btn } of sparkBtns) {
        const on = mode === sparkMode;
        btn.classList.toggle('seg-btn--active', on);
        btn.setAttribute('aria-pressed', String(on));
      }
    };
    const setSparkMode = (next: SparklineMode): void => {
      if (next === sparkMode) return;
      sparkMode = next;
      if (next !== 'hidden') lastShownMode = next;
      ctx.mutate((d) => {
        d.settings.reportSparkline = next;
      });
      updateSparkControl();
      paint();
    };
    for (const opt of [
      { mode: 'hidden' as SparklineMode, key: 'overview.sparklineHidden' as StringKey },
      { mode: 'outliers' as SparklineMode, key: 'overview.sparklineOutliers' as StringKey },
      { mode: 'all' as SparklineMode, key: 'overview.sparklineAll' as StringKey },
    ]) {
      const btn = el('button', 'seg-btn seg-btn--text') as HTMLButtonElement;
      btn.type = 'button';
      btn.textContent = t(opt.key);
      btn.addEventListener('click', () => setSparkMode(opt.mode));
      sparkBtns.push({ mode: opt.mode, btn });
      sparkSeg.append(btn);
    }
    sparkCheck.addEventListener('change', () => {
      setSparkMode(sparkCheck.checked ? lastShownMode : 'hidden');
    });
    updateSparkControl();
    toolbar.append(sparkWrap);

    const printBtn = document.createElement('button');
    printBtn.className = 'primary';
    printBtn.textContent = t('report.print');
    printBtn.addEventListener('click', () => window.print());
    // Nothing selected ⇒ nothing to print; the closed picker says why.
    const updatePrintBtn = (): void => {
      printBtn.disabled = selectedIds.size === 0;
    };
    toolbar.append(printBtn);

    titleRow.append(toolbar);
    header.append(titleRow);
    const meta = el('p', 'muted');
    header.append(meta);

    // Screen-only metric picker. Closed by default — the summary must begin with
    // the summary, not with 77 checkboxes. Never printed (`@media print`).
    const pickerHost = el('div', 'report-picker-host');
    // Selection changes are announced here rather than by moving focus.
    const live = el('div', 'visually-hidden');
    live.setAttribute('role', 'status');
    live.setAttribute('aria-live', 'polite');
    if (universe.length > 0) header.append(pickerHost, live);

    root.append(header);

    const body = el('div', 'report-body');
    root.append(body);

    root.append(textEl('p', t('report.disclaimer'), 'report-disclaimer muted'));
    root.append(textEl('p', `Vitametr v${versionString()}`, 'report-footer muted'));

    container.append(root);

    // --- Metric picker ------------------------------------------------------
    // Panel state. `open` deliberately does NOT persist: the spec wants the
    // summary to open on the summary every time. The query narrows the LIST; it
    // never touches the selection — that is what the preset chips are for.
    let pickerOpen = false;
    let pickerQuery = '';
    const collapsedGroups = new Set<string>();

    updatePrintBtn();
    if (universe.length > 0) renderPicker();
    paint();

    function renderPicker(): void {
      pickerHost.replaceChildren(pickerOpen ? openPicker() : closedPicker());
    }

    /** Re-render the panel and the report body after any selection change. */
    function selectionChanged(announce = true): void {
      saveSelection();
      updatePrintBtn();
      renderPicker();
      paint();
      if (announce) live.textContent = t('summary.selectedAnnounce', { n: selectedIds.size });
    }

    /** The default: one line saying what is selected, plus the way in. */
    function closedPicker(): HTMLElement {
      const card = el('div', 'report-picker report-picker--closed');
      const text = el('div', 'report-picker-text');
      text.append(
        textEl(
          'div',
          t('summary.metricsShown', { n: selectedIds.size, total: universe.length }),
          'report-picker-count tnum',
        ),
      );
      const preset = describeSelection(selectedIds, universe);
      text.append(
        textEl(
          'div',
          t('summary.selectionSummary', {
            preset: preset ? t(PRESET_KEY[preset]) : t('summary.selectionCustom'),
            period: periodLabel(),
          }),
          'report-picker-sub muted',
        ),
      );
      if (selectedIds.size === 0) {
        text.append(textEl('div', t('summary.pickAtLeastOne'), 'report-picker-warn'));
      }
      card.append(text);
      const edit = el('button', 'ghost report-picker-edit') as HTMLButtonElement;
      edit.type = 'button';
      edit.textContent = t('summary.editSelection');
      edit.addEventListener('click', () => {
        pickerOpen = true;
        renderPicker();
        pickerHost.querySelector<HTMLInputElement>('.report-picker-search')?.focus();
      });
      card.append(edit);
      return card;
    }

    /** The expanded panel: search, preset chips, then the tag groups. */
    function openPicker(): HTMLElement {
      const card = el('div', 'report-picker report-picker--open');
      card.addEventListener('keydown', (ev) => {
        if ((ev as KeyboardEvent).key !== 'Escape') return;
        pickerOpen = false;
        renderPicker();
        pickerHost.querySelector<HTMLButtonElement>('.report-picker-edit')?.focus();
      });

      const head = el('div', 'report-picker-head');
      head.append(
        textEl(
          'div',
          t('summary.metricsShown', { n: selectedIds.size, total: universe.length }),
          'report-picker-count tnum',
        ),
      );
      const done = el('button', 'ghost') as HTMLButtonElement;
      done.type = 'button';
      done.textContent = t('summary.done');
      done.addEventListener('click', () => {
        pickerOpen = false;
        renderPicker();
      });
      head.append(done);
      card.append(head);
      if (selectedIds.size === 0) {
        card.append(textEl('p', t('summary.pickAtLeastOne'), 'report-picker-warn'));
      }

      const search = document.createElement('input');
      search.type = 'search';
      search.className = 'report-picker-search';
      search.placeholder = t('summary.searchMetric');
      search.setAttribute('aria-label', t('summary.searchMetric'));
      search.value = pickerQuery;
      search.addEventListener('input', () => {
        pickerQuery = search.value;
        // Only the list changes, so the search box keeps its focus and caret.
        renderGroups();
      });
      card.append(search);

      // Quick presets. These are buttons, not toggles: each SETS the selection.
      const chips = el('div', 'report-picker-chips');
      for (const preset of FILTER_PRESETS) {
        const chip = el(
          'button',
          preset === 'none' ? 'report-picker-chip report-picker-chip--none' : 'report-picker-chip',
        ) as HTMLButtonElement;
        chip.type = 'button';
        chip.textContent = t(PRESET_KEY[preset]);
        if (describeSelection(selectedIds, universe) === preset) chip.classList.add('is-active');
        chip.addEventListener('click', () => {
          selectedIds.clear();
          for (const id of applyPreset(preset, universe)) selectedIds.add(id);
          selectionChanged();
        });
        chips.append(chip);
      }
      card.append(chips);

      const groupHost = el('div', 'report-picker-groups');
      card.append(groupHost);

      /** Rebuild just the group list (search keeps focus). */
      function renderGroups(): void {
        groupHost.replaceChildren();
        const searching = pickerQuery.trim() !== '';
        let shown = 0;
        for (const group of buildFilterGroups(universe, INTL_TAG[ctx.locale])) {
          const entries = group.entries.filter((m) => matchesQuery(m, pickerQuery));
          if (entries.length === 0) continue;
          shown += entries.length;
          // A search shows its hits open; otherwise the spec's rule applies and
          // the user's own collapse wins over it.
          const tag = group.tag ?? OTHER_TAG;
          const expanded = searching
            ? true
            : !collapsedGroups.has(tag) && startsExpanded(group, selectedIds, WATCHED_TAG);
          groupHost.append(renderGroup(tag, entries, expanded, searching, renderGroups));
        }
        if (shown === 0) groupHost.append(textEl('p', t('summary.noMatch'), 'muted'));
      }
      renderGroups();
      return card;
    }

    /** One tag group: a disclosure heading with its counts and All / None. */
    function renderGroup(
      tag: string,
      entries: readonly FilterMetric[],
      expanded: boolean,
      searching: boolean,
      rerender: () => void,
    ): HTMLElement {
      const section = el('section', 'report-picker-group');
      const counts = groupCounts(entries, selectedIds);
      const listId = `picker-group-${tag.replace(/[^a-z0-9]+/gi, '-')}`;
      const label = tagLabel(tag, t);

      const head = el('div', 'report-picker-group-head');
      const toggle = el('button', 'report-picker-group-toggle') as HTMLButtonElement;
      toggle.type = 'button';
      toggle.setAttribute('aria-expanded', String(expanded));
      toggle.setAttribute('aria-controls', listId);
      // Read as a sentence, not as a bare number.
      toggle.setAttribute(
        'aria-label',
        t('summary.groupAria', { tag: label, selected: counts.selected, total: counts.total }),
      );
      toggle.append(
        textEl('span', label, 'report-picker-group-name'),
        textEl(
          'span',
          t('summary.groupCount', { selected: counts.selected, total: counts.total }),
          'report-picker-group-count tnum muted',
        ),
      );
      toggle.addEventListener('click', () => {
        // A search forces every hit open, so collapsing is only meaningful (and
        // only remembered) outside one.
        if (searching) return;
        if (collapsedGroups.has(tag)) collapsedGroups.delete(tag);
        else collapsedGroups.add(tag);
        rerender();
      });
      head.append(toggle);

      const bulk = el('div', 'report-picker-group-bulk');
      for (const [key, on] of [
        ['summary.groupAll' as StringKey, true],
        ['summary.groupNone' as StringKey, false],
      ] as const) {
        const btn = el('button', 'report-picker-bulk') as HTMLButtonElement;
        btn.type = 'button';
        btn.textContent = t(key);
        btn.addEventListener('click', () => {
          for (const m of entries) {
            if (on) selectedIds.add(m.metricId);
            else selectedIds.delete(m.metricId);
          }
          selectionChanged();
        });
        bulk.append(btn);
      }
      head.append(bulk);
      section.append(head);

      const list = el('div', 'report-picker-list');
      list.id = listId;
      list.setAttribute('role', 'group');
      list.hidden = !expanded;
      for (const m of entries) list.append(pickerItem(m));
      section.append(list);
      return section;
    }

    /** One metric row: checkbox first, name right beside it, whole row clickable. */
    function pickerItem(m: FilterMetric): HTMLElement {
      const on = selectedIds.has(m.metricId);
      const label = el('label', on ? 'report-picker-item is-on' : 'report-picker-item');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'report-picker-check';
      cb.checked = on;
      cb.addEventListener('change', () => {
        if (cb.checked) selectedIds.add(m.metricId);
        else selectedIds.delete(m.metricId);
        selectionChanged();
      });
      const name = textEl('span', m.name, 'report-picker-name');
      if (!m.hasDataInPeriod) {
        // Ticked but nothing to print: say so instead of silently dropping it.
        name.append(textEl('span', t('summary.noDataInPeriod'), 'report-picker-nodata muted'));
      }
      label.append(cb, name);
      return label;
    }

    /** How the closed picker names the shown period (there is no range picker). */
    function periodLabel(): string {
      return mode === 'snapshot' ? formatDateTime(asOfIso, 'date') : t('report.periodAll');
    }

    function paint(): void {
      // The period drives "with data in period" and the "no data" note, so the
      // facts (never the selection) are re-derived when it moves.
      const periodTo = mode === 'snapshot' ? endOfDayMs(asOfIso) : undefined;
      if (periodTo !== universePeriod) {
        universePeriod = periodTo;
        universe = buildUniverse(ctx, data, periodTo);
        if (universe.length > 0) renderPicker();
      }

      // Title + meta reflect the mode.
      h1.textContent =
        mode === 'snapshot'
          ? composeReportTitle(
              t('report.snapshotTitle', { date: formatDateTime(asOfIso, 'date') }),
              subsetLabel,
            )
          : subsetLabel
            ? t('report.subsetTitle', { label: subsetLabel })
            : t('report.title');
      meta.textContent =
        `${t('report.profile')}: ${profileDisplayName(data.profile.name, t)} · ` +
        t('report.generated', { date: formatDateTime(ctx.now(), 'datetime') });
      dateInput.hidden = mode !== 'snapshot';
      for (const { id, btn } of modeBtns) {
        const active = id === mode;
        btn.classList.toggle('is-active', active);
        if (active) btn.setAttribute('aria-current', 'true');
        else btn.removeAttribute('aria-current');
      }

      body.replaceChildren();
      // What this paint's traces are built from. In snapshot mode the chosen
      // date both ends the shared domain and is the reference for "today"; the
      // range report follows the data itself.
      const traceInputs: TraceInputs = {
        ctx,
        measurements: data.measurements,
        mode: sparkMode,
        ...(mode === 'snapshot' ? { periodTo: endOfDayMs(asOfIso) } : {}),
        nowMs: Date.parse(mode === 'snapshot' ? asOfIso : ctx.now()),
      };
      if (mode === 'snapshot') paintSnapshot(traceInputs);
      else paintRange(traceInputs);
    }

    /** The traces of the whole report share one domain — across sections too. */
    function traceSetFor(inputs: TraceInputs, metricIds: readonly MetricId[]): TraceSet {
      const catalog = ctx.catalog();
      const metrics: Metric[] = [];
      for (const id of metricIds) {
        const metric = catalog.byId(id);
        if (metric) metrics.push(metric);
      }
      return buildTraceSet(inputs, metrics);
    }

    function paintRange(inputs: TraceInputs): void {
      // Only metrics with data in the period are printed — a tick is intent,
      // this is the outcome (spec §3).
      const model = buildReport(
        data,
        ctx.catalog(),
        ctx.units,
        ctx.locale,
        ctx.now(),
        printableIds(selectedIds, universe),
      );
      if (model.totalMetrics === 0) {
        body.append(textEl('p', t('report.empty'), 'muted'));
        return;
      }
      if (model.attention.length > 0) body.append(attentionBox(ctx, model.attention));
      const traces = traceSetFor(
        inputs,
        model.categories.flatMap((c) => c.rows.map((r) => r.metricId)),
      );
      for (const cat of model.categories) {
        const section = el('section', 'report-section');
        section.append(textEl('h2', t(CATEGORY_KEY[cat.category])));
        section.append(renderCards(ctx, cat.rows, traces));
        section.append(renderTable(ctx, cat.rows, traces));
        body.append(section);
      }
    }

    function paintSnapshot(inputs: TraceInputs): void {
      const model = buildSnapshotReport(
        data,
        ctx.catalog(),
        ctx.units,
        ctx.locale,
        asOfIso,
        printableIds(selectedIds, universe),
      );
      if (model.totalMetrics === 0) {
        body.append(textEl('p', t('report.empty'), 'muted'));
        return;
      }
      const traces = traceSetFor(inputs, model.rows.map((r) => r.metricId));
      const section = el('section', 'report-section');
      section.append(renderSnapshotCards(ctx, model.rows, traces));
      section.append(renderSnapshotTable(ctx, model.rows, traces));
      body.append(section);
    }
  },
};

/** Snapshot table: Metric | Value | Reference | Measured | Source. */
function renderSnapshotTable(
  ctx: AppContext,
  rows: SnapshotReportRow[],
  traces: TraceSet,
): HTMLElement {
  const { t } = ctx;
  const scroll = el('div', 'report-scroll');
  const table = document.createElement('table');

  const columns: StringKey[] = [
    'report.metric',
    'report.value',
    'report.reference',
    'report.measured',
    'report.source',
  ];
  const head = document.createElement('tr');
  for (const key of columns) {
    const th = document.createElement('th');
    th.textContent = t(key);
    head.append(th);
  }
  table.append(head);

  let drew = false;
  for (const r of rows) {
    const tr = document.createElement('tr');
    if (isSnapshotOutOfRange(r)) tr.className = 'out-of-range';
    tr.append(td(snapshotMetricName(ctx, r)));
    tr.append(valueCell(ctx, r, 'num'));
    tr.append(snapshotReferenceCell(ctx, r));
    tr.append(measuredCell(ctx, r));
    tr.append(td(r.sourceName ?? '—'));
    table.append(tr);
    if (appendTraceRow(ctx, table, tr, traces, r.metricId, columns.length)) drew = true;
  }
  appendAxisRow(table, traces, columns.length, drew);
  scroll.append(table);
  return scroll;
}

/** Stacked snapshot card-rows for narrow screens. */
function renderSnapshotCards(
  ctx: AppContext,
  rows: SnapshotReportRow[],
  traces: TraceSet,
): HTMLElement {
  const { t } = ctx;
  const list = el('div', 'report-cards');
  let drew = false;
  for (const r of rows) {
    const card = el('div', 'report-card');
    if (isSnapshotOutOfRange(r)) card.className = 'report-card out-of-range';
    card.append(textEl('div', snapshotMetricName(ctx, r), 'report-card-name'));
    const grid = el('dl', 'report-card-grid');
    valueInto(ctx, r, cardField(grid, t('report.value'), ''));
    const refDd = cardField(grid, t('report.reference'), '');
    snapshotReferenceInto(ctx, r, refDd);
    const measuredDd = cardField(grid, t('report.measured'), '');
    measuredInto(ctx, r, measuredDd);
    cardField(grid, t('report.source'), r.sourceName ?? '—');
    card.append(grid);
    if (appendCardTrace(ctx, card, traces, r.metricId)) drew = true;
    list.append(card);
  }
  appendCardsAxis(list, traces, drew);
  return list;
}

/**
 * The trace as a SECOND table row spanning every column, right under the
 * metric's own row — the same "trace under the values" shape the Overview list
 * has. It is not a column: with six content columns there is no width left for
 * a trace worth looking at, on screen or on paper.
 *
 * Does nothing when this metric draws no trace (mode, or no numeric history).
 */
function appendTraceRow(
  ctx: AppContext,
  table: HTMLElement,
  valueRow: HTMLElement,
  traces: TraceSet,
  metricId: MetricId,
  colspan: number,
): boolean {
  const data = traces.get(metricId);
  if (!data) return false;

  // The value row keeps its tint but drops its rule: the pair reads as ONE row
  // of the table, closed by the trace row underneath.
  valueRow.classList.add('has-spark');
  const tr = document.createElement('tr');
  tr.className = valueRow.classList.contains('out-of-range')
    ? 'report-spark-row out-of-range'
    : 'report-spark-row';
  const cell = document.createElement('td');
  cell.colSpan = colspan;
  cell.append(traceRow(ctx, data));
  tr.append(cell);
  table.append(tr);
  return true;
}

/** The card's own trace: a full-width line under the field grid. */
function appendCardTrace(
  ctx: AppContext,
  card: HTMLElement,
  traces: TraceSet,
  metricId: MetricId,
): boolean {
  const data = traces.get(metricId);
  if (!data) return false;
  card.append(traceRow(ctx, data, 'report-card-spark'));
  return true;
}

/**
 * Close a table with the shared axis: one full-width row naming the calendar
 * marks every trace above repeats as a faint gridline. Skipped when the table
 * drew no trace at all.
 */
function appendCardsAxis(list: HTMLElement, traces: TraceSet, drew: boolean): void {
  if (!drew || traces.ticks.length === 0) return;
  const wrap = el('div', 'report-cards-axis');
  wrap.append(traceAxis(traces));
  list.append(wrap);
}

function appendAxisRow(table: HTMLElement, traces: TraceSet, colspan: number, drew: boolean): void {
  if (!drew || traces.ticks.length === 0) return;
  const tr = document.createElement('tr');
  tr.className = 'report-spark-axis-row';
  const cell = document.createElement('td');
  cell.colSpan = colspan;
  cell.append(traceAxis(traces));
  tr.append(cell);
  table.append(tr);
}

function isSnapshotOutOfRange(r: SnapshotReportRow): boolean {
  return r.rangeState === 'above' || r.rangeState === 'below';
}

function snapshotMetricName(ctx: AppContext, r: SnapshotReportRow): string {
  if (r.customName) return r.customName;
  if (r.nameKey) return ctx.t(r.nameKey as StringKey);
  return '';
}

/**
 * Fill `node` with a reading via the shared value+unit formatter (numeric →
 * `<span class="value-unit">` with proper power typography; qualitative → text).
 * Shared by the range and snapshot reports (both carry value/operator/unit).
 */
function valueInto(
  ctx: AppContext,
  r: { value?: number; operator?: import('../../core/types').Operator; unit: string; textValue?: string },
  node: HTMLElement,
): void {
  if (r.value === undefined) {
    node.textContent = r.textValue ?? '';
    return;
  }
  const unit = unitLabel(ctx.units, r.unit, ctx.t);
  node.append(
    valueWithUnitEl({
      value: r.value,
      ...(unit ? { unit } : {}),
      ...(r.operator ? { operator: r.operator } : {}),
    }),
  );
}

/** A `<td>` holding a reading via {@link valueInto}. */
function valueCell(
  ctx: AppContext,
  r: { value?: number; operator?: import('../../core/types').Operator; unit: string; textValue?: string },
  className?: string,
): HTMLElement {
  const cell = document.createElement('td');
  if (className) cell.className = className;
  valueInto(ctx, r, cell);
  return cell;
}

function snapshotReferenceCell(ctx: AppContext, r: SnapshotReportRow): HTMLElement {
  const cell = document.createElement('td');
  snapshotReferenceInto(ctx, r, cell);
  return cell;
}

function snapshotReferenceInto(ctx: AppContext, r: SnapshotReportRow, node: HTMLElement): void {
  const hasRange = r.refLow !== undefined || r.refHigh !== undefined;
  node.textContent = hasRange
    ? `${r.refLow !== undefined ? formatNumber(r.refLow) : ''}–${r.refHigh !== undefined ? formatNumber(r.refHigh) : ''}`
    : '—';
  const rangeKey = RANGE_KEY[r.rangeState];
  if (rangeKey && isSnapshotOutOfRange(r)) {
    const pill = el('span', `pill ${r.rangeState}`);
    pill.textContent = ctx.t(rangeKey);
    node.append(document.createTextNode(' '), pill);
  }
}

/** Measured date + a muted "measured N months ago" note for old values. */
function measuredCell(ctx: AppContext, r: SnapshotReportRow): HTMLElement {
  const cell = document.createElement('td');
  measuredInto(ctx, r, cell);
  return cell;
}

function measuredInto(ctx: AppContext, r: SnapshotReportRow, node: HTMLElement): void {
  node.textContent = formatDateTime(r.measuredIso, 'date');
  if (r.ageDays >= SNAPSHOT_AGE_DAYS) {
    const age = el('span', 'report-age muted');
    age.textContent = ctx.t('report.snapshotAge', { months: ageMonths(r.ageDays) });
    node.append(document.createTextNode(' '), age);
  }
}

function renderTable(ctx: AppContext, rows: ReportRow[], traces: TraceSet): HTMLElement {
  const { t } = ctx;
  const scroll = el('div', 'report-scroll');
  const table = document.createElement('table');

  const columns: StringKey[] = [
    'report.metric',
    'report.latest',
    'report.reference',
    'report.change',
    'report.trend',
    'report.measured',
  ];
  const head = document.createElement('tr');
  for (const key of columns) {
    const th = document.createElement('th');
    th.textContent = t(key);
    head.append(th);
  }
  table.append(head);

  let drew = false;
  for (const r of rows) {
    const tr = document.createElement('tr');
    if (isOutOfRange(r)) tr.className = 'out-of-range';
    tr.append(td(metricName(ctx, r)));
    tr.append(valueCell(ctx, r, 'num'));
    tr.append(referenceCell(ctx, r));
    tr.append(td(changeText(ctx, r), 'num'));
    tr.append(td(trendText(ctx, r)));
    tr.append(td(formatDateTime(r.lastMeasuredIso, 'date')));
    table.append(tr);
    if (appendTraceRow(ctx, table, tr, traces, r.metricId, columns.length)) drew = true;
  }
  appendAxisRow(table, traces, columns.length, drew);
  scroll.append(table);
  return scroll;
}

/** Stacked card-rows for narrow screens (the table overflows there). */
function renderCards(ctx: AppContext, rows: ReportRow[], traces: TraceSet): HTMLElement {
  const { t } = ctx;
  const list = el('div', 'report-cards');
  let drew = false;
  for (const r of rows) {
    const card = el('div', 'report-card');
    if (isOutOfRange(r)) card.className = 'report-card out-of-range';
    card.append(textEl('div', metricName(ctx, r), 'report-card-name'));
    const grid = el('dl', 'report-card-grid');
    valueInto(ctx, r, cardField(grid, t('report.latest'), ''));
    const refDd = cardField(grid, t('report.reference'), '');
    referenceInto(ctx, r, refDd);
    cardField(grid, t('report.change'), changeText(ctx, r));
    cardField(grid, t('report.trend'), trendText(ctx, r));
    cardField(grid, t('report.measured'), formatDateTime(r.lastMeasuredIso, 'date'));
    card.append(grid);
    if (appendCardTrace(ctx, card, traces, r.metricId)) drew = true;
    list.append(card);
  }
  appendCardsAxis(list, traces, drew);
  return list;
}

/** Append a labeled dt/dd pair; returns the dd for further content. */
function cardField(grid: HTMLElement, label: string, value: string): HTMLElement {
  grid.append(textEl('dt', label));
  const dd = textEl('dd', value);
  grid.append(dd);
  return dd;
}

function isOutOfRange(r: ReportRow): boolean {
  return r.rangeState === 'above' || r.rangeState === 'below';
}

function trendText(ctx: AppContext, r: ReportRow): string {
  const key = TREND_KEY[r.trend];
  return key ? ctx.t(key) : '—';
}

function metricName(ctx: AppContext, r: { nameKey?: string; customName?: string }): string {
  if (r.customName) return r.customName;
  if (r.nameKey) return ctx.t(r.nameKey as StringKey);
  return '';
}

/**
 * Everything the picker can offer: each metric the full report would have a row
 * for, plus the two facts its presets ask about. "Ever out of range" reuses the
 * trace's own series builder rather than re-deriving the comparison, so the
 * chip, the trace and the row can never disagree.
 */
function buildUniverse(
  ctx: AppContext,
  data: ReturnType<AppContext['data']>,
  periodTo: number | undefined,
): FilterMetric[] {
  const catalog = ctx.catalog();
  const rows = buildReport(data, catalog, ctx.units, ctx.locale, ctx.now()).categories.flatMap(
    (c) => c.rows,
  );
  const out: FilterMetric[] = [];
  for (const r of rows) {
    const metric = catalog.byId(r.metricId);
    if (!metric) continue;
    const { points, everOutOfRange } = buildSparklineSeries(
      metric,
      data.measurements,
      ctx.units,
      metric.canonicalUnit,
    );
    out.push(
      toFilterMetric(metric, metricName(ctx, r), {
        everOutOfRange,
        hasDataInPeriod: clipToPeriod(points, { to: periodTo }).length > 0,
      }),
    );
  }
  return out;
}

function referenceCell(ctx: AppContext, r: ReportRow): HTMLElement {
  const cell = document.createElement('td');
  referenceInto(ctx, r, cell);
  return cell;
}

/** Fill `node` with the reference range (or "—" when absent) plus a state pill. */
function referenceInto(ctx: AppContext, r: ReportRow, node: HTMLElement): void {
  const hasRange = r.refLow !== undefined || r.refHigh !== undefined;
  const rangeText = hasRange
    ? `${r.refLow !== undefined ? formatNumber(r.refLow) : ''}–${r.refHigh !== undefined ? formatNumber(r.refHigh) : ''}`
    : '—';
  node.textContent = rangeText;
  const rangeKey = RANGE_KEY[r.rangeState];
  if (rangeKey && isOutOfRange(r)) {
    const pill = el('span', `pill ${r.rangeState}`);
    pill.textContent = ctx.t(rangeKey);
    node.append(document.createTextNode(' '), pill);
  }
}

function changeText(ctx: AppContext, r: ReportRow): string {
  if (r.deltaKind === 'up' && r.deltaAmount !== undefined) {
    return ctx.t('overview.change.up', { amount: formatNumber(r.deltaAmount) });
  }
  if (r.deltaKind === 'down' && r.deltaAmount !== undefined) {
    return ctx.t('overview.change.down', { amount: formatNumber(r.deltaAmount) });
  }
  if (r.deltaKind === 'same') return ctx.t('overview.change.same');
  return '—';
}

/**
 * The attention box, in up to three labelled groups.
 *
 * The state belongs in the heading, not on every line: repeating "outside the
 * source reference range" after each of five metrics says the same thing five
 * times and still leaves the reader guessing what "now" means for a value taken
 * in January. So each group states the fact once and its lines carry only what
 * differs — the metric and its date.
 */
const ATTENTION_GROUPS: readonly {
  reasons: readonly AttentionReason[];
  key: StringKey;
  cls: string;
}[] = [
  { reasons: ['out-of-range'], key: 'report.attentionCurrent', cls: 'attn-group--now' },
  { reasons: ['past-out-of-range'], key: 'report.attentionPast', cls: 'attn-group--past' },
  { reasons: ['stale', 'mixed-units'], key: 'report.attentionNotes', cls: 'attn-group--notes' },
];

function attentionBox(ctx: AppContext, items: readonly AttentionItem[]): HTMLElement {
  const { t } = ctx;
  const box = el('section', 'report-attention');
  box.append(textEl('h2', t('report.attention')));
  for (const group of ATTENTION_GROUPS) {
    const mine = items.filter((i) => group.reasons.includes(i.reason));
    if (mine.length === 0) continue;
    const section = el('div', `attn-group ${group.cls}`);
    section.append(textEl('h3', t(group.key), 'attn-group-title'));
    const ul = document.createElement('ul');
    for (const item of mine) ul.append(attentionLi(ctx, item));
    section.append(ul);
    box.append(section);
  }
  return box;
}

/** One line: the metric, then only what this line adds beyond its heading. */
function attentionLi(ctx: AppContext, item: AttentionItem): HTMLElement {
  const { t } = ctx;
  const li = document.createElement('li');
  li.append(textEl('span', metricName(ctx, item), 'attn-name'));

  let detail: string;
  if (item.reason === 'out-of-range') {
    // The latest reading can be months old, so it is dated. Having been outside
    // the range before is the difference between a blip and a pattern.
    detail = item.lastIso ? formatDateTime(item.lastIso, 'date') : '';
    if (item.count) {
      detail += `${detail ? ' · ' : ''}${t('report.alsoBefore', { count: item.count })}`;
    }
  } else if (item.reason === 'past-out-of-range') {
    detail = t('report.attentionPastLine', {
      count: item.count ?? 0,
      date: item.lastIso ? formatDateTime(item.lastIso, 'date') : '—',
    });
  } else if (item.reason === 'stale') {
    detail = t('report.stale', { days: item.days ?? 0 });
  } else {
    detail = t('report.mixedUnits');
  }
  if (detail) li.append(textEl('span', detail, 'attn-detail'));

  li.addEventListener('click', () => ctx.navigate('metric', item.metricId));
  return li;
}

function versionString(): string {
  return typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function el(tag: string, className?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}
function textEl(tag: string, text: string, className?: string): HTMLElement {
  const node = el(tag, className);
  node.textContent = text;
  return node;
}
function td(text: string, className?: string): HTMLElement {
  const node = document.createElement('td');
  node.textContent = text;
  if (className) node.className = className;
  return node;
}
