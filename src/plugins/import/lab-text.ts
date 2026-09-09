/**
 * Lab-result line parser (phase 3).
 *
 * A PDF lab sheet is extracted to text lines elsewhere (pdf.js — not this
 * module's concern). This file is the PURE function that turns those lines
 * into measurement proposals. It has zero runtime dependencies beyond the
 * shared normalization helpers and never touches the DOM, storage or a clock.
 *
 * A typical analyte row looks like:
 *
 *   <name words> <value> [flag] <unit> <refLow> - <refHigh>
 *
 * where the flag (H / L / * or the Czech arrows ↑ / ↓) is optional and the
 * value uses a decimal comma. The document's draw date lives once in the
 * header ("Odběr: 10.02.2023 07:45") and is shared by every proposal.
 *
 * Design rule (spec §16): never guess. An unrecognized unit or metric name is
 * reported as such; a line that lacks both a numeric value AND a recognized
 * unit is not an analyte row and produces nothing — this is how title, meta
 * and column-header lines fall away naturally.
 */

import type { Catalog } from '../../core/contracts.js';
import type { Metric, ProposedMeasurement } from '../../core/types.js';
import { splitAnalyteName } from '../../core/lab-names.js';
import { normalizeUnit, parseDateTime, parseNumber, resolveMetric } from '../../core/normalize.js';
import { createUnitsEngine, isUnitCompatibleWithMetric } from '../../core/units.js';

/**
 * Shared units engine for the import dimension guard. Built from the built-in
 * unit table; pure and read-only here (never reloaded), so a single instance is
 * safe to share across calls.
 */
const unitsEngine = createUnitsEngine();

/** A Czech date DD.MM.YYYY, optionally followed by a HH:MM time. */
const DATE_RE = /(\d{1,2}\.\d{1,2}\.\d{4}(?:[ \t]+\d{1,2}:\d{2})?)/;

/** A bare number: decimal comma or point, no sign, no operator. */
const NUM = String.raw`\d+(?:[.,]\d+)?`;

/**
 * Trailing reference expressions, tried in order. Every pattern is anchored at
 * the end of the line and starts with `\s+`, so it only ever consumes the
 * range that follows the value+unit — never part of them.
 *
 * Supported styles:
 *  - `od X do Y`            -> refLow = X, refHigh = Y   (Czech "from X to Y")
 *  - `X - Y` / `X – Y`      -> refLow = X, refHigh = Y   (hyphen or en dash)
 *  - `do X`                 -> refHigh = X               (Czech "up to X")
 *  - `nad X`                -> refLow = X                (Czech "above X")
 *  - `< X` / `≤ X` / `<= X` -> refHigh = X
 *  - `> X` / `≥ X` / `>= X` -> refLow = X
 *
 * The Czech `od …/do …/nad …` word forms are matched case-insensitively and
 * require whitespace on both sides, so they never bite into a metric name.
 */
const REF_OD_DO_RE = new RegExp(String.raw`\s+od\s+(${NUM})\s+do\s+(${NUM})\s*$`, 'i');
const REF_RANGE_RE = new RegExp(String.raw`\s+(${NUM})\s*[-–]\s*(${NUM})\s*$`);
const REF_DO_RE = new RegExp(String.raw`\s+do\s+(${NUM})\s*$`, 'i');
const REF_NAD_RE = new RegExp(String.raw`\s+nad\s+(${NUM})\s*$`, 'i');
const REF_LE_RE = new RegExp(String.raw`\s+(?:<=|≤|<)\s*(${NUM})\s*$`);
const REF_GE_RE = new RegExp(String.raw`\s+(?:>=|≥|>)\s*(${NUM})\s*$`);

/** A result flag sitting between the value and the unit (H, L, *, ↑, ↓). */
const FLAG_RE = /^(?:[HL]|\*|↑|↓)$/i;

/** A standalone censoring operator token sitting before the value number. */
const OPERATOR_TOKEN_RE = /^(?:<=|>=|≤|≥|<|>)$/;

interface ReferenceMatch {
  refLow?: number;
  refHigh?: number;
  refText: string;
  /** Index in the working string where the matched expression begins. */
  index: number;
}

