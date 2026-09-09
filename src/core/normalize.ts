/**
 * Input normalization (step K6a).
 *
 * Pure functions that clean up raw human input before it enters the domain
 * model: numbers with a decimal comma or point, censoring operators, unit
 * spellings, dates/times, and metric names resolved against the catalog.
 *
 * Design rules:
 * - Never guess. An unrecognized unit or metric is reported as such, never
 *   silently mapped to something plausible (spec §16).
 * - The original text is never destroyed; callers keep `rawText` alongside
 *   the normalized fields.
 * - No DOM, no storage, no clock. Dates are parsed from explicit input only;
 *   `Date.now()` / argless `new Date()` are deliberately not used.
 */

import type { Catalog } from './contracts.js';
import { isDistinctSpecimen, splitAnalyteName } from './lab-names.js';
import type { Metric, MetricId, Operator, ProposedMeasurement, TimePrecision } from './types.js';
import { UNITS } from './units-data.js';
import { createUnitsEngine, isUnitCompatibleWithMetric } from './units.js';

/**
 * Shared engine for the dimension guard below. Built from the built-in unit
 * table and never reloaded — a unit spelling outside it has already been
 * dropped by {@link normalizeUnit} before the guard is reached.
 */
const unitsEngine = createUnitsEngine();

// ---------------------------------------------------------------------------
// parseNumber
// ---------------------------------------------------------------------------

export type ParseNumberResult =
  | { value: number; operator?: Operator }
  | { error: 'empty' | 'not-a-number' };

/** Leading operator spellings mapped to the canonical Operator. */
const OPERATOR_MAP: ReadonlyArray<readonly [string, Operator]> = [
  // Longer / multi-char forms first so '<=' wins over '<'.
  ['<=', '<='],
  ['>=', '>='],
  ['≤', '<='],
  ['≥', '>='],
  ['<', '<'],
  ['>', '>'],
];

/**
 * Parse a raw numeric string. Handles a decimal comma or point, spaces and
 * NBSP as thousands separators, and a leading censoring operator
 * (`<`, `>`, `≤`, `≥`, `<=`, `>=`). Never returns NaN.
 */
export function parseNumber(raw: string): ParseNumberResult {
  let s = raw.trim();
  if (s === '') return { error: 'empty' };

  let operator: Operator | undefined;
  for (const [token, op] of OPERATOR_MAP) {
    if (s.startsWith(token)) {
      operator = op;
      s = s.slice(token.length).trim();
      break;
    }
  }

  if (s === '') return { error: 'not-a-number' };

  // Remove spaces and NBSP used as thousands separators.
  s = s.replace(/[\s  ]/g, '');

  // Unify the decimal separator: a comma is only ever a decimal separator in
  // this app (thousands separators were spaces, now removed).
  s = s.replace(/,/g, '.');

  // Accept an optional sign and exactly one decimal point.
  if (!/^[+-]?(\d+(\.\d+)?|\.\d+)$/.test(s)) {
    return { error: 'not-a-number' };
  }

  const value = Number(s);
  if (Number.isNaN(value)) return { error: 'not-a-number' };

  return operator ? { value, operator } : { value };
}

// ---------------------------------------------------------------------------
// normalizeUnit
// ---------------------------------------------------------------------------

/**
 * Build a lookup key from a raw unit string: lowercased, whitespace removed,
 * micro sign / Greek mu unified to 'u', caret exponent unified to '*'.
 */
function unitKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s  ]/g, '')
    .replace(/[µμ]/g, 'u') // micro sign U+00B5 and Greek small mu U+03BC
    .replace(/²/g, '2') // superscript two (e.g. 1.73 m²) -> '2'
    .replace(/³/g, '3') // superscript three -> '3'
    .replace(/\^/g, '*'); // 10^9 -> 10*9
}

/**
 * Synonym table: normalized key -> UCUM code present in UNITS. Keys are the
 * output of {@link unitKey}, so they are already lowercased and stripped of
 * whitespace; add spellings here, never in the engine.
 */
