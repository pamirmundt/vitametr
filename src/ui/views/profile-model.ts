/**
 * Profile presentation helpers (pure, DOM-free).
 *
 * The switcher has to tell people apart at a glance, and names are the weakest
 * possible signal: a family often has two profiles whose names start with the
 * same letter, or none at all. So a row carries an initial + colour AND the one
 * fact that is always distinguishing — how much data is in there and how recent
 * it is (`docs/ZADANI-VICE-PROFILU.md` §2).
 */

import type { ProfileSummary } from '../../core/types';
import type { StringKey } from '../../i18n/index';

type Translate = (key: StringKey, params?: Record<string, string | number>) => string;

/**
 * "3 readings" in the right plural form. Injected rather than imported so this
 * module stays a pure function of its arguments (Czech needs one/few/many,
 * English one/other — the rule belongs to the i18n layer, not here).
 */
export type CountFormatter = (n: number) => string;

/**
 * The letter drawn in the avatar: the first CHARACTER of the trimmed name, by
 * grapheme rather than by code unit — "Šárka" must give "Š", and an emoji name
 * must not be cut in half into a replacement character.
 */
export function profileInitial(name: string, locale = 'cs'): string {
  const trimmed = name.trim();
  if (trimmed === '') return '?';
  const first = firstGrapheme(trimmed);
  return first.toLocaleUpperCase(locale);
}

function firstGrapheme(text: string): string {
  const Segmenter = (Intl as unknown as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  if (typeof Segmenter === 'function') {
    const segmenter = new Segmenter(undefined, { granularity: 'grapheme' });
    for (const { segment } of segmenter.segment(text)) return segment;
  }
  // No Intl.Segmenter: [...text] still splits by code POINT, which keeps
  // astral characters whole even if it may split a combining sequence.
  return [...text][0] ?? '?';
}

/**
 * The line under the name: `{n} měření · {datum posledního}`, or just the count
 * while the profile is still empty. `formatDate` is injected so this stays free
 * of the i18n runtime's global locale.
 */
export function profileMetaLine(
  summary: ProfileSummary,
  t: Translate,
  formatDate: (iso: string) => string,
  formatCount: CountFormatter,
): string {
  const count = formatCount(summary.measurementCount);
  if (summary.lastMeasuredAt === undefined) return count;
  return `${count} · ${formatDate(summary.lastMeasuredAt)}`;
}

/**
 * The same line for the Settings list, which dates a profile by its FIRST
 * reading — there the question is "how far back does this go", not "is this the
 * one I updated last".
 */
export function profileSinceLine(
  summary: ProfileSummary,
  t: Translate,
  formatDate: (iso: string) => string,
  formatCount: CountFormatter,
): string {
  const count = formatCount(summary.measurementCount);
  if (summary.firstMeasuredAt === undefined) return count;
  return `${count} · ${t('profile.since', { date: formatDate(summary.firstMeasuredAt) })}`;
}

/** Whether a name is already taken by ANOTHER profile (duplicates are allowed). */
export function isDuplicateName(
  name: string,
  profiles: readonly ProfileSummary[],
  exceptId?: string,
): boolean {
  const needle = name.trim().toLocaleLowerCase();
  if (needle === '') return false;
  return profiles.some(
    (p) => p.id !== exceptId && p.name.trim().toLocaleLowerCase() === needle,
  );
}
