/**
 * Settings → Profiles (`docs/ZADANI-VICE-PROFILU.md` §5).
 *
 * One person keeping records for several people. This screen is where profiles
 * are made, renamed and removed; the header switcher only chooses between them.
 *
 * Two rules shape everything here:
 *  - What is per profile and what is per device is stated once, up front, so
 *    nobody goes looking for a per-profile password that does not exist.
 *  - Deleting is irreversible and irreversible things get typed confirmation —
 *    the same bar as "delete all data", not an OK button.
 */

import type { AppContext } from '../app-context';
import type { ProfileSummary } from '../../core/types';
import { formatDateTime } from '../../i18n/index';
import { profileAvatar, readingCount } from '../components/profile-switcher';
import { isDuplicateName, profileSinceLine } from './profile-model';
import { profileDisplayName } from './settings-model';
import { switchControl } from '../components/switch';

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

/**
 * The whole section. `rerender` re-runs the Settings view: a profile change
 * touches the list, the header switcher and (on a switch) every other screen,
 * so nothing here tries to patch the DOM in place.
 */
export function renderProfilesSection(ctx: AppContext, rerender: () => void): HTMLElement {
  const { t } = ctx;
  const card = el('section', 'settings-group');
  card.append(textEl('h2', t('settings.profilesSection'), 'settings-group-title'));
  const body = el('div', 'settings-group-body');
  card.append(body);

  body.append(textEl('p', t('settings.profilesHint'), 'settings-note muted'));

  const profiles = ctx.profiles();
  const list = el('div', 'profiles-list');
  for (const profile of profiles) {
    list.append(renderRow(ctx, profile, profiles, rerender));
  }
  body.append(list);

  body.append(renderAddForm(ctx, profiles, rerender));
  body.append(textEl('p', t('settings.deviceScopeHint'), 'settings-note muted'));
  return card;
}

/** One profile: avatar, name (+ active badge), what is inside, and its actions. */
function renderRow(
  ctx: AppContext,
  profile: ProfileSummary,
  profiles: readonly ProfileSummary[],
  rerender: () => void,
): HTMLElement {
  const { t } = ctx;
  const isActive = profile.id === ctx.activeProfileId();
  const row = el('div', isActive ? 'profile-row is-active' : 'profile-row');

  row.append(profileAvatar(profile, 34, t));

  const text = el('div', 'profile-row-text');
  const nameLine = el('div', 'profile-row-nameline');
  nameLine.append(textEl('span', profileDisplayName(profile.name, t), 'profile-row-name'));
  if (isActive) nameLine.append(textEl('span', t('profile.active'), 'profile-row-badge'));
  text.append(nameLine);
  text.append(
    textEl(
      'div',
      profileSinceLine(profile, t, (iso) => formatDateTime(iso, 'date'), readingCount),
      'profile-row-meta muted',
    ),
  );
  row.append(text);

  const actions = el('div', 'profile-row-actions');
  const rename = button(t('profile.rename'), 'link-button');
  rename.addEventListener('click', () => {
    row.replaceChildren(renderRenameForm(ctx, profile, profiles, rerender));
  });
  actions.append(rename);

  const remove = button(t('profile.delete'), 'link-button profile-row-delete');
  remove.addEventListener('click', () => {
    row.replaceChildren(renderDeleteForm(ctx, profile, rerender));
  });
  // The guards are enforced by the store; saying WHY up front beats an error
  // after the click, so the button explains itself instead of disappearing.
  if (profiles.length <= 1) {
    remove.disabled = true;
    remove.title = t('profile.cannotDeleteLast');
  } else if (isActive) {
    remove.disabled = true;
    remove.title = t('profile.cannotDeleteActive');
  }
  actions.append(remove);
  row.append(actions);
  return row;
}

function renderRenameForm(
  ctx: AppContext,
  profile: ProfileSummary,
  profiles: readonly ProfileSummary[],
  rerender: () => void,
): HTMLElement {
  const { t } = ctx;
  const form = el('div', 'profile-form');
  const input = document.createElement('input');
  input.type = 'text';
  input.value = profile.name;
  input.placeholder = t('profile.defaultName');
  input.setAttribute('aria-label', t('profile.rename'));

  const warn = textEl('p', t('profile.duplicateName'), 'settings-note muted');
  warn.hidden = !isDuplicateName(input.value, profiles, profile.id);
  input.addEventListener('input', () => {
    warn.hidden = !isDuplicateName(input.value, profiles, profile.id);
  });

  const save = button(t('common.save'), 'primary');
  save.addEventListener('click', () => {
    void ctx.renameProfile(profile.id, input.value.trim()).then(rerender);
  });
  const cancel = button(t('common.cancel'), 'ghost');
  cancel.addEventListener('click', rerender);

  const actions = el('div', 'profile-form-actions');
  actions.append(save, cancel);
  form.append(input, warn, actions);
  return form;
}