/** Parse a bare numeric bound; undefined when it is not a plain number. */
function parseBound(raw: string): number | undefined {
  const parsed = parseNumber(raw);
  return 'value' in parsed ? parsed.value : undefined;
}

/**
 * Strip and interpret the trailing reference expression, if any. Returns the
 * parsed bounds, the original range text, and where it started so the caller
 * can remove it from the line.
 */
function extractReference(working: string): ReferenceMatch | undefined {
  let m = REF_OD_DO_RE.exec(working);
  if (m) {
    return { refLow: parseBound(m[1]), refHigh: parseBound(m[2]), refText: m[0].trim(), index: m.index };
  }
  m = REF_RANGE_RE.exec(working);
  if (m) {
    return { refLow: parseBound(m[1]), refHigh: parseBound(m[2]), refText: m[0].trim(), index: m.index };
  }
  m = REF_DO_RE.exec(working);
  if (m) {
    return { refHigh: parseBound(m[1]), refText: m[0].trim(), index: m.index };
  }
  m = REF_NAD_RE.exec(working);
  if (m) {
    return { refLow: parseBound(m[1]), refText: m[0].trim(), index: m.index };
  }
  m = REF_LE_RE.exec(working);
  if (m) {
    return { refHigh: parseBound(m[1]), refText: m[0].trim(), index: m.index };
  }
  m = REF_GE_RE.exec(working);
  if (m) {
    return { refLow: parseBound(m[1]), refText: m[0].trim(), index: m.index };
  }
  return undefined;
}

/**
 * A date introduced by a draw/collection label. Matched first, because a result
 * sheet prints several dates and only this one is the measurement's time — the
 * patient's DATE OF BIRTH is usually printed above it (a plain "first date in
 * the document" rule silently backdates the whole import by decades).
 */
const DRAW_DATE_RE = new RegExp(
  String.raw`(?:odb[ěe]r\w*|odebr[áa]no|collect(?:ed|ion\s+date)|sampl(?:ed|e\s+date)|draw[n]?(?:\s+date)?)\s*:?\s*` +
    DATE_RE.source,
  'i',
);

/**
 * Lines whose date is definitely NOT the draw date: the patient's birth date
 * and the sheet's own printing/receipt stamps. Used only by the unlabelled
 * fallback scan, so a labelled draw date always wins outright.
 */
const NON_DRAW_LINE_RE =
  /datum\s+narozen[íi]|\bnar\.|date\s+of\s+birth|\bdob\b|sestaveno|vyd[áa]no|vyti[šs]t[ěe]no|p[řr]ijato|received|printed|reported/i;

/**
 * The draw date a line INTRODUCES, if any: a labelled collection date on a line
 * that is not a birth-date or print stamp. Used to re-date the rows that follow
 * it, so one document may carry several draws (see {@link parseLabLines}).
 */
function findSectionDate(line: string): { iso: string; precision: 'date' | 'datetime' } | undefined {
  if (NON_DRAW_LINE_RE.test(line)) return undefined;
  const match = DRAW_DATE_RE.exec(line);
  if (!match) return undefined;
  return parseDateTime(match[1]);
}

/**
 * Find the document's draw date: a labelled one anywhere in the document, else
 * the first date on a line that is not a birth-date/print-stamp line.
 */
function findDocumentDate(lines: string[]): { iso: string; precision: 'date' | 'datetime' } | undefined {
  for (const line of lines) {
    const match = DRAW_DATE_RE.exec(line);
    if (!match) continue;
    const parsed = parseDateTime(match[1]);
    if (parsed) return parsed;
  }
  for (const line of lines) {
    if (NON_DRAW_LINE_RE.test(line)) continue;
    const match = DATE_RE.exec(line);
    if (!match) continue;
    const parsed = parseDateTime(match[1]);
    if (parsed) return parsed;
  }
  return undefined;
}

/**
 * A graphical "evaluation" column — the in/out-of-range bar Czech result sheets
 * draw as pipes and a star (`| |*| |`). Some sheets print it after the
 * reference range, others between the value and the range, so it is removed
 * wherever it stands: left in place it either hides the end-anchored range or
 * separates the value from its own unit.
 *
 * A token qualifies only when it is made of bars and stars AND contains a bar —
 * a lone `*` is the high/low flag, which the value reader still needs.
 */
