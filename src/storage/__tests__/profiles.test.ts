/**
 * Several profiles on one device.
 *
 * The rules under test are the ones that keep the feature honest: data is per
 * profile, the key is per DEVICE (so switching never asks for the passphrase),
 * an existing single-profile install keeps working untouched, and the profile
 * directory — names, counts, dates — is sealed like everything else rather than
 * left readable beside the encrypted blobs.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CryptoBox, CryptoProvider, KeyRecord, KvBackend } from '../../core/contracts';
import { WrongPassphraseError } from '../../core/contracts';
import type { Measurement, MeasurementId, Metric, MetricId, ProfileData, ProfileId, SourceId } from '../../core/types';
import { CURRENT_SCHEMA_VERSION, PROFILE_COLORS } from '../../core/types';
import { WATCHED_TAG } from '../../core/tags';
import { createMemoryBackend } from '../db';
import { createStore } from '../store';

// ---------------------------------------------------------------------------
// Identity crypto (as in store.test.ts): seal/open pass bytes through, an
// encrypted record carries its passphrase in the clear so wrong-passphrase
// behaviour is testable without WebCrypto.
// ---------------------------------------------------------------------------

const identityBox: CryptoBox = {
  async seal(plain) {
    return plain;
  },
  async open(sealed) {
    return sealed;
  },
};

function passphraseOf(record: KeyRecord): string {
  return (record.payload as { passphrase: string }).passphrase;
}

function createFakeCrypto(): CryptoProvider {
  return {
    async createEncrypted(passphrase) {
      return { box: identityBox, keyRecord: { mode: 'encrypted', payload: { passphrase } } };
    },
    async unlockEncrypted(passphrase, keyRecord) {
      if (passphraseOf(keyRecord) !== passphrase) throw new WrongPassphraseError();
      return identityBox;
    },
    createPlaintext() {
      return { box: identityBox, keyRecord: { mode: 'plaintext' } };
    },
    unlockPlaintext() {
      return identityBox;
    },
    async changePassphrase(oldPassphrase, newPassphrase, keyRecord) {
      if (passphraseOf(keyRecord) !== oldPassphrase) throw new WrongPassphraseError();
      return { mode: 'encrypted', payload: { passphrase: newPassphrase } };
    },
    async upgradeToEncrypted(passphrase) {
      return { box: identityBox, keyRecord: { mode: 'encrypted', payload: { passphrase } } };
    },
  };
}

function measurement(profileId: ProfileId, takenAt: string, value: number): Measurement {
  return {
    id: `m-${takenAt}-${value}` as MeasurementId,
    profileId,
    metricId: 'builtin:glucose' as MetricId,
    value,
    unit: 'mmol/L',
    takenAt,
    timePrecision: 'date',
    status: 'confirmed',
    origin: { pluginId: 'test' },
    createdAt: takenAt,
    modifiedAt: takenAt,
  };
}

function decode(bytes: Uint8Array): ProfileData {
  return JSON.parse(new TextDecoder().decode(bytes)) as ProfileData;
}

/** Read a profile's persisted blob straight out of the backend. */
async function readBlob(backend: KvBackend, id: ProfileId): Promise<ProfileData> {
  return decode((await backend.get('blobs', id)) as Uint8Array);
}

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------

describe('a fresh install', () => {
  it('keys the blob by profile id and lists exactly one profile', async () => {
    const backend = createMemoryBackend();
    const store = createStore(backend, createFakeCrypto());
    const data = await store.init({ profileName: 'Milan' });

    expect(store.listProfiles()).toHaveLength(1);
    const [only] = store.listProfiles();
    expect(only.id).toBe(data.profile.id);
    expect(only.name).toBe('Milan');
    expect(only.color).toBe(PROFILE_COLORS[0]);
    expect(only.measurementCount).toBe(0);
    expect(store.activeProfileId()).toBe(data.profile.id);

    // The blob is addressed by the profile's id, not by a fixed key.
    expect(await backend.keys('blobs')).toEqual([data.profile.id]);
  });

  it('seals the profile directory — names and counts are not left in the clear', async () => {
    const backend = createMemoryBackend();
    const store = createStore(backend, createFakeCrypto());
    await store.init({ profileName: 'Romana', passphrase: 'pw' });

    const meta = (await backend.get('meta', 'device')) as Record<string, unknown>;
    // The plain part carries only what is needed before the directory opens.
    expect(Object.keys(meta).sort()).toEqual(['activeProfileId', 'directory', 'layout']);
    expect(meta.directory).toBeInstanceOf(Uint8Array);
    // With a real box those bytes are ciphertext; the point is that the name is
    // inside them and nowhere else in the record.
    expect(JSON.stringify({ ...meta, directory: undefined })).not.toContain('Romana');
  });
});

