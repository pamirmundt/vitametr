/**
 * Preferences that belong to the DEVICE, not to a profile.
 *
 * With several tracked people on one install the line has to be drawn
 * somewhere: measurements, metrics, sources and every data-shaped setting are
 * per profile, while the environment — what language the app speaks, whether it
 * is light or dark — is a property of this browser on this device. Switching
 * from one person to another must never repaint the app or change its language;
 * that would read as "something broke", not as "you switched profile".
 *
 * The values are non-sensitive by construction (a language tag and one of three
 * theme words), which is why they may live in localStorage outside the
 * encrypted blob. Every access is guarded: a private window, disabled site data
 * or a headless capture can make localStorage throw, and a missing preference is
 * a normal state, not an error.
 *
 * Both used to live in `ProfileSettings`. Old profiles still carry them, so
 * {@link adoptDevicePrefs} seeds the device from the first profile that opens
 * after the update — the user must not notice the move.
 */

import type { Locale } from '../i18n/index';
import type { ThemePref } from './theme';

const LOCALE_KEY = 'vitametr.locale';
const THEME_PREF_KEY = 'vitametr.themePref';

function read(key: string): string | undefined {
  try {
    return localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Nothing to do: the preference simply will not survive this session.
  }
}

/** The device's language, or undefined when the user has never chosen one. */
export function getDeviceLocale(): Locale | undefined {
  const raw = read(LOCALE_KEY);
  return raw === 'cs' || raw === 'en' ? raw : undefined;
}

export function setDeviceLocale(locale: Locale): void {
  write(LOCALE_KEY, locale);
}

/** The device's appearance preference, or undefined when never chosen. */
export function getDeviceTheme(): ThemePref | undefined {
  const raw = read(THEME_PREF_KEY);
  return raw === 'auto' || raw === 'light' || raw === 'dark' ? raw : undefined;
}

export function setDeviceTheme(pref: ThemePref): void {
  write(THEME_PREF_KEY, pref);
}

/** What an older profile may still carry — the shape, not the whole settings. */
export interface LegacyDeviceSettings {
  locale?: Locale;
  theme?: ThemePref;
}

/**
 * One-time adoption after the update: a profile written before these moved to
 * the device still holds them, so take them once. A value already chosen on
 * this device always wins — adopting must never overwrite a live preference,
 * and with several profiles it must not matter which one happens to open first.
 */
export function adoptDevicePrefs(settings: LegacyDeviceSettings): void {
  if (getDeviceLocale() === undefined && settings.locale !== undefined) {
    setDeviceLocale(settings.locale);
  }
  if (getDeviceTheme() === undefined && settings.theme !== undefined) {
    setDeviceTheme(settings.theme);
  }
}