const BAR_TOKEN_RE = /^[|*]*\|[|*]*$/;

/**
 * The sample-type column many sheets close each row with: one letter naming the
 * material the analyte was measured in (B = blood, S = serum, U = urine …), the
 * same national convention as the `S_`/`U_` name prefixes. It has to go before
 * the unit is read — `S` also spells seconds and `G` grams, so a row ending in
 * one is otherwise read as having that unit, which drags the value one column
 * to the left with it.
 *
 * H and L are deliberately NOT in the set: those letters are the high/low result
 * flag far more often than they are heparin or liquor.
 */
const SAMPLE_COLUMN_RE = /^(?:dU|MK|SL|[BSPGCTNFU])$/;

/** Sample codes that mean a DIFFERENT metric, mapped to their name prefix. */
const ROUTING_SAMPLE: Readonly<Record<string, string>> = { U: 'U_', dU: 'dU_', F: 'F_' };

/** A name that already carries a specimen prefix must not be given a second one. */
const HAS_SPECIMEN_PREFIX_RE = /^(?:dU|Pu|[SPBUFC])_/i;

/** Remove layout artefacts that carry no data (the bar column, wherever it sits). */
function stripEvaluationColumn(line: string): string {
  return line
    .split(/\s+/)
    .filter((token) => token !== '' && !BAR_TOKEN_RE.test(token))
    .join(' ');
}

/**
 * Take the trailing sample-type column off a row. A material that means a
 * genuinely different analyte (urine, 24h urine, stool) is not dropped but
 * rewritten into the specimen prefix the name resolver already understands, so
 * one convention's `Glukóza … U` and another's `U_Glukóza` reach the same metric.
 */
function stripSampleColumn(line: string): string {
  const tokens = line.split(/\s+/);
  // Name + value + the column itself: fewer tokens than that is not a row.
  if (tokens.length < 3) return line;
  const last = tokens[tokens.length - 1];
  if (!SAMPLE_COLUMN_RE.test(last)) return line;
  const rest = tokens.slice(0, -1);
  const prefix = ROUTING_SAMPLE[last];
  if (prefix === undefined || HAS_SPECIMEN_PREFIX_RE.test(rest[0])) return rest.join(' ');
  return prefix + rest.join(' ');
}

/** True when the last token (past an optional flag) reads as a number. */
function endsInNumber(tokens: readonly string[]): boolean {
  let i = tokens.length - 1;
  if (i >= 0 && FLAG_RE.test(tokens[i])) i -= 1;
  if (i < 0) return false;
  return !('error' in parseNumber(tokens[i]));
}

/**
 * Try to parse a single line into a proposal. Returns undefined when the line
 * is not an analyte row (no numeric value together with a recognized unit).
 */