describe('switching profiles', () => {
  async function twoProfiles() {
    const backend = createMemoryBackend();
    const store = createStore(backend, createFakeCrypto());
    const first = await store.init({ profileName: 'Milan', passphrase: 'pw' });
    store.mutate((d) => {
      d.measurements.push(measurement(d.profile.id, '2025-01-15', 5.4));
    });
    await store.flush();
    const second = await store.createProfile({ name: 'Romana' });
    return { backend, store, first, second };
  }

  it('creates a second profile, makes it active, and keeps the data apart', async () => {
    const { store, first, second } = await twoProfiles();

    expect(store.listProfiles()).toHaveLength(2);
    expect(store.activeProfileId()).toBe(second.profile.id);
    expect(second.measurements).toEqual([]);
    expect(store.getData().profile.name).toBe('Romana');

    await store.switchProfile(first.profile.id);
    expect(store.getData().profile.name).toBe('Milan');
    expect(store.getData().measurements).toHaveLength(1);
  });

  it('never needs the passphrase again — one key belongs to the device', async () => {
    const { backend, store, first } = await twoProfiles();
    // Exactly one key record, under the device key, for both profiles.
    expect(await backend.keys('keys')).toEqual(['default']);
    // Switching resolves without a passphrase argument anywhere in the call.
    await expect(store.switchProfile(first.profile.id)).resolves.toBeDefined();
    expect(await store.status()).toBe('unlocked');
  });

  it('flushes the previous profile before it swaps the data out', async () => {
    vi.useFakeTimers();
    const backend = createMemoryBackend();
    const store = createStore(backend, createFakeCrypto());
    const first = await store.init({ profileName: 'Milan' });
    const second = await store.createProfile({ name: 'Romana' });
    await store.switchProfile(first.profile.id);

    // A mutation inside the debounce window, then an immediate switch.
    store.mutate((d) => {
      d.sources.push({ id: 'src-1' as SourceId, name: 'Lab', kind: 'lab' });
    });
    await store.switchProfile(second.profile.id);

    // The pending write landed in the profile it belonged to, not the new one.
    expect((await readBlob(backend, first.profile.id)).sources).toHaveLength(1);
    expect((await readBlob(backend, second.profile.id)).sources).toEqual([]);
  });

  it('counts what is in memory, not only what reached the disk', async () => {
    const backend = createMemoryBackend();
    const store = createStore(backend, createFakeCrypto());
    const first = await store.init({ profileName: 'Milan' });
    await store.createProfile({ name: 'Romana' });
    await store.switchProfile(first.profile.id);

    // A mutation still inside the debounce window: the switcher must not claim
    // the profile is empty just because nothing has been flushed yet.
    store.mutate((d) => {
      d.measurements.push(measurement(d.profile.id, '2026-02-01', 5.4));
    });
    const row = store.listProfiles().find((p) => p.id === first.profile.id);
    expect(row?.measurementCount).toBe(1);
    expect(row?.lastMeasuredAt).toBe('2026-02-01');
  });

  it('keeps the directory counts in step with what is written', async () => {
    const { store, first } = await twoProfiles();
    const summary = store.listProfiles().find((p) => p.id === first.profile.id);
    expect(summary?.measurementCount).toBe(1);
    expect(summary?.firstMeasuredAt).toBe('2025-01-15');
    expect(summary?.lastMeasuredAt).toBe('2025-01-15');
  });

  it('reopens the profile that was active, not the first one', async () => {
    const { backend, store, second } = await twoProfiles();
    await store.lock();

    const reopened = createStore(backend, createFakeCrypto());
    const data = await reopened.unlock('pw');
    expect(data.profile.id).toBe(second.profile.id);
    expect(reopened.activeProfileId()).toBe(second.profile.id);
  });

  it('orders the switcher by last use, active first', async () => {
    const { store, first } = await twoProfiles();
    await store.switchProfile(first.profile.id);
    expect(store.listProfiles()[0].id).toBe(first.profile.id);
  });
});

