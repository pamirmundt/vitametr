/**
 * Restoring a backup into profiles. The rules under test are the ones that make
 * a restore safe to click: a used profile is never quietly reconfigured, a
 * profile that exists only in the file is created rather than merged into
 * someone else's data, and the device's own language/appearance survive.
 */

import { describe, expect, it } from 'vitest';
import type { ProfileBackup } from '../../plugins/export/json-backup';
import type {
  Measurement,
  MeasurementId,
  MetricId,
  ProfileData,
  ProfileId,
  ProfileSummary,
  SourceId,
} from '../types';
import { CURRENT_SCHEMA_VERSION } from '../types';
import {
  applyBackupSetup,
  chooseRestoreTarget,
  defaultRestoreTargets,
  isPristineProfile,
  newProfileCount,
  planRestore,
  previewBackup,
  profileDataFromBackup,
  settingsOverwriteLoss,
  type RestoreTarget,
} from '../backup-restore';
import type { VitametrBackup } from '../../plugins/export/json-backup';

function measurement(over: Partial<Measurement> = {}): Measurement {
  return {
    id: 'm-old' as MeasurementId,
    profileId: 'p-source' as ProfileId,
    metricId: 'builtin:glucose' as MetricId,
    value: 5.4,
    unit: 'mmol/L',
    takenAt: '2025-01-15',
    timePrecision: 'date',
    status: 'confirmed',
    origin: { pluginId: 'manual' },
    createdAt: '2025-01-15T00:00:00Z',
    modifiedAt: '2025-01-15T00:00:00Z',
    ...over,
  };
}

function emptyProfile(over: Partial<ProfileData> = {}): ProfileData {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    profile: { id: 'p-new' as ProfileId, name: '', createdAt: '2026-09-05T00:00:00Z' },
    metrics: [],
    sources: [],
    measurements: [],
    settings: {},
    ...over,
  };
}

function backup(over: Partial<ProfileBackup> = {}): ProfileBackup {
  return {
    profile: { id: 'p-source' as ProfileId, name: 'Romana', createdAt: '2023-04-01T00:00:00Z' },
    metrics: [],
    sources: [{ id: 's1' as SourceId, name: 'AGEL Říčany', kind: 'lab' }],
    measurements: [measurement()],
    settings: { unitSystem: 'us', useTags: false, locale: 'en', theme: 'dark' },
    units: [{ code: 'x/L', display: 'x/l', dimension: 'arbitrary', toBase: { factor: 1 } }],
    disabledMetrics: ['builtin:psa' as MetricId],
    ...over,
  };
}

describe('isPristineProfile', () => {
  it('is true for a profile straight out of createProfile', () => {
    expect(isPristineProfile(emptyProfile())).toBe(true);
  });

  it('ignores the language and theme an older profile still carries', () => {
    // Both moved to the device; a profile holding them has still never been used.
    expect(isPristineProfile(emptyProfile({ settings: { locale: 'cs', theme: 'dark' } }))).toBe(
      true,
    );
  });

  it('is false once anything of the user is in there', () => {
    expect(isPristineProfile(emptyProfile({ measurements: [measurement()] }))).toBe(false);
    expect(isPristineProfile(emptyProfile({ settings: { unitSystem: 'us' } }))).toBe(false);
    expect(
      isPristineProfile(emptyProfile({ sources: [{ id: 's' as SourceId, name: 'Lab', kind: 'lab' }] })),
    ).toBe(false);
  });
});

describe('applyBackupSetup', () => {
  it('brings back what makes the readings mean something', () => {
    const target = emptyProfile();
    applyBackupSetup(target, backup());

    expect(target.profile.name).toBe('Romana');
    expect(target.sources.map((s) => s.name)).toEqual(['AGEL Říčany']);
    expect(target.settings.unitSystem).toBe('us');
    expect(target.settings.useTags).toBe(false);
    expect(target.units).toHaveLength(1);
    expect(target.disabledMetrics).toEqual(['builtin:psa']);
  });

  it('leaves the profile its own identity', () => {
    const target = emptyProfile();
    applyBackupSetup(target, backup());
    expect(target.profile.id).toBe('p-new');
    expect(target.profile.createdAt).toBe('2026-09-05T00:00:00Z');
  });

  it('drops the language and appearance a backup may still carry', () => {
    // They belong to the device: restoring someone's data must not repaint the
    // app or switch its language under them.
    const target = emptyProfile();
    applyBackupSetup(target, backup());
    expect(target.settings.locale).toBeUndefined();
    expect(target.settings.theme).toBeUndefined();
  });

  it('does not share structure with the file it came from', () => {
    const source = backup();
    const target = emptyProfile();
    applyBackupSetup(target, source);
    target.sources[0].name = 'Změněno';
    expect(source.sources[0].name).toBe('AGEL Říčany');
  });
});

