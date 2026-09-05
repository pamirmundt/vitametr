/**
 * Turning a backup file back into profiles (pure — no DOM, no storage, no clock).
 *
 * A backup has always restored READINGS, through the review screen like any
 * other import. What it never restored was the SETUP those readings live in:
 * the profile's name, its own metrics and learned aliases, custom units, which
 * built-ins are switched off, its preferences. Restoring on a new phone
 * therefore gave you your numbers in a stranger's app.
 *
 * The rules here are deliberately few, because a restore that needs explaining
 * is a restore nobody trusts:
 *
 *  - Setup is written over a profile only when that profile is PRISTINE — newly
 *    created, nothing entered, nothing configured. Then there is nothing to
 *    lose and no question to ask. Onto a profile someone has already used, the
 *    setup is applied only if the caller says so explicitly.
 *  - Other profiles in the file become NEW profiles, whole and directly: a
 *    fresh profile has nothing to reconcile, so there is nothing for review to
 *    decide. Merging into an existing person's data is never done implicitly —
 *    that decision belongs to the user, not to a file.
 */

import type { ProfileBackup, VitametrBackup } from '../plugins/export/json-backup';
import type { Measurement, MeasurementId, ProfileData, ProfileId, ProfileSummary } from './types';
import { CURRENT_SCHEMA_VERSION } from './types';
import { effectiveActivePacks } from './packs';

/**
 * Whether a profile has never been used: no readings, no metrics of its own, no
 * preference set, no name. Exactly the state `createProfile` leaves behind, so
 * writing a backup's setup into it cannot destroy anything the user did.
 */
export function isPristineProfile(data: ProfileData): boolean {
  return (
    data.measurements.length === 0 &&
    data.metrics.length === 0 &&
    data.sources.length === 0 &&
    (data.units ?? []).length === 0 &&
    (data.disabledMetrics ?? []).length === 0 &&
    (data.importMappings ?? []).length === 0 &&
    Object.keys(data.settings).filter((k) => k !== 'locale' && k !== 'theme').length === 0
  );
}

/**
 * Write a backup's SETUP onto a profile: everything except the readings, which
 * travel through the import pipeline so they can be reviewed and de-duplicated.
 * The profile's identity (id, createdAt) is never touched — the profile keeps
 * being itself, it only takes over how it was configured.
 */
export function applyBackupSetup(target: ProfileData, backup: ProfileBackup): void {
  if (backup.profile?.name) target.profile.name = backup.profile.name;
  target.metrics = structuredClone(backup.metrics ?? []);
  target.sources = structuredClone(backup.sources ?? []);
  // `locale` and `theme` belong to the device now (see ui/device-prefs); a
  // backup written by an older build still carries them and they are dropped,
  // so restoring someone's data never repaints or re-translates the app.
  const settings = structuredClone(backup.settings ?? {});
  delete settings.locale;
  delete settings.theme;
  target.settings = settings;
  if (backup.units) target.units = structuredClone(backup.units);
  if (backup.disabledMetrics) target.disabledMetrics = structuredClone(backup.disabledMetrics);
  if (backup.importMappings) target.importMappings = structuredClone(backup.importMappings);
  if (backup.imports) target.imports = structuredClone(backup.imports);
}

/**
 * A complete ProfileData for a profile that exists only in the backup. Readings
 * are taken as they are — this is a brand-new profile, so there is nothing to
 * conflict with and nothing for review to decide — but their `profileId` is
 * re-pointed at the profile actually being created, and their ids are re-minted
 * so two restores of the same file cannot collide.
 */
export function profileDataFromBackup(
  backup: ProfileBackup,
  target: { id: ProfileId; createdAt: string },
  newMeasurementId: () => MeasurementId,
): ProfileData {
  const data: ProfileData = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    profile: {
      id: target.id,
      name: backup.profile?.name ?? '',
      // The profile's own creation date is worth keeping: it is part of the
      // history being restored, not of this device.
      createdAt: backup.profile?.createdAt ?? target.createdAt,
    },
    metrics: [],
    sources: [],
    measurements: [],
    settings: {},
  };
  applyBackupSetup(data, backup);
  data.measurements = (backup.measurements ?? []).map(
    (m): Measurement => ({
      ...structuredClone(m),
      id: newMeasurementId(),
      profileId: target.id,
    }),
  );
  return data;
}

