import { describe, expect, it } from 'vitest';

import { createCatalog } from '../../core/catalog.js';
import { createUnitsEngine } from '../../core/units.js';
import { createImportPipeline, type ImportPipelineDeps } from '../../core/review.js';
import { PassphraseRequiredError, WrongPassphraseError } from '../../core/contracts.js';
import { CURRENT_SCHEMA_VERSION } from '../../core/types.js';
import type {
  Measurement,
  MeasurementId,
  MetricId,
  ProfileData,
  ProfileId,
  SourceId,
} from '../../core/types.js';
import { jsonBackupExportPlugin } from '../export/json-backup.js';
import { jsonBackupImportPlugin } from '../import/json-backup.js';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const PROFILE_ID = 'p1' as ProfileId;
const SRC = 'src-lab' as SourceId;

function measurement(over: Partial<Measurement>): Measurement {
  return {
    id: 'orig' as MeasurementId,
    profileId: PROFILE_ID,
    metricId: 'builtin:glucose' as MetricId,
    value: 5.4,
    unit: 'mmol/L',
    takenAt: '2026-01-15',
    timePrecision: 'date',
    status: 'confirmed',
    origin: { pluginId: 'manual' },
    createdAt: '2026-01-15T00:00',
    modifiedAt: '2026-01-15T00:00',
    ...over,
  };
}

function fixture(): ProfileData {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    profile: { id: PROFILE_ID, name: 'Test', createdAt: '2026-01-01' },
    metrics: [],
    sources: [{ id: SRC, name: 'Synlab, s.r.o.', kind: 'lab' }],
    measurements: [
      measurement({ id: 'a' as MeasurementId, value: 5.4, takenAt: '2026-01-15', sourceId: SRC }),
      // censored operator value + reference range
      measurement({
        id: 'b' as MeasurementId,
        metricId: 'builtin:crp' as MetricId,
        value: 0.1,
        operator: '<',
        unit: 'mg/L',
        takenAt: '2026-02-20',
        refLow: 0,
        refHigh: 5,
        refText: '< 5,0',
        // note with delimiter, quotes, newline and accents
        note: 'Ranní odběr; "nalačno"\nkontrolní',
        sourceId: SRC,
      }),
      measurement({
        id: 'c' as MeasurementId,
        metricId: 'builtin:hemoglobin' as MetricId,
        value: 145,
        unit: 'g/L',
        takenAt: '2026-03-10T08:30',
        timePrecision: 'datetime',
      }),
    ],
    settings: { locale: 'cs' },
  };
}

function deps(): ImportPipelineDeps {
  let n = 0;
  return {
    newId: () => `restored-${++n}` as MeasurementId,
    now: () => '2026-07-21T10:00',
    profileId: PROFILE_ID,
  };
}

/** The fields a lossless restore must preserve (id/status/timestamps are re-derived). */
function meaningful(m: Measurement) {
  return {
    metricId: m.metricId,
    value: m.value,
    operator: m.operator,
    unit: m.unit,
    takenAt: m.takenAt,
    timePrecision: m.timePrecision,
    refLow: m.refLow,
    refHigh: m.refHigh,
    refText: m.refText,
    note: m.note,
    rawText: m.origin.rawText,
  };
}

function exportCtx(data: ProfileData) {
  return { data, catalog: createCatalog(data), units: createUnitsEngine(), locale: 'cs' as const };
}

