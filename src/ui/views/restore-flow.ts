/**
 * The restore of a backup, as a flow rather than a single action.
 *
 * A backup can hold several people, and each of them can land somewhere
 * different: a brand-new profile (written straight in — nothing to reconcile),
 * or an existing one (whose readings must go through review like any import, so
 * duplicates and conflicts stay the user's decision). Those two kinds cannot be
 * done in one pass, and review only ever works on the profile that is open.
 *
 * So this module owns the middle: it holds what the file said, what the user
 * chose in the restore dialog, and how far the run has got. Review hands control
 * back here after each commit (`noteReviewResult` + `continueRestore`), and the
 * flow either opens the next profile or shows the summary.
 *
 * Everything decision-shaped lives in `core/backup-restore.ts` and is pure; what
 * is here is sequencing and storage, which is exactly what cannot be pure.
 */

import type { AppContext } from '../app-context';
import type { ProfileId } from '../../core/types';
import type { ProfileBackup, VitametrBackup } from '../../plugins/export/json-backup';
import { proposalsFromBackup } from '../../plugins/import/json-backup';
import {
  applyBackupSetup,
  isPristineProfile,
  previewBackup,
  profileDataFromBackup,
  type BackupPreview,
  type RestoreTarget,
} from '../../core/backup-restore';
import { dispatchPreparedImport } from './import-actions';
import { newMeasurementId } from '../runtime';

/** What the user decided in the restore dialog, per profile in the file. */
export interface RestoreDecisions {
  targets: RestoreTarget[];
  /** Profile ids whose existing setup the user allowed to be overwritten. */
  overwriteSetupFor: ProfileId[];
}

/** The file, plus what the dialog needs to describe it. */
export interface PendingRestore {
  backup: VitametrBackup;
  preview: BackupPreview;
  fileName: string;
}

/** Running totals, filled in as each profile is committed. */
export interface RestoreSummary {
  added: number;
  skipped: number;
  unassigned: number;
  /** Names of the profiles that were created. */
  createdProfiles: string[];
  /** How many new profiles had their setup restored automatically. */
  setupAuto: number;
  /** Names of used profiles whose setup the user chose to overwrite. */
  setupOverwritten: string[];
  /** The first profile created, for the summary's "switch to" action. */
  firstCreatedId?: ProfileId;
}

let pending: PendingRestore | undefined;
let summary: RestoreSummary | undefined;
/** Profiles still waiting for their turn in review, in file order. */
let queue: { backup: ProfileBackup; target: ProfileId }[] = [];

/** Hand a freshly read backup to the restore screen. Nothing is written yet. */
export function startRestore(ctx: AppContext, backup: VitametrBackup, fileName: string): void {
  pending = { backup, preview: previewBackup(backup), fileName };
  summary = undefined;
  queue = [];
  ctx.navigate('restore');
}

/** What the restore screen renders; `undefined` when there is nothing pending. */
export function getPendingRestore(): PendingRestore | undefined {
  return pending;
}

/** What the summary screen renders. */
export function getRestoreSummary(): RestoreSummary | undefined {
  return summary;
}

/** Abandon the pending restore (Cancel, or leaving the screen). */
export function clearRestore(): void {
  pending = undefined;
  queue = [];
}

/** Every profile in the file, top-level one first — the order the dialog shows. */
function profilesOf(backup: VitametrBackup): ProfileBackup[] {
  return [backup, ...(backup.otherProfiles ?? [])];
}

/**
 * Carry out the decisions.
 *
 * New profiles are created and filled here and now: a fresh profile has nothing
 * to reconcile, so review would only be ceremony. Profiles aimed at an existing
 * one are queued and handed to review one at a time.
 */
export async function runRestore(ctx: AppContext, decisions: RestoreDecisions): Promise<void> {
  const current = pending;
  if (!current) return;
  const profiles = profilesOf(current.backup);
  const overwrite = new Set(decisions.overwriteSetupFor);

  summary = {
    added: 0,
    skipped: 0,
    unassigned: 0,
    createdProfiles: [],
    setupAuto: 0,
    setupOverwritten: [],
  };
  queue = [];

  for (let i = 0; i < profiles.length; i++) {
    const backup = profiles[i];
    const target = decisions.targets[i] ?? { kind: 'skip' };
    if (target.kind === 'skip') continue;

    if (target.kind === 'new') {
      // Created and filled in one go: an empty profile left behind by an
      // interrupted restore would be litter nobody could explain (spec §7).
      const created = await ctx.store.createProfile({ name: backup.profile?.name ?? '' });
      const filled = profileDataFromBackup(
        backup,
        { id: created.profile.id, createdAt: created.profile.createdAt },
        newMeasurementId,
      );
      ctx.mutate((d) => {
        Object.assign(d, filled, { profile: { ...d.profile, name: filled.profile.name } });
      });
      await ctx.store.flush();
      // The name as stored; the summary translates an empty one into the
      // localized default rather than printing a gap.
      summary.createdProfiles.push(filled.profile.name);
      summary.setupAuto += 1;
      summary.added += filled.measurements.length;
      summary.firstCreatedId ??= created.profile.id;
      continue;
    }

    queue.push({ backup, target: target.id });
  }

  // Setup for the profiles that already exist: automatic into an untouched one,
  // otherwise only where the user ticked the box.
  for (const step of queue) {
    const isActive = step.target === ctx.activeProfileId();
    if (!isActive) await ctx.switchProfile(step.target);
    const data = ctx.data();
    // Read the state BEFORE writing: applyBackupSetup fills the profile in, so
    // asking afterwards would report every automatic restore as an overwrite.
    const wasPristine = isPristineProfile(data);
    const nameBefore = data.profile.name;
    if (wasPristine || overwrite.has(step.target)) {
      ctx.mutate((d) => applyBackupSetup(d, step.backup));
      if (wasPristine) summary.setupAuto += 1;
      else summary.setupOverwritten.push(nameBefore);
    }
  }

  await openNextInReview(ctx, current.fileName);
}

/** Open the next queued profile in review, or finish. */
async function openNextInReview(ctx: AppContext, fileName: string): Promise<void> {
  const next = queue.shift();
  if (!next) {
    pending = undefined;
    ctx.navigate('restore-done');
    return;
  }
  if (next.target !== ctx.activeProfileId()) await ctx.switchProfile(next.target);
  // Through the ordinary pipeline: a restore into a profile that already holds
  // data is an import like any other, dedup and conflicts included.
  const items = ctx.pipeline().prepare(proposalsFromBackup(next.backup), {
    catalog: ctx.catalog(),
  });
  dispatchPreparedImport(ctx, items, {
    pluginId: 'json-backup',
    fileName,
    // Tells review to hand control back here instead of going to the overview.
    restore: true,
  });
}

/** Whether a restore is waiting on the review screen right now. */
export function isRestoreInProgress(): boolean {
  return summary !== undefined;
}

/** Review reports what its commit did, so the summary can add it up. */
export function noteReviewResult(result: {
  added: number;
  skipped: number;
  unassigned: number;
}): void {
  if (!summary) return;
  summary.added += result.added;
  summary.skipped += result.skipped;
  summary.unassigned += result.unassigned;
}

/** Called by review after a commit: next profile, or the summary screen. */
export async function continueRestore(ctx: AppContext): Promise<void> {
  await openNextInReview(ctx, pending?.fileName ?? '');
}
