import { describe, expect, it } from 'vitest';
import type { ProfileId, ProfileSummary } from '../../../core/types';
import {
  isDuplicateName,
  profileInitial,
  profileMetaLine,
  profileSinceLine,
} from '../profile-model';

function summary(over: Partial<ProfileSummary> = {}): ProfileSummary {
  return {
    id: 'p1' as ProfileId,
    name: 'Milan',
    createdAt: '2024-01-01T00:00:00.000Z',
    color: '#1f6e7d',
    lastUsedAt: '2026-01-01T00:00:00.000Z',
    measurementCount: 0,
    ...over,
  };
}

const t = (key: string, params?: Record<string, string | number>): string => {
  if (key === 'profile.measurementsCount') return `${params?.n} měření`;
  if (key === 'profile.since') return `od ${params?.date}`;
  return key;
};

const date = (iso: string): string => iso.slice(0, 10);
const count = (n: number): string => `${n} měření`;

describe('profileInitial', () => {
  it('takes the first letter, uppercased', () => {
    expect(profileInitial('milan')).toBe('M');
  });

  it('keeps Czech diacritics whole', () => {
    expect(profileInitial('Šárka')).toBe('Š');
    expect(profileInitial('čeněk')).toBe('Č');
  });

  it('does not cut an astral character in half', () => {
    // A naive charAt() would return half a surrogate pair here.
    expect(profileInitial('🐈 kočka')).toBe('🐈');
  });

  it('ignores surrounding whitespace', () => {
    expect(profileInitial('  eliška ')).toBe('E');
  });

  it('falls back for an empty name', () => {
    expect(profileInitial('   ')).toBe('?');
  });
});

describe('profileMetaLine', () => {
  it('shows the count alone while nothing is measured', () => {
    expect(profileMetaLine(summary(), t, date, count)).toBe('0 měření');
  });

  it('adds the date of the newest reading', () => {
    const line = profileMetaLine(
      summary({ measurementCount: 12, lastMeasuredAt: '2026-05-27' }),
      t,
      date,
      count,
    );
    expect(line).toBe('12 měření · 2026-05-27');
  });
});

describe('profileSinceLine', () => {
  it('dates the profile by its first reading', () => {
    const line = profileSinceLine(
      summary({ measurementCount: 41, firstMeasuredAt: '2023-04-12' }),
      t,
      date,
      count,
    );
    expect(line).toBe('41 měření · od 2023-04-12');
  });
});

describe('isDuplicateName', () => {
  const profiles = [summary({ id: 'p1' as ProfileId, name: 'Milan' })];

  it('spots a name already used, case- and space-insensitively', () => {
    expect(isDuplicateName('  milan ', profiles)).toBe(true);
  });

  it('does not count the profile being renamed as its own duplicate', () => {
    expect(isDuplicateName('Milan', profiles, 'p1')).toBe(false);
  });

  it('treats an empty name as no clash — it becomes the default name', () => {
    expect(isDuplicateName('   ', profiles)).toBe(false);
  });
});