describe('inheriting from another profile', () => {
  it('copies settings and metric definitions but never measurements or sources', async () => {
    const backend = createMemoryBackend();
    const store = createStore(backend, createFakeCrypto());
    const first = await store.init({ profileName: 'Milan' });
    store.mutate((d) => {
      d.settings.unitSystem = 'us';
      d.settings.useTags = false;
      d.metrics.push({
        id: 'user:xyz' as MetricId,
        customName: 'Vlastní',
        aliases: ['xyz'],
        category: 'custom',
        valueType: 'number',
        canonicalUnit: 'mmol/L',
        units: ['mmol/L'],
      } as Metric);
      d.sources.push({ id: 'src-1' as SourceId, name: 'Lab', kind: 'lab' });
      d.measurements.push(measurement(d.profile.id, '2025-01-15', 5.4));
    });

    const child = await store.createProfile({ name: 'Romana', inheritFrom: first.profile.id });

    expect(child.settings.unitSystem).toBe('us');
    expect(child.settings.useTags).toBe(false);
    expect(child.metrics.map((m) => m.id)).toEqual(['user:xyz']);
    expect(child.measurements).toEqual([]);
    expect(child.sources).toEqual([]);
    // A deep copy: editing the child must not reach into the parent.
    child.metrics[0].customName = 'Změněno';
    await store.switchProfile(first.profile.id);
    expect(store.getData().metrics[0].customName).toBe('Vlastní');
  });

  it('never inherits which metrics are WATCHED — that is about a person', async () => {
    const backend = createMemoryBackend();
    const store = createStore(backend, createFakeCrypto());
    const first = await store.init({ profileName: 'Milan' });
    store.mutate((d) => {
      d.metrics.push({
        id: 'builtin:tsh' as MetricId,
        nameKey: 'metric.tsh',
        aliases: [],
        category: 'lab',
        valueType: 'number',
        canonicalUnit: 'mIU/L',
        units: ['mIU/L'],
        tags: ['thyroid', WATCHED_TAG],
      } as Metric);
    });

    const child = await store.createProfile({ name: 'Romana', inheritFrom: first.profile.id });

    // The metric itself carries over (same panels, same units) — the star does
    // not: following someone's thyroid says nothing about the next person.
    expect(child.metrics.map((m) => m.id)).toEqual(['builtin:tsh']);
    expect(child.metrics[0].tags).toEqual(['thyroid']);
    // And the parent keeps its own star.
    await store.switchProfile(first.profile.id);
    expect(store.getData().metrics[0].tags).toContain(WATCHED_TAG);
  });

  it('never inherits the summary metric selection', async () => {
    const backend = createMemoryBackend();
    const store = createStore(backend, createFakeCrypto());
    const first = await store.init({ profileName: 'Milan' });
    store.mutate((d) => {
      d.settings.unitSystem = 'us';
      d.settings.reportMetricIds = ['builtin:glucose' as MetricId];
    });

    const child = await store.createProfile({ name: 'Romana', inheritFrom: first.profile.id });

    // Preferences carry over; a hand-picked list of THIS person's metrics does
    // not — it would silently keep the new profile's own imports out of print.
    expect(child.settings.unitSystem).toBe('us');
    expect(child.settings.reportMetricIds).toBeUndefined();
  });

  it('starts empty when nothing is inherited', async () => {
    const backend = createMemoryBackend();
    const store = createStore(backend, createFakeCrypto());
    await store.init({ profileName: 'Milan' });
    store.mutate((d) => {
      d.settings.unitSystem = 'us';
    });
    const child = await store.createProfile({ name: 'Romana' });
    expect(child.settings.unitSystem).toBeUndefined();
    expect(child.metrics).toEqual([]);
  });
});

describe('renaming and deleting', () => {
  it('renames the active profile in both the directory and its blob', async () => {
    const backend = createMemoryBackend();
    const store = createStore(backend, createFakeCrypto());
    const first = await store.init({ profileName: 'Milan' });

    await store.renameProfile(first.profile.id, 'Milan V.');

    expect(store.listProfiles()[0].name).toBe('Milan V.');
    expect(store.getData().profile.name).toBe('Milan V.');
    expect((await readBlob(backend, first.profile.id)).profile.name).toBe('Milan V.');
  });

  it('renames a profile that is not open', async () => {
    const backend = createMemoryBackend();
    const store = createStore(backend, createFakeCrypto());
    const first = await store.init({ profileName: 'Milan' });
    await store.createProfile({ name: 'Romana' });

    await store.renameProfile(first.profile.id, 'Táta');

    expect(store.listProfiles().find((p) => p.id === first.profile.id)?.name).toBe('Táta');
    expect((await readBlob(backend, first.profile.id)).profile.name).toBe('Táta');
  });

  it('refuses to delete the active profile', async () => {
    const backend = createMemoryBackend();
    const store = createStore(backend, createFakeCrypto());
    await store.init({ profileName: 'Milan' });
    const second = await store.createProfile({ name: 'Romana' });

    await expect(store.deleteProfile(second.profile.id)).rejects.toThrow(/active/i);
    expect(store.listProfiles()).toHaveLength(2);
  });

  it('refuses to delete the last profile', async () => {
    const backend = createMemoryBackend();
    const store = createStore(backend, createFakeCrypto());
    const first = await store.init({ profileName: 'Milan' });

    await expect(store.deleteProfile(first.profile.id)).rejects.toThrow(/last/i);
  });

  it('deletes an inactive profile with its blob', async () => {
    const backend = createMemoryBackend();
    const store = createStore(backend, createFakeCrypto());
    const first = await store.init({ profileName: 'Milan' });
    const second = await store.createProfile({ name: 'Romana' });

    await store.deleteProfile(first.profile.id);

    expect(store.listProfiles().map((p) => p.id)).toEqual([second.profile.id]);
    expect(await backend.get('blobs', first.profile.id)).toBeUndefined();
    expect(await backend.keys('blobs')).toEqual([second.profile.id]);
  });
});