function parseLine(
  rawText: string,
  catalog: Catalog,
  date: { iso: string; precision: 'date' | 'datetime' } | undefined,
): ProposedMeasurement | undefined {
  // 1. Strip a trailing reference expression, if present.
  let refLow: number | undefined;
  let refHigh: number | undefined;
  let refText: string | undefined;
  let working = rawText.trim();

  const refMatch = extractReference(working);
  if (refMatch) {
    refLow = refMatch.refLow;
    refHigh = refMatch.refHigh;
    refText = refMatch.refText;
    working = working.slice(0, refMatch.index).trim();
  }

  const tokens = working.length > 0 ? working.split(/\s+/) : [];
  if (tokens.length === 0) return undefined;

  // 2. Unit: right-to-left, the first token normalizeUnit recognizes.
  let unitIndex = -1;
  let unitCode: string | undefined;
  for (let i = tokens.length - 1; i >= 0; i--) {
    const code = normalizeUnit(tokens[i]);
    if (code !== undefined) {
      unitIndex = i;
      unitCode = code;
      break;
    }
  }
  if (unitIndex < 0 || unitCode === undefined) return undefined;

  // 3. The other column order: `<name> <value> <range> <unit>`, used by sheets
  //    that print the unit to the RIGHT of the reference range. The range then
  //    sits inside what is left of the row, where the end-anchored patterns of
  //    step 1 could not see it — and the value reader below would take its
  //    upper bound for the result. Only tried when step 1 found no range at
  //    all, so the established layout is read exactly as before.
  let head = tokens.slice(0, unitIndex);
  if (refMatch === undefined) {
    const headText = head.join(' ');
    const inner = extractReference(headText);
    const shortened = inner
      ? headText
          .slice(0, inner.index)
          .trim()
          .split(/\s+/)
          .filter((t) => t !== '')
      : [];
    // Only a range that still leaves a value behind was a range: a censored
    // result ("Erytrocyty < 4 počet/μL") ends in the very shape a "< X" limit
    // has, and reading it as one would consume the result itself.
    if (inner && shortened.length >= 2 && endsInNumber(shortened)) {
      refLow = inner.refLow;
      refHigh = inner.refHigh;
      refText = inner.refText;
      head = shortened;
    }
  }

  // 4. Value: the last numeric token of what precedes the unit, skipping at
  //    most one flag token (H / L / * / ↑ / ↓). A censoring operator sitting
  //    just before the number (e.g. `< 0,10`) is folded back in so parseNumber
  //    captures the operator.
  let valueIndex = head.length - 1;
  if (valueIndex >= 0 && FLAG_RE.test(head[valueIndex])) valueIndex -= 1;
  if (valueIndex < 0) return undefined;

  let valueStart = valueIndex;
  if (valueStart - 1 >= 0 && OPERATOR_TOKEN_RE.test(head[valueStart - 1])) {
    valueStart -= 1;
  }

  const valueText = head.slice(valueStart, valueIndex + 1).join(' ');
  const parsedValue = parseNumber(valueText);
  if ('error' in parsedValue) return undefined;

  // 5. Name: everything before the value (and its operator) token.
  const name = head.slice(0, valueStart).join(' ').trim();
  if (name === '') return undefined;
  // Reject obvious non-analyte rows: a label ending in ':' (e.g. "Evaluation:")
  // or a "name" that is only digits/punctuation (a scrambled multi-column row).
  if (name.endsWith(':')) return undefined;
  if (!/\p{L}/u.test(name)) return undefined;

  // 6. Metric: resolve against the catalog; never guess.
  //    Dimension guard (spec §16, data integrity): a resolved name is only kept
  //    when the parsed unit is dimensionally compatible with that metric. A
  //    genuine mismatch (e.g. a GFR rate unit resolving onto creatinine via a
  //    "(Krea)" qualifier, or a urine-sediment count onto blood erythrocytes)
  //    is discarded and the row goes to review as unresolved — never a wrong
  //    metric.
  const resolved = resolveMetric(name, catalog);
  let metric: Metric['id'] | { unresolvedName: string };
  if ('metricId' in resolved) {
    const m = catalog.byId(resolved.metricId);
    metric =
      m && !isUnitCompatibleWithMetric(unitsEngine, m, unitCode)
        ? // Report the analyte's own name, without the lab's code columns, so
          // review shows "Kreatinin" rather than "HAD AM S_Kreatinin".
          { unresolvedName: splitAnalyteName(name).name }
        : resolved.metricId;
  } else {
    metric = { unresolvedName: resolved.unresolvedName };
  }

  // 7. Confidence: high needs a resolved metric AND a recognized unit AND a
  //    date. The unit is always recognized here, so a resolved metric is high
  //    when a date exists, otherwise medium; an unresolved metric is low.
  const isUnresolved = typeof metric === 'object' && 'unresolvedName' in metric;
  let confidence: ProposedMeasurement['confidence'];
  if (isUnresolved) confidence = 'low';
  else confidence = date ? 'high' : 'medium';

  const proposal: ProposedMeasurement = {
    metric,
    value: parsedValue.value,
    unit: unitCode,
    confidence,
    rawText,
  };
  if (parsedValue.operator !== undefined) proposal.operator = parsedValue.operator;
  if (refLow !== undefined) proposal.refLow = refLow;
  if (refHigh !== undefined) proposal.refHigh = refHigh;
  if (refText !== undefined) proposal.refText = refText;
  if (date) {
    proposal.takenAt = date.iso;
    proposal.timePrecision = date.precision;
  }

  return proposal;
}

// ---------------------------------------------------------------------------
// Qualitative (dipstick / semi-quant) rows
// ---------------------------------------------------------------------------