/** What restoring a given backup into a given device would do. */
export interface RestorePlan {
  /** Readings that go through review, for the profile that is open. */
  measurementCount: number;
  /** Whether the open profile's setup would be written over. */
  restoresSetup: boolean;
  /** Names of the profiles that would be CREATED (never merged into). */
  createsProfiles: string[];
}

/**
 * Describe a restore before anything is written. The UI shows this; nothing
 * here mutates, reads a clock, or decides on the user's behalf.
 */
export function planRestore(
  backup: ProfileBackup & { otherProfiles?: ProfileBackup[] },
  activeProfile: ProfileData,
  options: { includeOtherProfiles: boolean; setupOntoUsedProfile?: boolean } = {
    includeOtherProfiles: true,
  },
): RestorePlan {
  const pristine = isPristineProfile(activeProfile);
  return {
    measurementCount: (backup.measurements ?? []).length,
    restoresSetup: pristine || options.setupOntoUsedProfile === true,
    createsProfiles: options.includeOtherProfiles
      ? (backup.otherProfiles ?? []).map((p) => p.profile?.name ?? '')
      : [],
  };
}

// ---------------------------------------------------------------------------
// Preview — everything the "what will happen" screen needs, before any write
// ---------------------------------------------------------------------------

/** One profile as the file describes it. */
export interface BackupProfilePreview {
  name: string;
  measurementCount: number;
  /** Oldest / newest reading in that profile (ISO), absent when it has none. */
  from?: string;
  to?: string;
}

export interface BackupPreview {
  /** When the file was written, when it says so. */
  createdAt?: string;
  appVersion?: string;
  schemaVersion: number;
  /** Every profile in the file; index 0 is the one at the top level. */
  profiles: BackupProfilePreview[];
  totalMeasurements: number;
  from?: string;
  to?: string;
}

function span(measurements: readonly Measurement[]): { from?: string; to?: string } {
  let from: string | undefined;
  let to: string | undefined;
  for (const m of measurements) {
    if (from === undefined || m.takenAt < from) from = m.takenAt;
    if (to === undefined || m.takenAt > to) to = m.takenAt;
  }
  return { ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}) };
}

/**
 * Read a backup without writing anything: how many readings, whose, and over
 * what period. The restore screen is built entirely from this, so the file can
 * be inspected and the dialog cancelled without a trace.
 */
export function previewBackup(backup: VitametrBackup): BackupPreview {
  const all: ProfileBackup[] = [backup, ...(backup.otherProfiles ?? [])];
  const profiles = all.map((p) => ({
    name: p.profile?.name ?? '',
    measurementCount: (p.measurements ?? []).length,
    ...span(p.measurements ?? []),
  }));
  const everything = all.flatMap((p) => p.measurements ?? []);
  return {
    ...(backup.createdAt !== undefined ? { createdAt: backup.createdAt } : {}),
    ...(backup.appVersion !== undefined ? { appVersion: backup.appVersion } : {}),
    schemaVersion: backup.schemaVersion,
    profiles,
    totalMeasurements: everything.length,
    ...span(everything),
  };
}

// ---------------------------------------------------------------------------
// Where each profile in the file should land
// ---------------------------------------------------------------------------

/** What to do with one profile from the file. */
export type RestoreTarget =
  | { kind: 'new' }
  | { kind: 'existing'; id: ProfileId }
  | { kind: 'skip' };

/** Case- and diacritics-insensitive name key, as used to spot "my own backup". */
function nameKey(name: string): string {
  return name.trim().toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
}

/**
 * The safe default for every profile in the file: a NEW profile, so nothing an
 * existing profile holds can be touched — except where the name matches one
 * exactly, which is the "I am restoring my own backup" case and by far the most
 * common one. Two profiles never default onto the same existing profile.
 */