// ---------------------------------------------------------------------------
// Backward compatibility — the whole point of the migration.
// ---------------------------------------------------------------------------

describe('an install made before profiles existed', () => {
  /** Lay down exactly what the previous release wrote: everything under 'default'. */
  async function seedLegacy(backend: KvBackend, encrypted: boolean): Promise<ProfileData> {
    const legacy: ProfileData = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      profile: {
        id: 'p-legacy' as ProfileId,
        name: 'Milan',
        createdAt: '2024-01-01T00:00:00.000Z',
      },
      metrics: [],
      sources: [],
      measurements: [
        measurement('p-legacy' as ProfileId, '2024-03-02', 5.1),
        measurement('p-legacy' as ProfileId, '2025-06-01', 5.6),
      ],
      settings: { locale: 'cs', theme: 'dark' },
    };
    await backend.put('blobs', 'default', new TextEncoder().encode(JSON.stringify(legacy)));
    await backend.put(
      'keys',
      'default',
      encrypted
        ? ({ mode: 'encrypted', payload: { passphrase: 'pw' } } as KeyRecord)
        : ({ mode: 'plaintext' } as KeyRecord),
    );
    await backend.put('meta', 'default', {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      profileId: legacy.profile.id,
      mode: encrypted ? 'encrypted' : 'plaintext',
    });
    return legacy;
  }

  it('opens, and moves the blob under the profile id without touching its contents', async () => {
    const backend = createMemoryBackend();
    const legacy = await seedLegacy(backend, false);
    const before = (await backend.get('blobs', 'default')) as Uint8Array;

    const store = createStore(backend, createFakeCrypto());
    const data = await store.unlock();

    expect(data.profile.id).toBe(legacy.profile.id);
    expect(data.measurements).toHaveLength(2);
    // Same bytes, new address.
    expect(await backend.get('blobs', legacy.profile.id)).toEqual(before);
    expect(await backend.get('blobs', 'default')).toBeUndefined();
  });

  it('registers the existing profile as the only, active one — with its counts', async () => {
    const backend = createMemoryBackend();
    const legacy = await seedLegacy(backend, false);
    const store = createStore(backend, createFakeCrypto());
    await store.unlock();

    expect(store.listProfiles()).toHaveLength(1);
    const [only] = store.listProfiles();
    expect(only).toMatchObject({
      id: legacy.profile.id,
      name: 'Milan',
      createdAt: legacy.profile.createdAt,
      color: PROFILE_COLORS[0],
      measurementCount: 2,
      firstMeasuredAt: '2024-03-02',
      lastMeasuredAt: '2025-06-01',
    });
    expect(store.activeProfileId()).toBe(legacy.profile.id);
  });

  it('migrates an encrypted install with the same passphrase, and only that one', async () => {
    const backend = createMemoryBackend();
    const legacy = await seedLegacy(backend, true);
    const store = createStore(backend, createFakeCrypto());

    await expect(store.unlock('wrong')).rejects.toBeInstanceOf(WrongPassphraseError);
    // A failed unlock must not have half-migrated anything.
    expect(await backend.get('blobs', 'default')).toBeDefined();
    expect(await backend.get('meta', 'device')).toBeUndefined();

    const data = await store.unlock('pw');
    expect(data.profile.id).toBe(legacy.profile.id);
    expect(store.listProfiles()).toHaveLength(1);
  });

  it('is idempotent: a second unlock changes nothing', async () => {
    const backend = createMemoryBackend();
    await seedLegacy(backend, false);
    const first = createStore(backend, createFakeCrypto());
    await first.unlock();
    const metaAfterFirst = await backend.get('meta', 'device');
    await first.lock();

    const second = createStore(backend, createFakeCrypto());
    await second.unlock();

    expect(await backend.get('meta', 'device')).toEqual(metaAfterFirst);
    expect(await backend.keys('blobs')).toHaveLength(1);
    expect(second.listProfiles()).toHaveLength(1);
  });

  it('leaves a legacy install able to add a second profile straight away', async () => {
    const backend = createMemoryBackend();
    await seedLegacy(backend, false);
    const store = createStore(backend, createFakeCrypto());
    await store.unlock();

    const second = await store.createProfile({ name: 'Romana' });
    expect(store.listProfiles()).toHaveLength(2);
    expect(store.listProfiles().find((p) => p.id === second.profile.id)?.color).toBe(
      PROFILE_COLORS[1],
    );
  });
});