/**
 * Qualitative results, as CONCEPTS rather than spellings. Each entry is one
 * meaning plus the other ways labs write it; the first form is the canonical
 * one a value is recorded under, so one lab's "Neg." and another's "negativní"
 * stay one line in the history instead of two.
 *
 * The list is not a gate — a row becomes a proposal because its NAME resolves
 * to a qualitative metric, not because its value appears here. It only supplies
 * canonical spellings, and abbreviations resolve by prefix, so a shortening
 * nobody has written down yet still lands on the right concept.
 */
const QUALITATIVE_CONCEPTS: readonly (readonly string[])[] = [
  ['negativní', 'negativ', 'negative'],
  ['pozitivní', 'pozitiv', 'positive'],
  ['slabě pozitivní', 'weakly positive'],
  ['silně pozitivní', 'strongly positive'],
  ['stopy', 'stopově', 'trace'],
  ['normální', 'normal'],
  ['abnormální', 'abnormal'],
  ['bez nálezu'],
  ['v mezích'],
  ['nenalezeno'],
  ['zvýšený'],
  ['snížený'],
];

/** Every accepted spelling, for the exact-match pass. */
const QUALITATIVE_PHRASES: readonly string[] = QUALITATIVE_CONCEPTS.flat();

/** A dipstick plus-grade token: `+`…`++++` or `1+`…`4+`. */
const PLUS_GRADE_RE = /^(?:\+{1,4}|[1-4]\+)$/;

/** Lowercase and strip diacritics for tolerant phrase comparison. */
function fold(s: string): string {
  return s.trim().toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
}

/**
 * Interpret the tokens after a resolved metric name as a qualitative value.
 *
 * The row has already passed the only gate that matters: its NAME resolves to a
 * metric that is qualitative BY DEFINITION, so whatever follows is that
 * metric's value. Requiring the word to appear in a list on top of that gains
 * nothing and loses data — a lab printing "Neg." instead of "negativní" had its
 * whole dipstick block dropped in silence, and no dictionary can be kept ahead
 * of every lab's abbreviations. So: any short, non-numeric token is a value.
 *
 * Known wordings are still recorded in their canonical spelling, so one lab's
 * "Neg." and another's "negativní" do not split a metric's history in two. That
 * is done by unambiguous PREFIX, which needs no list of abbreviations: "neg"
 * opens only "negativní", while "n" opens two words and is therefore kept as
 * written rather than guessed.
 */
function matchQualitativeValue(valueTokens: string[], metric: Metric): string | undefined {
  if (valueTokens.length === 0) return undefined;
  const vocabulary: readonly (readonly string[])[] =
    metric.valueType === 'enum' || metric.valueType === 'multi'
      ? (metric.enumValues ?? []).map((v) => [v])
      : QUALITATIVE_CONCEPTS;

  // Longest phrase first: "slabě pozitivní" must win over "slabě".
  for (const n of [2, 1]) {
    if (valueTokens.length < n) continue;
    const phrase = valueTokens.slice(0, n).join(' ');
    const canonical = canonicalQualitative(phrase, vocabulary);
    if (canonical !== undefined) return canonical;
  }
  if (PLUS_GRADE_RE.test(valueTokens[0])) return valueTokens[0];
  // A word nobody recognises is NOT attached — silently writing "žlutá" into a
  // urine-glucose series would corrupt it where no one can see. The row is
  // offered unresolved instead (see parseQualitativeLine): visible, one click
  // to accept or skip, and nothing lost either way.
  return undefined;
}

/**
 * The canonical spelling of a qualitative phrase: an exact match, else the ONE
 * vocabulary entry it abbreviates. `undefined` when neither applies — including
 * when a shortening fits several entries, because picking one would be a guess.
 */
function canonicalQualitative(
  phrase: string,
  vocabulary: readonly (readonly string[])[],
): string | undefined {
  const folded = fold(phrase).replace(/\.+$/, '');
  if (folded === '') return undefined;
  // Written out in full: record it under that concept's canonical spelling.
  for (const concept of vocabulary) {
    if (concept.some((form) => fold(form) === folded)) return concept[0];
  }
  // An abbreviation is only an abbreviation from three letters up; below that
  // ("n", "p") the intent is anybody's guess.
  if (folded.length < 3) return undefined;
  const opened = vocabulary.filter((concept) =>
    concept.some((form) => fold(form).startsWith(folded)),
  );
  // Exactly one MEANING may open with it — several spellings of that same
  // meaning are not an ambiguity, which is the whole point of grouping them.
  return opened.length === 1 ? opened[0][0] : undefined;
}

