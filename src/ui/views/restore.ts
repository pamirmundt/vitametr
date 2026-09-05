/**
 * Restore from a backup: the "what will happen" screen and the summary that
 * follows it (`docs/redesign5/ZADANI-OBNOVA-ZALOHY.md`, screens 19 and 20).
 *
 * A backup is the one import that can reach beyond the readings — it can
 * reconfigure a profile and create people. So it does not go straight to review
 * like every other file: it stops here first and says, in numbers, what it is
 * about to do. Nothing is written until "Continue to review"; Cancel leaves no
 * trace at all.
 *
 * With a single profile on both sides the screen says nothing about profiles —
 * that would be talk about a feature the user does not use — and shrinks to the
 * two numbers that always matter: how many readings, over what period.
 */

import './restore.css';
import type { AppContext, View } from '../app-context';
import type { ProfileId } from '../../core/types';
import { formatDateTime } from '../../i18n/index';
import type { StringKey } from '../../i18n/index';
import {
  chooseRestoreTarget,
  defaultRestoreTargets,
  isPristineProfile,
  newProfileCount,
  settingsOverwriteLoss,
  type BackupProfilePreview,
  type RestoreTarget,
  type SettingsLoss,
} from '../../core/backup-restore';
import {
  clearRestore,
  getPendingRestore,
  getRestoreSummary,
  runRestore,
} from './restore-flow';
import { profileInitial } from './profile-model';
import { profileDisplayName } from './settings-model';

function el(tag: string, className?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function textEl(tag: string, text: string, className?: string): HTMLElement {
  const node = el(tag, className);
  node.textContent = text;
  return node;
}

function button(label: string, className: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = className;
  b.textContent = label;
  return b;
}

/** `3/2019 – 8/2026`, or a single month when the span is one. */
function periodLabel(from: string | undefined, to: string | undefined): string {
  if (!from || !to) return '—';
  const month = (iso: string): string => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : `${d.getMonth() + 1}/${d.getFullYear()}`;
  };
  const a = month(from);
  const b = month(to);
  return a === b ? a : `${a} – ${b}`;
}

// ---------------------------------------------------------------------------
// Screen 19 — what will happen
// ---------------------------------------------------------------------------