const UNIT_SYNONYMS: Readonly<Record<string, string>> = {
  // molar concentration
  'mmol/l': 'mmol/L',
  'umol/l': 'umol/L',
  'nmol/l': 'nmol/L',
  // mass concentration
  'g/l': 'g/L',
  'g/dl': 'g/dL',
  'mg/l': 'mg/L',
  'mg/dl': 'mg/dL',
  'ug/l': 'ug/L',
  'mcg/l': 'ug/L',
  'ug/dl': 'ug/dL',
  'mcg/dl': 'ug/dL',
  'ng/ml': 'ng/mL',
  // enzymatic activity
  'u/l': 'U/L',
  'ukat/l': 'ukat/L',
  // international units (e.g. TSH)
  'miu/l': 'm[IU]/L',
  // Czech lab sheets commonly write the milli-international-unit as "mU/L".
  'mu/l': 'm[IU]/L',
  // Seen in the wild: a capital I typed for the litre "l" ("mU/I"). unitKey
  // lowercases, so this entry catches it without touching any real unit.
  'mu/i': 'm[IU]/L',
  // pressure
  mmhg: 'mm[Hg]',
  kpa: 'kPa',
  // temperature
  '°c': 'Cel',
  c: 'Cel',
  cel: 'Cel',
  // fraction
  '%': '%',
  'mmol/mol': 'mmol/mol',
  // count concentration
  '10*9/l': '10*9/L',
  '10*12/l': '10*12/L',
  // eGFR: Czech ml/s per 1.73 m² and the ml/min form (single-token spellings;
  // unitKey lowercases and strips whitespace but keeps the decimal comma).
  'ml/s/1,73m2': 'mL/s/{1.73_m2}',
  'ml/s/1.73m2': 'mL/s/{1.73_m2}',
  'ml/min/1,73m2': 'mL/min/{1.73_m2}',
  'ml/min/1.73m2': 'mL/min/{1.73_m2}',
  // A line parser tokenizes on spaces, so "1,4 ml/s/1,73 m²" yields the unit token
  // "ml/s/1,73" without the trailing "m²" — accept that truncated form too.
  'ml/s/1,73': 'mL/s/{1.73_m2}',
  'ml/s/1.73': 'mL/s/{1.73_m2}',
  'ml/min/1,73': 'mL/min/{1.73_m2}',
  'ml/min/1.73': 'mL/min/{1.73_m2}',
  // urine-sediment count per microlitre (µ/μ already folded to 'u' by unitKey)
  'pocet/ul': '/uL',
  'počet/ul': '/uL',
  '/ul': '/uL',
  'elem/ul': '/uL',
  // rate
  '/min': '/min',
  bpm: '/min',
  'tep/min': '/min',
  // mass / length
  kg: 'kg',
  g: 'g',
  cm: 'cm',
  m: 'm',
};

/**
 * Full spelling -> UCUM code lookup. Every unit in UNITS is reachable by its
 * own code AND its display form (both run through {@link unitKey}), so the
 * table can never drift behind UNITS; UNIT_SYNONYMS only adds genuinely
 * alternate spellings (mcg/l, bpm, °c, …) on top and wins on any overlap.
 */
const UNIT_LOOKUP: Readonly<Record<string, string>> = (() => {
  const map: Record<string, string> = {};
  for (const u of UNITS) {
    map[unitKey(u.code)] = u.code;
    map[unitKey(u.display)] = u.code;
  }
  return { ...map, ...UNIT_SYNONYMS };
})();

/**
 * Map a human unit spelling to the UCUM code used in UNITS. Case-insensitive
 * and whitespace-tolerant. Returns undefined for anything unrecognized —
 * the caller must not guess.
 */
export function normalizeUnit(raw: string): string | undefined {
  if (raw.trim() === '') return undefined;
  return UNIT_LOOKUP[unitKey(raw)];
}

// ---------------------------------------------------------------------------
// parseDateTime
// ---------------------------------------------------------------------------