/**
 * Whether an unrecognised token may stand as a value: short, wordlike and not a
 * number (a number belongs to the numeric path, which runs first anyway).
 */
function acceptableQualitativeToken(token: string): boolean {
  const t = token.trim();
  if (t.length === 0 || t.length > 20) return false;
  if (/\d/.test(t)) return false;
  return /\p{L}/u.test(t);
}

/**
 * A row that clearly names an analyte and clearly carries a word for a value,
 * but whose value this build cannot attach to that metric. It reaches review as
 * unresolved so the user can map it (or create their own metric) — the one
 * thing that must never happen is for it to disappear without a trace.
 */
function unattachedQualitative(
  name: string,
  token: string,
  rawText: string,
  date: { iso: string; precision: 'date' | 'datetime' } | undefined,
): ProposedMeasurement {
  const proposal: ProposedMeasurement = {
    metric: { unresolvedName: name },
    textValue: token,
    confidence: 'low',
    rawText,
  };
  if (date) {
    proposal.takenAt = date.iso;
    proposal.timePrecision = date.precision;
  }
  return proposal;
}

/**
 * Try to read a line as a qualitative row: `<name> <value> [reference]`, where
 * the value has no unit (e.g. "Glukóza v moči negativní"). Conservative by
 * design — emitted only when the longest resolving name prefix is a
 * text/enum/multi metric AND the following token is a known qualitative value.
 * A name that resolves to a numeric metric yields nothing (spec §16).
 */
function parseQualitativeLine(
  rawText: string,
  catalog: Catalog,
  date: { iso: string; precision: 'date' | 'datetime' } | undefined,
): ProposedMeasurement | undefined {
  const tokens = rawText.trim().split(/\s+/);
  if (tokens.length < 2) return undefined;

  // Longest name prefix first, so "Glukóza v moči" wins over "Glukóza".
  for (let i = tokens.length - 1; i >= 1; i--) {
    const name = tokens.slice(0, i).join(' ');
    if (name.endsWith(':') || !/\p{L}/u.test(name)) continue;
    // resolveMetric, not resolveAlias: a dipstick row carries the same lab
    // bookkeeping as a numeric one ("VZR U_Glukóza negativní"), and the U_
    // prefix is what points it at the urine metric rather than the blood one.
    const resolved = resolveMetric(name, catalog);
    if (!('metricId' in resolved)) continue;
    const metric = catalog.byId(resolved.metricId);
    if (!metric) continue;

    const valueTokens = tokens.slice(i);
    // A qualitative word on a NUMERIC metric is never that metric's value (a
    // dipstick "negativní" is not grams per litre). Dropping the row in silence
    // is the wrong answer though — the user would never learn the line existed —
    // so it goes to review unattached, with the source's own wording.
    const value = metric.valueType === 'number' ? undefined : matchQualitativeValue(valueTokens, metric);
    if (value === undefined) {
      return acceptableQualitativeToken(valueTokens[0])
        ? unattachedQualitative(splitAnalyteName(name).name, valueTokens[0], rawText, date)
        : undefined;
    }

    const proposal: ProposedMeasurement = {
      metric: metric.id,
      confidence: date ? 'high' : 'medium',
      rawText,
    };
    if (metric.valueType === 'multi') proposal.textValues = [value];
    else proposal.textValue = value;
    if (date) {
      proposal.takenAt = date.iso;
      proposal.timePrecision = date.precision;
    }
    return proposal;
  }
  return undefined;
}