/**
 * Deleting: the profile's name has to be typed out. It is the same bar as
 * "delete all data" because it is the same kind of loss — every reading of one
 * person, with no copy anywhere else.
 */
function renderDeleteForm(
  ctx: AppContext,
  profile: ProfileSummary,
  rerender: () => void,
): HTMLElement {
  const { t } = ctx;
  const name = profileDisplayName(profile.name, t);
  const form = el('div', 'profile-form profile-form--danger');
  form.append(textEl('p', t('profile.deleteConfirm', { name }), 'settings-note'));

  const input = document.createElement('input');
  input.type = 'text';
  input.setAttribute('aria-label', t('profile.deleteConfirm', { name }));

  const confirm = button(t('profile.delete'), 'danger') as HTMLButtonElement;
  confirm.disabled = true;
  input.addEventListener('input', () => {
    confirm.disabled = input.value.trim() !== name;
  });
  confirm.addEventListener('click', () => {
    void ctx.deleteProfile(profile.id).then(rerender, (err: unknown) => {
      ctx.toast(err instanceof Error ? err.message : String(err), 'error');
      rerender();
    });
  });

  const cancel = button(t('common.cancel'), 'ghost');
  cancel.addEventListener('click', rerender);

  const actions = el('div', 'profile-form-actions');
  actions.append(confirm, cancel);
  form.append(input, actions);
  return form;
}

/** "+ Add profile" → an inline form with the inherit choice, per §5.3. */
function renderAddForm(
  ctx: AppContext,
  profiles: readonly ProfileSummary[],
  rerender: () => void,
): HTMLElement {
  const { t } = ctx;
  const host = el('div', 'profiles-add');

  const open = button(`+ ${t('profile.add')}`, 'link-button profiles-add-btn');
  open.addEventListener('click', () => {
    host.replaceChildren(form());
    host.querySelector('input')?.focus();
  });
  host.append(open);
  return host;

  function form(): HTMLElement {
    const active = profiles.find((p) => p.id === ctx.activeProfileId());
    const activeName = profileDisplayName(active?.name ?? '', t);

    const wrap = el('div', 'profile-form');
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = t('profile.namePlaceholder');
    input.setAttribute('aria-label', t('profile.add'));

    const warn = textEl('p', t('profile.duplicateName'), 'settings-note muted');
    warn.hidden = true;
    input.addEventListener('input', () => {
      warn.hidden = !isDuplicateName(input.value, profiles);
    });

    // Inheriting is the common case: the second person is tracked with the same
    // units and the same panels — but never with the first person's readings.
    let inherit = true;
    const inheritRow = el('div', 'settings-row profile-inherit');
    const inheritText = el('span', 'settings-row-text');
    inheritText.append(
      textEl('span', t('profile.inherit', { name: activeName }), 'settings-row-label'),
      textEl('span', t('profile.inheritHint'), 'settings-row-meta muted'),
    );
    inheritRow.append(
      inheritText,
      switchControl({
        checked: inherit,
        label: t('profile.inherit', { name: activeName }),
        onChange: (next) => {
          inherit = next;
        },
      }).el,
    );

    const create = button(t('profile.createAndSwitch'), 'primary');
    create.addEventListener('click', () => {
      create.disabled = true;
      void ctx
        .createProfile({
          name: input.value.trim(),
          ...(inherit ? { inheritFrom: ctx.activeProfileId() } : {}),
        })
        .then(rerender, (err: unknown) => {
          create.disabled = false;
          ctx.toast(err instanceof Error ? err.message : String(err), 'error');
        });
    });
    const cancel = button(t('common.cancel'), 'ghost');
    cancel.addEventListener('click', () => {
      host.replaceChildren(open);
    });

    const actions = el('div', 'profile-form-actions');
    actions.append(create, cancel);
    wrap.append(input, warn, inheritRow, actions);
    return wrap;
  }
}