async function fileFromBlob(blob: Blob, name: string): Promise<File> {
  const text = await blob.text();
  return new File([text], name, { type: blob.type });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('json backup round-trip', () => {
  it('restores the meaningful fields losslessly', async () => {
    const data = fixture();
    const catalog = createCatalog(data);

    const blob = await jsonBackupExportPlugin.export({}, {
      data,
      catalog,
      units: undefined as never,
      locale: 'cs',
    });
    const file = await fileFromBlob(blob, 'vitametr-backup.json');

    const proposals = await jsonBackupImportPlugin.parse({ kind: 'file', file }, { catalog });
    // source names are surfaced for the review UI to map back
    expect(proposals[0].sourceName).toBe('Synlab, s.r.o.');

    const pipeline = createImportPipeline(catalog, deps());
    const items = pipeline.prepare(proposals, { catalog });
    // every proposal resolves (metric ids came straight from the backup)
    expect(items.every((i) => i.resolvedMetricId !== undefined)).toBe(true);
    for (const item of items) item.decision = 'accept';

    const restored = pipeline.commit(items, { pluginId: 'json-backup' });

    expect(restored.map(meaningful)).toEqual(data.measurements.map(meaningful));
    // and the censored operator + special-character note survived
    const crp = restored.find((m) => m.metricId === 'builtin:crp');
    expect(crp?.operator).toBe('<');
    expect(crp?.note).toBe('Ranní odběr; "nalačno"\nkontrolní');
  });

  it('is a well-formed, versioned envelope', async () => {
    const data = fixture();
    const catalog = createCatalog(data);
    const blob = await jsonBackupExportPlugin.export({}, {
      data,
      catalog,
      units: undefined as never,
      locale: 'en',
    });
    const parsed = JSON.parse(await blob.text());
    expect(parsed.format).toBe('vitametr-backup');
    expect(parsed.backupVersion).toBe(1);
    expect(parsed.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(parsed.sources).toHaveLength(1);
    expect(parsed.measurements).toHaveLength(3);
  });
});

describe('password-protected backup', () => {
  async function encryptedFile(password: string): Promise<File> {
    const data = fixture();
    const catalog = createCatalog(data);
    const blob = await jsonBackupExportPlugin.export(
      { password },
      { data, catalog, units: undefined as never, locale: 'cs' },
    );
    return fileFromBlob(blob, 'vitametr-backup.json');
  }

  it('emits an encrypted envelope that reveals no plaintext', async () => {
    const file = await encryptedFile('export-pw');
    const parsed = JSON.parse(await file.text());
    expect(parsed.format).toBe('vitametr-backup-encrypted');
    expect(parsed.backupVersion).toBe(1);
    expect(parsed.ciphertext).toBeTypeOf('string');
    // No measurement/source data leaks into the envelope.
    expect(parsed.measurements).toBeUndefined();
    expect(await file.text()).not.toContain('Synlab');
  });

  it('imports back with the correct password', async () => {
    const file = await encryptedFile('export-pw');
    const catalog = createCatalog(fixture());
    const proposals = await jsonBackupImportPlugin.parse(
      { kind: 'file', file },
      { catalog, password: 'export-pw' },
    );
    expect(proposals).toHaveLength(3);
    expect(proposals[0].sourceName).toBe('Synlab, s.r.o.');
  });

  it('signals PassphraseRequiredError when no password is given', async () => {
    const file = await encryptedFile('export-pw');
    const catalog = createCatalog(fixture());
    await expect(
      jsonBackupImportPlugin.parse({ kind: 'file', file }, { catalog }),
    ).rejects.toBeInstanceOf(PassphraseRequiredError);
  });

  it('rejects a wrong password with WrongPassphraseError', async () => {
    const file = await encryptedFile('export-pw');
    const catalog = createCatalog(fixture());
    await expect(
      jsonBackupImportPlugin.parse(
        { kind: 'file', file },
        { catalog, password: 'wrong' },
      ),
    ).rejects.toBeInstanceOf(WrongPassphraseError);
  });
});

describe('ExportSelection filtering', () => {
  const data = fixture();
  const catalog = createCatalog(data);

  async function measurementsFor(selection: Parameters<typeof jsonBackupExportPlugin.export>[0]) {
    const blob = await jsonBackupExportPlugin.export(selection, {
      data,
      catalog,
      units: undefined as never,
      locale: 'en',
    });
    return JSON.parse(await blob.text()).measurements as Measurement[];
  }

  it('filters by metric id', async () => {
    const out = await measurementsFor({ metricIds: ['builtin:crp' as MetricId] });
    expect(out).toHaveLength(1);
    expect(out[0].metricId).toBe('builtin:crp');
  });

  it('filters by date range (inclusive)', async () => {
    const out = await measurementsFor({ range: { from: '2026-02-01', to: '2026-02-28' } });
    expect(out).toHaveLength(1);
    expect(out[0].metricId).toBe('builtin:crp');
  });

  it('combines metric and range filters', async () => {
    const out = await measurementsFor({
      metricIds: ['builtin:glucose' as MetricId],
      range: { from: '2026-03-01' },
    });
    expect(out).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Carrying a whole profile — and a whole device — in the same file.
// ---------------------------------------------------------------------------

describe('a backup that carries the setup, not just the readings', () => {
  /** A profile with everything a restore should be able to bring back. */
  function furnished(): ProfileData {
    const data = fixture();
    data.profile.name = 'Milan';
    data.metrics = [
      {
        id: 'user:1' as MetricId,
        customName: 'Vlastní veličina',
        aliases: ['vlastni'],
        category: 'custom',
        valueType: 'number',
        canonicalUnit: 'mmol/L',
        units: ['mmol/L'],
        tags: ['builtin:watched'],
      } as ProfileData['metrics'][number],
    ];
    data.units = [
      { code: 'x/L', display: 'x/l', dimension: 'arbitrary', toBase: { factor: 1 } },
    ] as ProfileData['units'];
    data.disabledMetrics = ['builtin:psa' as MetricId];
    data.importMappings = [
      {
        id: 'map-1',
        sourceName: 'Moje laborka',
        detect: { anyOf: ['MOJE'] },
        pattern: '(?<name>.+)',
      },
    ] as ProfileData['importMappings'];
    data.imports = [] as ProfileData['imports'];
    data.settings = { locale: 'cs', unitSystem: 'us', useTags: false };
    return data;
  }

  it('writes the parts a restore needs, beside the ones it always wrote', async () => {
    const data = furnished();
    const blob = await jsonBackupExportPlugin.export({}, exportCtx(data));
    const backup = JSON.parse(await blob.text()) as Record<string, unknown>;

    // Unchanged shape — an older build looks for exactly these.
    expect(backup.format).toBe('vitametr-backup');
    expect(backup.profile).toMatchObject({ name: 'Milan' });
    expect(backup.measurements).toHaveLength(3);
    // …plus the setup it used to leave behind.
    expect(backup.units).toHaveLength(1);
    expect(backup.disabledMetrics).toEqual(['builtin:psa']);
    expect(backup.importMappings).toHaveLength(1);
    expect(backup.settings).toMatchObject({ unitSystem: 'us', useTags: false });
    expect(backup.metrics).toHaveLength(1);
  });

  it('carries the other profiles without repeating the active one', async () => {
    const active = furnished();
    const other = fixture();
    other.profile = { id: 'p2' as ProfileId, name: 'Romana', createdAt: '2026-02-01' };

    const blob = await jsonBackupExportPlugin.export({}, {
      ...exportCtx(active),
      otherProfiles: [other],
    });
    const backup = JSON.parse(await blob.text()) as Record<string, unknown>;

    // The active profile stays exactly where every reader expects it, and the
    // rest live beside it — so a single-profile backup is byte-for-byte what it
    // was before, and a family backup is not twice the size.
    expect(backup.profile).toMatchObject({ name: 'Milan' });
    const others = backup.otherProfiles as { profile: { name: string } }[];
    expect(others).toHaveLength(1);
    expect(others[0].profile.name).toBe('Romana');
    expect(JSON.stringify(others)).not.toContain('Milan');
  });

  it('leaves a single-profile backup exactly as it was', async () => {
    const blob = await jsonBackupExportPlugin.export({}, exportCtx(fixture()));
    const backup = JSON.parse(await blob.text()) as Record<string, unknown>;
    expect(backup).not.toHaveProperty('otherProfiles');
  });

  it('still restores the readings of a file written before any of this', async () => {
    // The previous release's envelope, verbatim: no units, no disabledMetrics,
    // no otherProfiles. It must keep restoring, unchanged.
    const legacy = {
      format: 'vitametr-backup',
      backupVersion: 1,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      profile: { id: PROFILE_ID, name: 'Test', createdAt: '2026-01-01' },
      metrics: [],
      sources: [{ id: SRC, name: 'Synlab, s.r.o.', kind: 'lab' }],
      measurements: fixture().measurements,
      settings: { locale: 'cs' },
    };
    const items = await jsonBackupImportPlugin.parse(
      { kind: 'data', data: legacy },
      { catalog: createCatalog(fixture()) },
    );
    expect(items).toHaveLength(3);
  });
});
