/**
 * Language and appearance belong to the device, not to a profile — switching
 * the tracked person must not repaint or re-translate the app. These tests pin
 * the two rules that make the move safe: an existing profile's values are
 * adopted once, and a choice already made on the device is never overwritten.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  adoptDevicePrefs,
  getDeviceLocale,
  getDeviceTheme,
  setDeviceLocale,
  setDeviceTheme,
} from '../device-prefs';

/** A minimal localStorage stand-in (the node test env has none). */
function installStorage(): Map<string, string> {
  const map = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  });
  return map;
}

beforeEach(() => {
  vi.unstubAllGlobals();
  installStorage();
});

describe('device preferences', () => {
  it('are absent until something is stored', () => {
    expect(getDeviceLocale()).toBeUndefined();
    expect(getDeviceTheme()).toBeUndefined();
  });

  it('round-trip a stored choice', () => {
    setDeviceLocale('cs');
    setDeviceTheme('dark');
    expect(getDeviceLocale()).toBe('cs');
    expect(getDeviceTheme()).toBe('dark');
  });

  it('ignore a value that is not one of the known ones', () => {
    const map = installStorage();
    map.set('vitametr.locale', 'de');
    map.set('vitametr.themePref', 'sepia');
    expect(getDeviceLocale()).toBeUndefined();
    expect(getDeviceTheme()).toBeUndefined();
  });

  it('survive a storage that throws (private window, blocked site data)', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    });
    expect(() => setDeviceLocale('cs')).not.toThrow();
    expect(getDeviceLocale()).toBeUndefined();
  });
});

describe('adopting the values a profile used to own', () => {
  it('takes them once from a profile written before the move', () => {
    adoptDevicePrefs({ locale: 'cs', theme: 'dark' });
    expect(getDeviceLocale()).toBe('cs');
    expect(getDeviceTheme()).toBe('dark');
  });

  it('never overwrites a choice already made on this device', () => {
    setDeviceLocale('en');
    setDeviceTheme('light');
    // A second profile — or the same one, reopened — must not repaint the app.
    adoptDevicePrefs({ locale: 'cs', theme: 'dark' });
    expect(getDeviceLocale()).toBe('en');
    expect(getDeviceTheme()).toBe('light');
  });

  it('leaves the device untouched when the profile carries nothing', () => {
    adoptDevicePrefs({});
    expect(getDeviceLocale()).toBeUndefined();
    expect(getDeviceTheme()).toBeUndefined();
  });

  it('adopts each preference on its own', () => {
    setDeviceLocale('en');
    adoptDevicePrefs({ locale: 'cs', theme: 'dark' });
    expect(getDeviceLocale()).toBe('en');
    expect(getDeviceTheme()).toBe('dark');
  });
});
