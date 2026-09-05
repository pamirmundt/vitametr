/**
 * JSON backup export plugin (step K7).
 *
 * The canonical, versioned, lossless backup format (design doc §5.2). It serializes
 * the whole ProfileData — profile, user metrics/overrides, sources, measurements
 * (with status, rawText, external codes, reference ranges) and settings — so that
 * `json-backup` import + the review pipeline can restore it. Round-trip is identity
 * on the meaningful measurement fields.
 *
 * Honors ExportSelection: measurements are filtered by `metricIds` and by the
 * `range` (inclusive on `takenAt`; ISO 8601 strings sort chronologically). Metrics,
 * sources, profile and settings are always included in full so a restore can resolve
 * every retained measurement and preserve the user's catalog customizations.
 *
 * No clock is used (banned APIs): the envelope deliberately carries no "exportedAt"
 * timestamp — the export context provides no injected clock, and guessing one is
 * disallowed.
 */

import type { ExportContext, ExportPlugin, ExportSelection } from '../../core/contracts.js';
import type {
  ImportMappingDef,
  ImportRecord,
  Measurement,
  Metric,
  MetricId,
  Profile,
  ProfileData,
  ProfileSettings,
  Source,
  UnitDef,
} from '../../core/types.js';
import {
  sealWithPassphrase,
  type PassphraseEnvelope,
} from '../../storage/crypto.js';
import { snapshotMeasurements } from '../../core/snapshot.js';

/** Envelope format version — independent of the ProfileData schemaVersion. */
export const BACKUP_FORMAT = 'vitametr-backup' as const;
export const BACKUP_FORMAT_VERSION = 1 as const;

/** Marker for a password-protected backup: the plain backup JSON, encrypted. */
export const ENCRYPTED_BACKUP_FORMAT = 'vitametr-backup-encrypted' as const;

export interface EncryptedBackup extends PassphraseEnvelope {
  format: typeof ENCRYPTED_BACKUP_FORMAT;
  backupVersion: typeof BACKUP_FORMAT_VERSION;
}

/**
 * Everything one profile is made of, as it travels in a backup. The measurement
 * list is the only part an ExportSelection filters; the rest is what makes the
 * readings mean something (which metrics exist, what units they use, which
 * packs are on), so it is always written whole.
 */
export interface ProfileBackup {
  profile: Profile;
  metrics: Metric[];
  sources: Source[];
  measurements: Measurement[];
  settings: ProfileSettings;
  /** Custom unit definitions the profile added. */
  units?: UnitDef[];
  /** Built-in metrics switched off in this profile. */
  disabledMetrics?: MetricId[];
  /** Recorded file imports (provenance of the readings above). */
  imports?: ImportRecord[];
  /** User-added declarative import mappings. */
  importMappings?: ImportMappingDef[];
}

/**
 * The backup envelope.
 *
 * The ACTIVE profile's parts sit at the top level and always have — an older
 * build looks for exactly `profile` / `metrics` / `sources` / `measurements` /
 * `settings` there and keeps working with a file this build writes. Everything
 * added since is optional and sits beside them, so the format never forked into
 * "old" and "new": there is one file kind, and readers take what they know.
 *
 * `otherProfiles` deliberately excludes the active one rather than listing all
 * of them uniformly: a single-profile backup then stays byte-for-byte what it
 * was, and a family backup does not carry one profile twice.
 */
export interface VitametrBackup extends ProfileBackup {
  format: typeof BACKUP_FORMAT;
  /** Version of this envelope shape. */
  backupVersion: typeof BACKUP_FORMAT_VERSION;
  /** ProfileData schema version, so a restore can migrate/refuse as needed. */
  schemaVersion: number;
  /** Vitametr build that produced the backup (diagnostics only). */
  appVersion?: string;
  /**
   * When the file was written (ISO 8601), from the caller's injected clock —
   * no plugin reads the wall clock. Absent in files written before this, and in
   * exports whose caller supplies no `nowIso`; the restore screen then simply
   * omits the date rather than inventing one.
   */
  createdAt?: string;
  /** Every OTHER profile on the device, whole. Absent for a single profile. */
  otherProfiles?: ProfileBackup[];
}

/** ISO 8601 strings compare chronologically, so range filtering is a string compare. */
function inRange(takenAt: string, range: ExportSelection['range']): boolean {
  if (!range) return true;
  if (range.from !== undefined && takenAt < range.from) return false;
  if (range.to !== undefined && takenAt > range.to) return false;
  return true;
}

export function selectMeasurements(
  measurements: readonly Measurement[],
  selection: ExportSelection,
): Measurement[] {
  // Snapshot mode: the single latest measurement of each selected metric at or
  // before the reference date (CSV/FHIR/report honor this for free). Falls back
  // to the range path if the mode is set without a reference date.
  if (selection.mode === 'snapshot' && selection.asOfIso) {
    return snapshotMeasurements(measurements, selection.metricIds, selection.asOfIso);
  }
  const metricFilter = selection.metricIds ? new Set(selection.metricIds) : undefined;
  return measurements.filter(
    (m) =>
      (!metricFilter || metricFilter.has(m.metricId)) && inRange(m.takenAt, selection.range),
  );
}

/** One profile's parts, with only the measurements the selection keeps. */
function profileBackup(data: ProfileData, selection: ExportSelection): ProfileBackup {
  return {
    profile: data.profile,
    metrics: data.metrics,
    sources: data.sources,
    measurements: selectMeasurements(data.measurements, selection),
    settings: data.settings,
    ...(data.units ? { units: data.units } : {}),
    ...(data.disabledMetrics ? { disabledMetrics: data.disabledMetrics } : {}),
    ...(data.imports ? { imports: data.imports } : {}),
    ...(data.importMappings ? { importMappings: data.importMappings } : {}),
  };
}

export const jsonBackupExportPlugin: ExportPlugin = {
  id: 'json-backup',
  nameKey: 'export.json-backup',
  fileExtension: 'json',

  async export(selection: ExportSelection, ctx: ExportContext): Promise<Blob> {
    const { data } = ctx;

    const backup: VitametrBackup = {
      format: BACKUP_FORMAT,
      backupVersion: BACKUP_FORMAT_VERSION,
      schemaVersion: data.schemaVersion,
      appVersion: data.appVersion,
      ...(ctx.nowIso !== undefined ? { createdAt: ctx.nowIso } : {}),
      ...profileBackup(data, selection),
    };
    // Other profiles are never filtered by the selection: the selection is a
    // view of the profile on screen, and silently applying it to the others
    // would produce a "backup" quietly missing someone else's readings.
    if (ctx.otherProfiles && ctx.otherProfiles.length > 0) {
      backup.otherProfiles = ctx.otherProfiles.map((p) => profileBackup(p, {}));
    }

    // Pretty-printed for human inspectability; JSON is exact and lossless.
    const json = JSON.stringify(backup, null, 2);

    // Password-protected backup: encrypt the JSON under a key derived from the
    // export password (like a certificate file). The password is never stored —
    // it must be re-entered to import the file.
    if (selection.password) {
      const envelope = await sealWithPassphrase(
        new TextEncoder().encode(json),
        selection.password,
      );
      const encrypted: EncryptedBackup = {
        format: ENCRYPTED_BACKUP_FORMAT,
        backupVersion: BACKUP_FORMAT_VERSION,
        ...envelope,
      };
      return new Blob([JSON.stringify(encrypted, null, 2)], {
        type: 'application/json',
      });
    }

    return new Blob([json], { type: 'application/json' });
  },
};