export const restoreView: View = {
  render(container: HTMLElement, ctx: AppContext): void {
    const { t } = ctx;
    container.replaceChildren();
    const pending = getPendingRestore();
    if (!pending) {
      ctx.navigate('import');
      return;
    }

    const { preview } = pending;
    const existing = ctx.profiles();
    // A fresh install (one profile, never used) is the "new phone" case: the
    // first profile in the file goes into it rather than beside it.
    const freshInstall = existing.length === 1 && isPristineProfile(ctx.data());
    let targets = defaultRestoreTargets(preview, existing, freshInstall);
    /** Profiles whose existing setup the user allows to be overwritten. */
    const overwrite = new Set<ProfileId>();

    const root = el('div', 'restore-view');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', t('restore.title'));

    root.append(textEl('h1', t('restore.title')));
    root.append(
      textEl(
        'p',
        `${pending.fileName} · ${
          preview.createdAt
            ? t('restore.fileMeta', {
                size: '',
                date: formatDateTime(preview.createdAt, 'date'),
              }).replace(/^\s*·\s*/, '')
            : ''
        }`.trim(),
        'restore-file muted',
      ),
    );

    // -- the numbers ---------------------------------------------------------
    // With one profile in the file, one on the device AND the readings landing
    // in it, there is nothing to decide about profiles and the counts about them
    // are left out. The moment a profile would be CREATED the section comes
    // back, whatever the numbers: nobody may be surprised by a new person.
    const simple =
      preview.profiles.length === 1 &&
      existing.length === 1 &&
      targets[0]?.kind === 'existing';
    const stats = el('div', 'restore-stats');
    const newCountEl = statBlock(
      String(newProfileCount(targets)),
      t('restore.statNewProfiles'),
    );
    stats.append(
      statBlock(String(preview.totalMeasurements), t('restore.statValues')),
      ...(simple
        ? []
        : [statBlock(String(preview.profiles.length), t('restore.statProfiles')), newCountEl]),
      statBlock(periodLabel(preview.from, preview.to), t('restore.statPeriod')),
    );
    root.append(stats);

    // -- profiles in the file ------------------------------------------------
    const profilesHost = el('div', 'restore-profiles');
    const settingsHost = el('div', 'restore-settings');
    const primary = button(t('restore.continue'), 'primary');

    if (!simple) {
      root.append(textEl('h2', t('restore.profilesSection'), 'restore-section-title'));
      root.append(profilesHost);
      root.append(textEl('p', t('restore.targetDefaultHint'), 'muted restore-note'));
    }
    root.append(settingsHost);
    root.append(textEl('p', t('restore.reviewHint'), 'muted restore-note'));
    root.append(textEl('p', t('restore.settingsDeviceHint'), 'muted restore-note'));

    /** Redraw the parts that depend on the current mapping. */
    function paint(): void {
      newCountEl.querySelector('.restore-stat-value')!.textContent = String(
        newProfileCount(targets),
      );
      if (!simple) {
        profilesHost.replaceChildren(
          ...preview.profiles.map((p, i) => profileRow(p, i)),
        );
      }
      paintSettings();
      primary.textContent =
        overwrite.size > 0 ? t('restore.continueOverwrite') : t('restore.continue');
    }

    /** One profile from the file, with where it should land. */
    function profileRow(profile: BackupProfilePreview, index: number): HTMLElement {
      const name = profileDisplayName(profile.name, t);
      const row = el('div', 'restore-profile-row');
      const avatar = el('span', 'profile-avatar');
      avatar.setAttribute('aria-hidden', 'true');
      avatar.style.setProperty('--avatar-size', '30px');
      avatar.style.background = 'var(--accent)';
      avatar.textContent = profileInitial(name);
      row.append(avatar);

      const text = el('div', 'restore-profile-text');
      text.append(textEl('span', name, 'restore-profile-name'));
      text.append(
        textEl(
          'span',
          t('restore.profileValues', {
            n: profile.measurementCount,
            from: profile.from ? formatDateTime(profile.from, 'date') : '—',
            to: profile.to ? formatDateTime(profile.to, 'date') : '—',
          }),
          'restore-profile-meta muted',
        ),
      );
      row.append(text);

      const select = document.createElement('select');
      select.className = 'restore-target';
      select.setAttribute('aria-label', t('restore.targetLabel', { name }));
      const options: { value: string; label: string }[] = [
        { value: 'new', label: t('restore.targetNew') },
        ...existing.map((e) => ({
          value: `existing:${e.id}`,
          label: t('restore.targetExisting', { name: profileDisplayName(e.name, t) }),
        })),
        { value: 'skip', label: t('restore.targetSkip') },
      ];
      for (const o of options) {
        const opt = document.createElement('option');
        opt.value = o.value;
        opt.textContent = o.label;
        select.append(opt);
      }
      const current = targets[index];
      select.value =
        current.kind === 'existing'
          ? `existing:${current.id}`
          : current.kind === 'skip'
            ? 'skip'
            : 'new';
      select.addEventListener('change', () => {
        const choice: RestoreTarget =
          select.value === 'new'
            ? { kind: 'new' }
            : select.value === 'skip'
              ? { kind: 'skip' }
              : { kind: 'existing', id: select.value.slice('existing:'.length) as ProfileId };
        const result = chooseRestoreTarget(targets, index, choice);
        targets = result.targets;
        if (result.displaced !== undefined) {
          const displacedName = profileDisplayName(
            preview.profiles[result.displaced].name,
            t,
          );
          ctx.toast(
            t('restore.targetTaken', {
              name: displacedName,
              target: profileDisplayName(
                existing.find((e) => `existing:${e.id}` === select.value)?.name ?? '',
                t,
              ),
            }),
          );
        }
        paint();
      });
      row.append(select);
      return row;
    }

    /** The settings block: an automatic note, plus one opt-in per used profile. */
    function paintSettings(): void {
      settingsHost.replaceChildren();
      const autoNames: string[] = [];
      const used: { id: ProfileId; name: string; loss: SettingsLoss }[] = [];

      targets.forEach((target, i) => {
        const name = profileDisplayName(preview.profiles[i].name, t);
        if (target.kind === 'new') {
          autoNames.push(name);
          return;
        }
        if (target.kind === 'skip') return;
        const summary = existing.find((e) => e.id === target.id);
        if (!summary) return;
        // Only the ACTIVE profile's data is in memory; for the others the
        // counts cannot be read without opening them, and opening them here
        // would be a write-shaped side effect of a preview. So the offer is
        // made where it can be made honestly: for the profile that is open.
        if (summary.id !== ctx.activeProfileId()) return;
        // An untouched profile takes the setup automatically — there is nothing
        // to overwrite, so it belongs to the note above, not to a decision.
        if (isPristineProfile(ctx.data())) {
          autoNames.push(profileDisplayName(summary.name, t));
          return;
        }
        const loss = settingsOverwriteLoss(ctx.data());
        if (loss.isEmpty) return;
        used.push({ id: summary.id, name: profileDisplayName(summary.name, t), loss });
      });

      if (autoNames.length > 0) {
        settingsHost.append(
          textEl(
            'p',
            t('restore.settingsAuto', { names: autoNames.join(', ') }),
            'muted restore-note',
          ),
        );
      }
      if (used.length === 0) return;

      settingsHost.append(
        textEl('h2', t('restore.settingsSection'), 'restore-section-title'),
      );
      for (const u of used) {
        const box = el('div', 'restore-overwrite');
        const label = el('label', 'restore-overwrite-label');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = overwrite.has(u.id);
        const detailId = `restore-loss-${u.id}`;
        cb.setAttribute('aria-describedby', detailId);
        cb.addEventListener('change', () => {
          if (cb.checked) overwrite.add(u.id);
          else overwrite.delete(u.id);
          primary.textContent =
            overwrite.size > 0 ? t('restore.continueOverwrite') : t('restore.continue');
        });
        label.append(cb, textEl('span', t('restore.settingsOverwrite', { name: u.name })));
        const detail = textEl(
          'p',
          t('restore.settingsOverwriteDetail', { items: lossItems(u.loss, t) }),
          'restore-overwrite-detail muted',
        );
        detail.id = detailId;
        box.append(label, detail);
        settingsHost.append(box);
      }
    }

    // -- actions -------------------------------------------------------------
    const actions = el('div', 'restore-actions');
    primary.addEventListener('click', () => {
      primary.disabled = true;
      void runRestore(ctx, { targets, overwriteSetupFor: [...overwrite] });
    });
    const cancel = button(t('common.cancel'), 'ghost');
    cancel.addEventListener('click', () => {
      clearRestore();
      ctx.navigate('import');
    });
    actions.append(primary, cancel);
    root.append(actions);

    root.addEventListener('keydown', (event) => {
      if ((event as KeyboardEvent).key === 'Escape') cancel.click();
    });

    container.append(root);
    paint();
    primary.focus();
  },
};