/**
 * Try to read a line as a numeric row that states NO unit — the form Czech lab
 * sheets use for ratios and computed indices ("B_Normoblasty 0,000", "C_FIB-4
 * 0,82"). Deliberately the narrowest of the three readers, because a bare
 * `<words> <number>` shape also describes plenty of non-analyte text
 * ("Strana 1 z 2"): a proposal is emitted ONLY when the name resolves to a
 * numeric metric.
 *
 * The unit stays `undefined` — the parser never invents one. For a metric with a
 * single possible unit the pipeline fills in that one correct unit; for a metric
 * with several (the white-cell differential, where a bare 0,466 could be 0,466 %
 * or the 46,6 % ratio — a 100-fold difference) the pipeline marks the row as
 * awaiting the user's choice, and it cannot be imported until they make it.
 */
function parseUnitlessLine(
  rawText: string,
  catalog: Catalog,
  date: { iso: string; precision: 'date' | 'datetime' } | undefined,
): ProposedMeasurement | undefined {
  let working = rawText.trim();
  let refLow: number | undefined;
  let refHigh: number | undefined;
  let refText: string | undefined;
  const refMatch = extractReference(working);
  if (refMatch) {
    refLow = refMatch.refLow;
    refHigh = refMatch.refHigh;
    refText = refMatch.refText;
    working = working.slice(0, refMatch.index).trim();
  }

  const tokens = working.length > 0 ? working.split(/\s+/) : [];
  if (tokens.length < 2) return undefined;

  let valueIndex = tokens.length - 1;
  if (FLAG_RE.test(tokens[valueIndex])) valueIndex -= 1;
  if (valueIndex < 1) return undefined;
  let valueStart = valueIndex;
  if (OPERATOR_TOKEN_RE.test(tokens[valueStart - 1])) valueStart -= 1;
  if (valueStart < 1) return undefined;

  const parsedValue = parseNumber(tokens.slice(valueStart, valueIndex + 1).join(' '));
  if ('error' in parsedValue) return undefined;

  const name = tokens.slice(0, valueStart).join(' ').trim();
  if (name === '' || name.endsWith(':') || !/\p{L}/u.test(name)) return undefined;

  const resolved = resolveMetric(name, catalog);
  if (!('metricId' in resolved)) return undefined;
  const metric = catalog.byId(resolved.metricId);
  if (!metric || metric.valueType !== 'number') return undefined;

  const proposal: ProposedMeasurement = {
    metric: resolved.metricId,
    value: parsedValue.value,
    confidence: date ? 'medium' : 'low',
    rawText,
  };
  if (parsedValue.operator !== undefined) proposal.operator = parsedValue.operator;
  if (refLow !== undefined) proposal.refLow = refLow;
  if (refHigh !== undefined) proposal.refHigh = refHigh;
  if (refText !== undefined) proposal.refText = refText;
  if (date) {
    proposal.takenAt = date.iso;
    proposal.timePrecision = date.precision;
  }
  return proposal;
}

/**
 * Parse lab-sheet text lines into measurement proposals. Pure: the same input
 * A lab's own result sheet reflects ONE blood draw, and its date is discovered
 * once from the header. A patient-portal overview, though, is a single document
 * with a section per draw — so a labelled collection date encountered on the way
 * re-dates the rows that follow it, until the next one. Stamping such a file
 * with a single date would not fail loudly; it would quietly rewrite the user's
 * history into one day, which is the worst outcome available.
 *
 * Each line is tried as a numeric analyte row first, then as a qualitative
 * (dipstick) row, then as a unitless numeric row; only the first that matches
 * produces a proposal. `rawText` always keeps the ORIGINAL line — layout
 * artefacts are stripped for reading, never from the record.
 */
export function parseLabLines(lines: string[], catalog: Catalog): ProposedMeasurement[] {
  // The header's date covers everything until a section says otherwise; on a
  // one-draw sheet nothing ever does, so the behaviour is unchanged there.
  let date = findDocumentDate(lines);
  const proposals: ProposedMeasurement[] = [];
  for (const line of lines) {
    const section = findSectionDate(line);
    if (section) {
      date = section;
      // A date header is not a result row — nothing else to read from it.
      continue;
    }
    const cleaned = stripSampleColumn(stripEvaluationColumn(line));
    const proposal =
      parseLine(cleaned, catalog, date) ??
      parseQualitativeLine(cleaned, catalog, date) ??
      parseUnitlessLine(cleaned, catalog, date);
    if (proposal) proposals.push({ ...proposal, rawText: line });
  }
  return proposals;
}