export function defaultRestoreTargets(
  preview: BackupPreview,
  existing: readonly ProfileSummary[],
  /**
   * True when the device holds exactly ONE profile and it has never been used —
   * a fresh install. A profile from the file then lands in it rather than beside
   * it: restoring a backup onto a new phone should not leave an empty "My
   * profile" behind, which is litter the user cannot explain and cannot merge
   * away (there is no merge). Caller-supplied because only it can see the
   * profile's contents.
   */
  freshInstall = false,
): RestoreTarget[] {
  const targets: RestoreTarget[] = preview.profiles.map(() => ({ kind: 'new' }));
  const taken = new Set<ProfileId>();

  // Names first, across the whole file: an unnamed profile must not take the
  // fresh install's slot away from the one that actually shares its name.
  preview.profiles.forEach((p, index) => {
    const match = existing.find((e) => nameKey(e.name) === nameKey(p.name) && !taken.has(e.id));
    if (!match) return;
    taken.add(match.id);
    targets[index] = { kind: 'existing', id: match.id };
  });

  // Then, on a fresh install, the first profile still without a home moves into
  // the empty profile the app made on first run.
  if (freshInstall && existing.length === 1 && !taken.has(existing[0].id)) {
    const first = targets.findIndex((t) => t.kind === 'new');
    if (first >= 0) {
      taken.add(existing[0].id);
      targets[first] = { kind: 'existing', id: existing[0].id };
    }
  }
  return targets;
}

/**
 * Point one profile at a target, keeping the invariant that two profiles from
 * the file never restore into the SAME existing profile — the one that held it
 * before falls back to a new profile, and the caller is told which so it can
 * say so. (Merging two people into one profile is never what anybody meant.)
 */
export function chooseRestoreTarget(
  targets: readonly RestoreTarget[],
  index: number,
  choice: RestoreTarget,
): { targets: RestoreTarget[]; displaced?: number } {
  const next = [...targets];
  next[index] = choice;
  let displaced: number | undefined;
  if (choice.kind === 'existing') {
    for (let i = 0; i < next.length; i++) {
      const t = next[i];
      if (i !== index && t.kind === 'existing' && t.id === choice.id) {
        next[i] = { kind: 'new' };
        displaced = i;
      }
    }
  }
  return { targets: next, ...(displaced !== undefined ? { displaced } : {}) };
}

/** How many profiles the restore would create — the number the dialog shows. */
export function newProfileCount(targets: readonly RestoreTarget[]): number {
  return targets.filter((t) => t.kind === 'new').length;
}

// ---------------------------------------------------------------------------
// What overwriting a used profile's setup would cost
// ---------------------------------------------------------------------------

/**
 * What the user would LOSE by letting a backup's setup overwrite a profile that
 * is already in use. Deliberately counts what is there today rather than what
 * arrives: the question being answered is "what am I giving up".
 */
export interface SettingsLoss {
  /** Custom unit definitions this profile added. */
  units: number;
  /** Distinct tags its metrics carry. */
  tags: number;
  /** Metric packs switched on today. */
  packs: string[];
  /** Preferences set (unit system, layouts, tag options…) — locale/theme excluded. */
  preferences: number;
  /** Nothing to lose: the caller shows no checkbox at all. */
  isEmpty: boolean;
}

export function settingsOverwriteLoss(target: ProfileData): SettingsLoss {
  const tags = new Set<string>();
  for (const m of target.metrics) for (const t of m.tags ?? []) tags.add(t);
  const preferences = Object.keys(target.settings).filter(
    (k) => k !== 'locale' && k !== 'theme',
  ).length;
  // Only packs the user actually chose: Core is on by default in every profile,
  // so listing it as something they would "lose" is scaremongering.
  const packs = target.settings.activePacks ? effectiveActivePacks(target.settings) : [];
  const units = (target.units ?? []).length;
  return {
    units,
    tags: tags.size,
    packs,
    preferences,
    isEmpty: units === 0 && tags.size === 0 && preferences === 0 && packs.length === 0,
  };
}