/** "jednotky (2), štítky (11), zapnuté balíčky (Core, Lipidy)" */
function lossItems(loss: SettingsLoss, t: AppContext['t']): string {
  const parts: string[] = [];
  if (loss.units > 0) parts.push(t('restore.lossUnits', { n: loss.units }));
  if (loss.tags > 0) parts.push(t('restore.lossTags', { n: loss.tags }));
  if (loss.packs.length > 0) {
    parts.push(t('restore.lossPacks', { n: loss.packs.length }));
  }
  if (loss.preferences > 0) parts.push(t('restore.lossPreferences', { n: loss.preferences }));
  return parts.join(', ');
}

function statBlock(value: string, label: string): HTMLElement {
  const block = el('div', 'restore-stat');
  block.append(textEl('span', value, 'restore-stat-value tnum'));
  block.append(textEl('span', label, 'restore-stat-label muted'));
  return block;
}

// ---------------------------------------------------------------------------
// Screen 20 — what happened
// ---------------------------------------------------------------------------

export const restoreDoneView: View = {
  render(container: HTMLElement, ctx: AppContext): void {
    const { t } = ctx;
    container.replaceChildren();
    const summary = getRestoreSummary();
    if (!summary) {
      ctx.navigate('overview');
      return;
    }

    const root = el('div', 'restore-view restore-done');
    root.append(textEl('h1', t('restore.doneTitle')));

    // The answer first, in the biggest type on the screen.
    const added = el('p', 'restore-done-added');
    added.setAttribute('role', 'status');
    added.append(
      textEl('span', t('restore.doneAdded'), 'restore-done-label'),
      textEl('span', t('restore.doneAddedValues', { n: summary.added }), 'restore-done-value'),
    );
    root.append(added);

    const lines = el('div', 'restore-done-lines');
    if (summary.skipped > 0) {
      lines.append(
        line(`${t('restore.doneDuplicates')} ${summary.skipped}`, 'muted'),
      );
    }
    if (summary.unassigned > 0) {
      const row = el('div', 'restore-done-line restore-done-warn');
      row.append(textEl('span', `${t('restore.doneUnassigned')} ${summary.unassigned}`));
      const resolve = button(t('restore.doneResolve'), 'link-button');
      resolve.addEventListener('click', () => ctx.navigate('review'));
      row.append(resolve);
      lines.append(row);
    }
    if (summary.createdProfiles.length > 0) {
      const names = summary.createdProfiles.map((n) => profileDisplayName(n, t));
      lines.append(line(`${t('restore.doneNewProfiles')}: ${names.join(', ')}`));
    }
    lines.append(line(`${t('restore.settingsSection')}: ${settingsLine(summary, t)}`, 'muted'));
    root.append(lines);

    const actions = el('div', 'restore-actions');
    const toOverview = button(t('restore.doneToOverview'), 'primary');
    toOverview.addEventListener('click', () => ctx.navigate('overview'));
    actions.append(toOverview);
    if (summary.firstCreatedId) {
      const name = profileDisplayName(summary.createdProfiles[0] ?? '', t);
      const switchTo = button(t('restore.doneSwitchTo', { name }), 'ghost');
      switchTo.addEventListener('click', () => {
        void ctx.switchProfile(summary.firstCreatedId as ProfileId);
      });
      actions.append(switchTo);
    }
    root.append(actions);
    container.append(root);
    toOverview.focus();
  },
};

function line(text: string, className = ''): HTMLElement {
  return textEl('div', text, `restore-done-line ${className}`.trim());
}

function settingsLine(
  summary: { setupAuto: number; setupOverwritten: string[] },
  t: (key: StringKey, params?: Record<string, string | number>) => string,
): string {
  const parts: string[] = [];
  if (summary.setupAuto > 0) parts.push(t('restore.doneSettingsAuto', { n: summary.setupAuto }));
  for (const name of summary.setupOverwritten) {
    parts.push(t('restore.doneSettingsOverwritten', { name }));
  }
  if (parts.length === 0) return t('restore.doneSettingsUnchanged');
  return parts.join(', ');
}