export interface ParsedDateTime {
  iso: string;
  precision: TimePrecision;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Validate a calendar date by round-tripping through explicit Date args. */
function isValidYmd(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const d = new Date(year, month - 1, day);
  return (
    d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day
  );
}

function isValidTime(hour: number, minute: number): boolean {
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}

function buildIso(
  year: number,
  month: number,
  day: number,
  time: { hour: number; minute: number } | undefined,
): ParsedDateTime {
  const date = `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`;
  if (time) {
    return {
      iso: `${date}T${pad2(time.hour)}:${pad2(time.minute)}`,
      precision: 'datetime',
    };
  }
  return { iso: date, precision: 'date' };
}

// ISO: 2026-07-21 or 2026-07-21T08:30 (optionally with seconds).
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::\d{2})?)?$/;
// Czech / slash: 21.7.2026 or 21. 7. 2026 or 21/7/2026, optional time.
const DMY_RE =
  /^(\d{1,2})\s*[./]\s*(\d{1,2})\s*[./]\s*(\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/;

/**
 * Parse an ISO, Czech (dd.mm.yyyy) or slash date, optionally with a time.
 * Date-only input yields precision 'date'; a time yields 'datetime'.
 * Impossible dates return undefined.
 */
export function parseDateTime(raw: string): ParsedDateTime | undefined {
  const s = raw.trim();
  if (s === '') return undefined;

  const iso = ISO_RE.exec(s);
  if (iso) {
    const year = Number(iso[1]);
    const month = Number(iso[2]);
    const day = Number(iso[3]);
    if (!isValidYmd(year, month, day)) return undefined;
    if (iso[4] !== undefined) {
      const hour = Number(iso[4]);
      const minute = Number(iso[5]);
      if (!isValidTime(hour, minute)) return undefined;
      return buildIso(year, month, day, { hour, minute });
    }
    return buildIso(year, month, day, undefined);
  }

  const dmy = DMY_RE.exec(s);
  if (dmy) {
    const day = Number(dmy[1]);
    const month = Number(dmy[2]);
    const year = Number(dmy[3]);
    if (!isValidYmd(year, month, day)) return undefined;
    if (dmy[4] !== undefined) {
      const hour = Number(dmy[4]);
      const minute = Number(dmy[5]);
      if (!isValidTime(hour, minute)) return undefined;
      return buildIso(year, month, day, { hour, minute });
    }
    return buildIso(year, month, day, undefined);
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// resolveMetric
// ---------------------------------------------------------------------------

export type ResolveMetricResult = { metricId: MetricId } | { unresolvedName: string };

/**
 * What a trailing qualifier on an analyte name says about the row.
 *
 * `plain` qualifiers say nothing about WHICH analyte it is — which tube the
 * blood came in, or that the lab computed the value instead of measuring it —
 * so the name is simply retried without them. `relative` and `absolute` do
 * pick a metric: the white-cell differential exists both as a share of all
 * leukocytes and as an absolute count, and those are separate metrics that
 * move independently. A qualifier of that kind is therefore checked against
 * the metric that comes back, and a mismatch leaves the row unresolved rather
 * than putting a count onto the share's history (spec §16).
 */
type QualifierKind = 'relative' | 'absolute' | 'plain';

/** Qualifier spellings, keyed by {@link qualifierKey}. */
const QUALIFIERS: ReadonlyMap<string, QualifierKind> = new Map<string, QualifierKind>([
  ['rel', 'relative'],
  ['relativ', 'relative'],
  ['relativne', 'relative'],
  ['relative', 'relative'],
  ['relativepercentage', 'relative'],
  ['abs', 'absolute'],
  ['abspocet', 'absolute'],
  ['absolutnipocet', 'absolute'],
  ['absolutne', 'absolute'],
  ['absolute', 'absolute'],
  ['absolutecount', 'absolute'],
  ['vyp', 'plain'],
  ['vypocet', 'plain'],
  ['vypocteno', 'plain'],
  ['vypocitano', 'plain'],
  ['calc', 'plain'],
  ['calculated', 'plain'],
  // Serum and plasma are where a biochemistry analyte is normally measured, so
  // naming the tube is decoration — the same reading the `S_`/`P_` prefixes get.
  // "Whole blood" is deliberately NOT here: it is a different matrix and shifts
  // the value (whole-blood glucose runs some 11 % below plasma), so a name that
  // says it belongs in review rather than on the plasma metric's history.
  ['vplazme', 'plain'],
  ['vseru', 'plain'],
  ['inplasma', 'plain'],
  ['inserum', 'plain'],
]);

/** Comparison key: lowercase, no diacritics, no punctuation, no spaces. */
function qualifierKey(raw: string): string {
  return raw
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

/**
 * The longest trailing qualifier the name carries, and the name without it.
 * Never consumes the whole name — a qualifier alone is not an analyte.
 */
function splitQualifier(name: string): { base: string; kind: QualifierKind } | undefined {
  const tokens = name.split(/\s+/).filter((t) => t !== '');
  // Longest tail first, so "abs. počet" wins over "počet".
  for (let take = Math.min(3, tokens.length - 1); take >= 1; take--) {
    const kind = QUALIFIERS.get(qualifierKey(tokens.slice(tokens.length - take).join('')));
    if (kind === undefined) continue;
    const base = tokens
      .slice(0, tokens.length - take)
      .join(' ')
      .replace(/[\s\-–,;:]+$/u, '')
      .trim();
    if (base !== '') return { base, kind };
  }
  return undefined;
}

/** Unit codes that express a share of a whole (%, a bare ratio, L/L, …). */
const FRACTION_UNITS: ReadonlySet<string> = new Set(
  UNITS.filter((u) => u.dimension === 'fraction').map((u) => u.code),
);

/** True when the metric records a share rather than a count or a concentration. */
function isShareMetric(metric: Metric): boolean {
  return (
    FRACTION_UNITS.has(metric.canonicalUnit) || metric.units.some((u) => FRACTION_UNITS.has(u))
  );
}

/** Whether the metric that came back is the twin the qualifier asked for. */
function qualifierFits(kind: QualifierKind, metric: Metric): boolean {
  if (kind === 'plain') return true;
  return kind === 'relative' ? isShareMetric(metric) : !isShareMetric(metric);
}

/**
 * A trailing method-version year, as labs append to a computed estimate's name
 * ("CKD-EPI 2021", "MDRD 2006"). It identifies the equation revision, not a
 * different analyte, so it is dropped on a retry.
 */
const METHOD_YEAR_RE = /^(.*\S)\s+(?:19|20)\d{2}\s*$/;

/**
 * Resolve a metric name against the catalog's alias index. On a miss, return
 * the name as `unresolvedName` — never a guess.
 *
 * Candidates are tried in decreasing order of certainty: the name as written,
 * then the name with lab bookkeeping removed (specimen prefix and code
 * columns, see {@link splitAnalyteName}), a trailing "Full name (ABBR)"
 * parenthetical, and a method-version year. The catalog's own matching is
 * tolerant of case, diacritics and punctuation, so "25OH vitamin D" finds the
 * alias "25-OH vitamin D" without a candidate of its own.
 *
 * A non-blood specimen (`U_`, `dU_`, `F_`) is binding: it resolves only against
 * that specimen's own metric and never falls back to the blood one, because a
 * urine glucose is a different measurement from a blood glucose (spec §16).
 */
export function resolveMetric(name: string, catalog: Catalog): ResolveMetricResult {
  const trimmed = name.trim();
  const hit = catalog.resolveAlias(trimmed);
  if (hit) return { metricId: hit.id };

  // Lab bookkeeping around the name: "HAD AM S_Kreatinin" -> "Kreatinin".
  const { name: bare, specimen } = splitAnalyteName(trimmed);
  if (isDistinctSpecimen(specimen)) {
    const qualified =
      catalog.resolveAlias(`${bare} v moči`) ??
      catalog.resolveAlias(`${bare} in urine`) ??
      (specimen === 'stool' ? catalog.resolveAlias(`${bare} ve stolici`) : undefined);
    return qualified ? { metricId: qualified.id } : { unresolvedName: bare };
  }
  if (bare !== trimmed) {
    const stripped = catalog.resolveAlias(bare);
    if (stripped) return { metricId: stripped.id };
  }

  // Common lab style "Full name (ABBR)" — e.g. "Glykovaný hemoglobin (HbA1c)"
  // or "Volný tyroxin (fT4)". Retry with the trailing parenthetical removed,
  // then with the parenthetical content alone. Square brackets are the same
  // convention in another sheet's typography ("Leukocyty [WBC]").
  const paren = /^(.*?)\s*[([]([^)\]]+)[)\]]\s*$/.exec(bare);
  if (paren) {
    const base = paren[1].trim();
    const inner = paren[2].trim();
    // A specimen/matrix qualifier — "(moč)" / "(urine)" — is NOT an abbreviation:
    // it marks a distinct specimen, so we must never fall back to the bare base
    // (a urine analyte would otherwise resolve onto its blood metric). Resolve
    // only the urine-qualified name ("X v moči"); if that has no catalog home,
    // leave it unresolved for review rather than guess the wrong specimen.
    if (/^(moč|moči|urine)$/iu.test(inner)) {
      const urine = base !== '' && catalog.resolveAlias(`${base} v moči`);
      return urine ? { metricId: urine.id } : { unresolvedName: bare };
    }
    const alt = (base !== '' && catalog.resolveAlias(base)) || (inner !== '' && catalog.resolveAlias(inner));
    if (alt) return { metricId: alt.id };

    // "Lipoprotein Lp(a)": here the parenthesis belongs to the abbreviation, so
    // the analyte's name is the trailing TOKEN — not the words in front of it,
    // and not the single letter inside the brackets.
    const lastToken = bare.split(/\s+/).pop() ?? '';
    if (lastToken !== bare && /[([]/.test(lastToken)) {
      const abbreviated = catalog.resolveAlias(lastToken);
      if (abbreviated) return { metricId: abbreviated.id };
    }
  }

  const year = METHOD_YEAR_RE.exec(bare);
  if (year) {
    const withoutYear = catalog.resolveAlias(year[1]);
    if (withoutYear) return { metricId: withoutYear.id };
  }

  // Last: a trailing qualifier. Retried through the whole chain above, so a
  // name may carry more than one ("Leukocyty [WBC] - relativně").
  const qualified = splitQualifier(bare);
  if (qualified) {
    const inner = resolveMetric(qualified.base, catalog);
    if ('metricId' in inner) {
      const metric = catalog.byId(inner.metricId);
      if (metric && qualifierFits(qualified.kind, metric)) return { metricId: inner.metricId };
    }
  }

  return { unresolvedName: bare };
}

// ---------------------------------------------------------------------------
// normalizeProposal
// ---------------------------------------------------------------------------

const CONFIDENCE_ORDER: ReadonlyArray<ProposedMeasurement['confidence']> = [
  'low',
  'medium',
  'high',
];

/** Lower confidence by one step, never below 'low'. */
function lowerConfidence(
  c: ProposedMeasurement['confidence'],
): ProposedMeasurement['confidence'] {
  const i = CONFIDENCE_ORDER.indexOf(c);
  return CONFIDENCE_ORDER[Math.max(0, i - 1)];
}

/**
 * Normalize a raw proposal: resolve an unresolved metric name and normalize
 * the unit string, filling the normalized fields while preserving `rawText`.
 * An unrecognized unit is dropped to undefined and confidence is lowered.
 * The input is never mutated; a new object is returned.
 */
export function normalizeProposal(
  p: ProposedMeasurement,
  catalog: Catalog,
): ProposedMeasurement {
  const out: ProposedMeasurement = { ...p };

  // Unit first: the metric guard below compares against the normalized code.
  // Normalize when present; drop and lower confidence if unrecognized.
  if (out.unit !== undefined) {
    const normalized = normalizeUnit(out.unit);
    if (normalized === undefined) {
      out.unit = undefined;
      out.confidence = lowerConfidence(out.confidence);
    } else {
      out.unit = normalized;
    }
  }

  // Metric: attempt resolution only when still unresolved.
  if (typeof out.metric === 'object' && 'unresolvedName' in out.metric) {
    const rawName = out.metric.unresolvedName;
    const resolved = resolveMetric(rawName, catalog);
    if ('metricId' in resolved) {
      // Dimension guard (spec §16, data integrity): a name is only trustworthy
      // when the row's unit can belong to that metric at all. A file's own
      // parser applies the same guard, and normalization must not undo it —
      // an unconvertible unit on the right-sounding name is a reading that
      // could never be drawn on that metric's chart, so the row goes to review
      // under its own name instead.
      const metric = catalog.byId(resolved.metricId);
      const fits =
        metric === undefined ||
        out.unit === undefined ||
        isUnitCompatibleWithMetric(unitsEngine, metric, out.unit);
      out.metric = fits ? resolved.metricId : { unresolvedName: rawName };
    } else {
      out.metric = { unresolvedName: resolved.unresolvedName };
    }
  }

  return out;
}