describe('profileDataFromBackup', () => {
  const mint = (): (() => MeasurementId) => {
    let n = 0;
    return () => `m-new-${++n}` as MeasurementId;
  };

  it('builds a whole profile, readings included', () => {
    const data = profileDataFromBackup(
      backup(),
      { id: 'p2' as ProfileId, createdAt: '2026-09-05T00:00:00Z' },
      mint(),
    );
    expect(data.profile.name).toBe('Romana');
    expect(data.measurements).toHaveLength(1);
    expect(data.settings.unitSystem).toBe('us');
    expect(data.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('keeps the profile own creation date — it is part of the history', () => {
    const data = profileDataFromBackup(
      backup(),
      { id: 'p2' as ProfileId, createdAt: '2026-09-05T00:00:00Z' },
      mint(),
    );
    expect(data.profile.createdAt).toBe('2023-04-01T00:00:00Z');
  });

  it('re-points every reading at the profile being created, with fresh ids', () => {
    const data = profileDataFromBackup(
      backup({ measurements: [measurement(), measurement({ id: 'm-old-2' as MeasurementId })] }),
      { id: 'p2' as ProfileId, createdAt: '2026-09-05T00:00:00Z' },
      mint(),
    );
    expect(data.measurements.map((m) => m.profileId)).toEqual(['p2', 'p2']);
    // Fresh ids: restoring the same file twice must not collide.
    expect(data.measurements.map((m) => m.id)).toEqual(['m-new-1', 'm-new-2']);
  });
});

describe('planRestore', () => {
  const withOthers = {
    ...backup(),
    otherProfiles: [backup({ profile: { id: 'p3' as ProfileId, name: 'Eliška', createdAt: '2024-01-01' } })],
  };

  it('writes setup into a brand-new profile without asking', () => {
    const plan = planRestore(withOthers, emptyProfile());
    expect(plan.restoresSetup).toBe(true);
    expect(plan.measurementCount).toBe(1);
    expect(plan.createsProfiles).toEqual(['Eliška']);
  });

  it('leaves a used profile configured as it is unless told otherwise', () => {
    const used = emptyProfile({ measurements: [measurement()] });
    expect(planRestore(withOthers, used).restoresSetup).toBe(false);
    expect(
      planRestore(withOthers, used, { includeOtherProfiles: true, setupOntoUsedProfile: true })
        .restoresSetup,
    ).toBe(true);
  });

  it('creates nothing when the other profiles are declined', () => {
    const plan = planRestore(withOthers, emptyProfile(), { includeOtherProfiles: false });
    expect(plan.createsProfiles).toEqual([]);
  });

  it('describes a single-profile backup as just its readings', () => {
    const plan = planRestore(backup(), emptyProfile({ measurements: [measurement()] }));
    expect(plan).toEqual({ measurementCount: 1, restoresSetup: false, createsProfiles: [] });
  });
});

// ---------------------------------------------------------------------------
// The "what will happen" screen is built entirely from these.
// ---------------------------------------------------------------------------

function summary(id: string, name: string): ProfileSummary {
  return {
    id: id as ProfileId,
    name,
    createdAt: '2024-01-01T00:00:00Z',
    color: '#1f6e7d',
    lastUsedAt: '2026-01-01T00:00:00Z',
    measurementCount: 0,
  };
}

function file(over: Partial<VitametrBackup> = {}): VitametrBackup {
  return {
    format: 'vitametr-backup',
    backupVersion: 1,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    createdAt: '2026-09-05T10:00:00Z',
    ...backup({ measurements: [measurement({ takenAt: '2024-03-02' })] }),
    ...over,
  } as VitametrBackup;
}

describe('previewBackup', () => {
  it('counts the readings and the period across every profile in the file', () => {
    const p = previewBackup(
      file({
        otherProfiles: [
          backup({
            profile: { id: 'p3' as ProfileId, name: 'Eliška', createdAt: '2024-01-01' },
            measurements: [
              measurement({ takenAt: '2019-03-01' }),
              measurement({ takenAt: '2026-08-31' }),
            ],
          }),
        ],
      }),
    );
    expect(p.totalMeasurements).toBe(3);
    expect(p.from).toBe('2019-03-01');
    expect(p.to).toBe('2026-08-31');
    expect(p.profiles.map((x) => [x.name, x.measurementCount])).toEqual([
      ['Romana', 1],
      ['Eliška', 2],
    ]);
    expect(p.createdAt).toBe('2026-09-05T10:00:00Z');
  });

  it('describes a single-profile file as one profile', () => {
    const p = previewBackup(file());
    expect(p.profiles).toHaveLength(1);
    expect(p.totalMeasurements).toBe(1);
  });

  it('survives a profile with no readings at all', () => {
    const p = previewBackup(file({ measurements: [] }));
    expect(p.totalMeasurements).toBe(0);
    expect(p.from).toBeUndefined();
  });
});

describe('where each profile lands', () => {
  const preview = previewBackup(
    file({
      otherProfiles: [
        backup({ profile: { id: 'x' as ProfileId, name: 'Eliška', createdAt: '2024-01-01' } }),
      ],
    }),
  );

  it('defaults to a new profile — nothing existing is touched', () => {
    expect(defaultRestoreTargets(preview, [summary('a', 'Někdo jiný')])).toEqual([
      { kind: 'new' },
      { kind: 'new' },
    ]);
  });

  it('recognises "my own backup" by an exact name and restores into it', () => {
    // Case and diacritics do not matter; this is the most common restore.
    const targets = defaultRestoreTargets(preview, [summary('a', ' romana ')]);
    expect(targets[0]).toEqual({ kind: 'existing', id: 'a' });
    expect(targets[1]).toEqual({ kind: 'new' });
  });

  it('uses up a fresh install\'s empty profile instead of leaving it behind', () => {
    // Restoring onto a new phone: the profile the app made on first run is the
    // obvious home for the first profile in the file. Without this the device
    // ends up with an empty "My profile" nobody can merge away.
    const targets = defaultRestoreTargets(preview, [summary('a', 'Můj profil')], true);
    expect(targets[0]).toEqual({ kind: 'existing', id: 'a' });
    expect(targets[1]).toEqual({ kind: 'new' });
  });

  it('does not touch an existing profile that has been used', () => {
    expect(defaultRestoreTargets(preview, [summary('a', 'Můj profil')], false)[0]).toEqual({
      kind: 'new',
    });
  });

  it('treats two unnamed profiles as the same person', () => {
    // Restoring your own backup onto your own phone, where nobody ever typed a
    // name: creating a second profile there would be a surprise nobody asked
    // for, and the simple dialog does not even mention profiles.
    const unnamed = previewBackup(
      file({ profile: { id: 'p1' as ProfileId, name: '', createdAt: '2024-01-01' } }),
    );
    expect(defaultRestoreTargets(unnamed, [summary('a', '')])[0]).toEqual({
      kind: 'existing',
      id: 'a',
    });
  });

  it('lets a name match win over the fresh install slot', () => {
    // The file holds Romana and an unnamed profile; the fresh device's profile
    // is unnamed too. The unnamed pair belong together — grabbing the slot for
    // whichever profile happens to come first would split them apart.
    const mixed = previewBackup(
      file({
        profile: { id: 'p1' as ProfileId, name: 'Romana', createdAt: '2024-01-01' },
        otherProfiles: [
          backup({ profile: { id: 'p2' as ProfileId, name: '', createdAt: '2024-01-01' } }),
        ],
      }),
    );
    const targets = defaultRestoreTargets(mixed, [summary('a', '')], true);
    expect(targets[0]).toEqual({ kind: 'new' });
    expect(targets[1]).toEqual({ kind: 'existing', id: 'a' });
  });

  it('never defaults two profiles onto the same one', () => {
    const twoRomanas = previewBackup(
      file({
        otherProfiles: [
          backup({ profile: { id: 'x' as ProfileId, name: 'Romana', createdAt: '2024-01-01' } }),
        ],
      }),
    );
    const targets = defaultRestoreTargets(twoRomanas, [summary('a', 'Romana')]);
    expect(targets[0]).toEqual({ kind: 'existing', id: 'a' });
    expect(targets[1]).toEqual({ kind: 'new' });
  });

  it('pushes the previous holder aside when a target is taken over', () => {
    const start: RestoreTarget[] = [{ kind: 'existing', id: 'a' as ProfileId }, { kind: 'new' }];
    const { targets, displaced } = chooseRestoreTarget(start, 1, {
      kind: 'existing',
      id: 'a' as ProfileId,
    });
    expect(targets).toEqual([{ kind: 'new' }, { kind: 'existing', id: 'a' }]);
    expect(displaced).toBe(0);
  });

  it('counts the profiles that would be created', () => {
    expect(
      newProfileCount([{ kind: 'new' }, { kind: 'skip' }, { kind: 'existing', id: 'a' as ProfileId }]),
    ).toBe(1);
  });
});

describe('settingsOverwriteLoss', () => {
  it('says nothing is at stake for an untouched profile', () => {
    // Core is on in every profile by default; nobody chose it, so it is not
    // something the user would lose. An untouched profile risks nothing, and the
    // caller shows no checkbox at all.
    expect(settingsOverwriteLoss(emptyProfile())).toMatchObject({
      isEmpty: true,
      units: 0,
      tags: 0,
      packs: [],
      preferences: 0,
    });
  });

  it('counts what the profile holds today, not what arrives', () => {
    const used = emptyProfile({
      settings: { unitSystem: 'us', useTags: false, activePacks: ['builtin:core', 'builtin:lipids'] },
      metrics: [
        {
          id: 'builtin:tsh' as MetricId,
          nameKey: 'metric.tsh',
          aliases: [],
          category: 'lab',
          valueType: 'number',
          canonicalUnit: 'mIU/L',
          units: ['mIU/L'],
          tags: ['thyroid', 'builtin:watched'],
        },
      ] as ProfileData['metrics'],
      units: [{ code: 'x/L', display: 'x/l', dimension: 'arbitrary', toBase: { factor: 1 } }] as ProfileData['units'],
    });
    const loss = settingsOverwriteLoss(used);
    expect(loss.units).toBe(1);
    expect(loss.tags).toBe(2);
    expect(loss.packs).toEqual(['builtin:core', 'builtin:lipids']);
    expect(loss.preferences).toBe(3);
  });
});
