/**
 * Analyte-name preprocessing for lab documents (pure, no DOM/storage/clock).
 *
 * Czech lab information systems follow the NČLP convention of prefixing every
 * analyte with its tissue system, and result sheets print one or two narrow
 * code columns to the left of it:
 *
 *   "HAD AM  S_Kreatinin  84  µmol/L  64 - 104"
 *    └─┬─┘└┬┘ └┬┘└───┬───┘
 *      │   │   │     └── the analyte name we actually want
 *      │   │   └──────── specimen prefix (S_ = serum)
 *      │   └──────────── accreditation marker
 *      └──────────────── issuing-laboratory code
 *
 * This module strips that noise and reports the specimen, so name resolution
 * sees "Kreatinin" and knows the sample was serum. The convention is national,
 * not vendor-specific (the sheets themselves print the legend: "S_sérum,
 * P_plazma, B_krev, U_moč, dU_odpad v moči, F_stolice, Pu_punktát"), which is
 * why it lives in the core rather than in one lab's parser.
 *
 * Design rule (spec §16): never guess. The left columns are dropped ONLY when
 * a specimen prefix marks where the name begins — otherwise the name is left
 * exactly as it was, so an ordinary "HDL cholesterol" is never mistaken for a
 * code column followed by "cholesterol".
 */

/** Tissue system a specimen prefix stands for. */
export type Specimen =
  | 'serum'
  | 'plasma'
  | 'blood'
  | 'urine'
  | 'urine-24h'
  | 'stool'
  | 'punctate'
  /** Not a specimen: a value the lab computed rather than measured (C_ prefix). */
  | 'calculated';

export interface AnalyteName {
  /** The analyte name with code columns and the specimen prefix removed. */
  name: string;
  /** Specimen implied by the prefix; absent when the name carried none. */
  specimen?: Specimen;
}

/**
 * Prefix spellings, longest first so `dU_` and `Pu_` win over `d`/`P`. The
 * match is case-sensitive on the single-letter forms by convention, but the
 * lookup below folds case for tolerance — no real analyte name starts with a
 * one-letter token followed by an underscore, so this cannot bite.
 */
const SPECIMEN_BY_PREFIX: ReadonlyArray<readonly [string, Specimen]> = [
  ['du', 'urine-24h'],
  ['pu', 'punctate'],
  ['s', 'serum'],
  ['p', 'plasma'],
  ['b', 'blood'],
  ['u', 'urine'],
  ['f', 'stool'],
  ['c', 'calculated'],
];

/** A token that opens the analyte name: a known prefix plus an underscore. */
const PREFIX_TOKEN_RE = /^(dU|Pu|[SPBUFC])_(.*)$/i;

/** Specimens whose analytes are a genuinely different metric from the blood one. */
const NON_BLOOD: ReadonlySet<Specimen> = new Set<Specimen>(['urine', 'urine-24h', 'stool']);

/**
 * Whether a specimen means "this is not a blood analyte" — the caller must
 * then resolve a specimen-specific metric and never fall back to the blood
 * one (a urine glucose is not a blood glucose).
 */
export function isDistinctSpecimen(specimen: Specimen | undefined): boolean {
  return specimen !== undefined && NON_BLOOD.has(specimen);
}

/**
 * Split a raw analyte label into its name and specimen.
 *
 * The name starts at the first token carrying a specimen prefix; anything to
 * its left is a code column and is dropped. With no prefix anywhere, the input
 * is returned unchanged (whitespace-normalized) and `specimen` is absent.
 */
export function splitAnalyteName(raw: string): AnalyteName {
  const tokens = raw.trim().split(/\s+/).filter((t) => t !== '');
  for (let i = 0; i < tokens.length; i++) {
    const m = PREFIX_TOKEN_RE.exec(tokens[i]);
    if (!m) continue;
    const entry = SPECIMEN_BY_PREFIX.find(([p]) => p === m[1].toLowerCase());
    if (!entry) continue;
    // The prefix may be glued to the first word ("S_Kreatinin") or stand alone
    // ("S_ Kreatinin"); both leave the rest of the tokens as the name.
    const rest = [m[2], ...tokens.slice(i + 1)].filter((t) => t !== '').join(' ');
    if (rest === '') continue; // a bare prefix is not a name
    return { name: rest, specimen: entry[1] };
  }
  return { name: tokens.join(' ') };
}
