/**
 * The header profile switcher.
 *
 * It exists only from the second profile onwards — with one profile the app
 * must look exactly as it did before the feature (`docs/ZADANI-VICE-PROFILU.md`
 * §1), so the caller simply does not build this. A profile is CONTEXT, not a
 * destination: it lives in the header, never in the navigation.
 *
 * It SWITCHES, and does nothing else. The spec's "add profile" and "manage
 * profiles" entries were dropped (user's call, 4. 9. 2026): both only led to
 * Settings, where anyone looking to manage profiles goes anyway, and a menu
 * that both picks a context and navigates away asks the reader to sort two
 * unrelated kinds of action apart every time they switch.
 *
 * Keyboard and screen-reader behaviour follow the menu pattern: the button owns
 * `aria-haspopup`/`aria-expanded`, the list is a `menu` of `menuitemradio`
 * rows, arrows and Home/End move, Escape closes and returns focus to the
 * button. The coloured avatar is decoration — the name carries the identity, so
 * the avatar is `aria-hidden` and the mobile button (which shows no name) says
 * it in `aria-label` instead.
 */

import './profile-switcher.css';
import type { ProfileId, ProfileSummary } from '../../core/types';
import type { StringKey } from '../../i18n/index';
import { formatDateTime, plural } from '../../i18n/index';
import { profileInitial, profileMetaLine } from '../views/profile-model';
import { profileDisplayName } from '../views/settings-model';

type Translate = (key: StringKey, params?: Record<string, string | number>) => string;

/** "1 reading" / "3 readings" — Czech needs one/few/many, English one/other. */
export function readingCount(n: number): string {
  return plural(
    n,
    {
      one: 'profile.measurementsCount.one',
      few: 'profile.measurementsCount.few',
      many: 'profile.measurementsCount.many',
    },
    { n },
  );
}

export interface ProfileSwitcherOptions {
  profiles: readonly ProfileSummary[];
  activeId: ProfileId;
  t: Translate;
  onSelect(id: ProfileId): void;
}

/** A round colour chip with the name's initial. Decorative by design. */
export function profileAvatar(
  summary: Pick<ProfileSummary, 'name' | 'color'>,
  size: number,
  t: Translate,
): HTMLElement {
  const avatar = document.createElement('span');
  avatar.className = 'profile-avatar';
  avatar.setAttribute('aria-hidden', 'true');
  avatar.style.setProperty('--avatar-size', `${size}px`);
  avatar.style.background = summary.color;
  avatar.textContent = profileInitial(profileDisplayName(summary.name, t));
  return avatar;
}

export function profileSwitcher(options: ProfileSwitcherOptions): HTMLElement {
  const { profiles, activeId, t } = options;
  const active = profiles.find((p) => p.id === activeId) ?? profiles[0];
  const activeName = profileDisplayName(active.name, t);

  const wrap = document.createElement('div');
  wrap.className = 'profile-switcher';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'profile-switcher-btn';
  button.setAttribute('aria-haspopup', 'menu');
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-label', t('profile.switchLabel', { name: activeName }));
  const name = document.createElement('span');
  name.className = 'profile-switcher-name';
  name.textContent = activeName;
  const caret = document.createElement('span');
  caret.className = 'profile-switcher-caret';
  caret.setAttribute('aria-hidden', 'true');
  button.append(profileAvatar(active, 24, t), name, caret);

  const popover = document.createElement('div');
  popover.className = 'profile-menu';
  popover.hidden = true;

  let items: HTMLButtonElement[] = [];

  function close(focusButton = true): void {
    if (popover.hidden) return;
    popover.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutside, true);
    if (focusButton) button.focus();
  }

  function onOutside(event: Event): void {
    if (!wrap.contains(event.target as Node)) close(false);
  }

  function open(): void {
    if (!popover.hidden) return;
    build();
    popover.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', onOutside, true);
    items[0]?.focus();
  }

  function move(from: number, delta: number): void {
    if (items.length === 0) return;
    const next = (from + delta + items.length) % items.length;
    items[next].focus();
  }

  function build(): void {
    popover.replaceChildren();
    items = [];

    const heading = document.createElement('p');
    heading.className = 'profile-menu-heading';
    heading.id = 'profile-menu-heading';
    heading.textContent = t('profile.switch');
    popover.append(heading);

    const list = document.createElement('div');
    list.className = 'profile-menu-list';
    list.setAttribute('role', 'menu');
    list.setAttribute('aria-labelledby', heading.id);

    for (const profile of profiles) {
      const isActive = profile.id === activeId;
      const row = document.createElement('button');
      row.type = 'button';
      row.className = isActive ? 'profile-menu-item is-active' : 'profile-menu-item';
      row.setAttribute('role', 'menuitemradio');
      row.setAttribute('aria-checked', String(isActive));

      const text = document.createElement('span');
      text.className = 'profile-menu-text';
      const label = document.createElement('span');
      label.className = 'profile-menu-name';
      label.textContent = profileDisplayName(profile.name, t);
      const meta = document.createElement('span');
      meta.className = 'profile-menu-meta muted';
      meta.textContent = profileMetaLine(
        profile,
        t,
        (iso) => formatDateTime(iso, 'date'),
        readingCount,
      );
      text.append(label, meta);

      const check = document.createElement('span');
      check.className = 'profile-menu-check';
      check.setAttribute('aria-hidden', 'true');

      row.append(profileAvatar(profile, 30, t), text, check);
      row.addEventListener('click', () => {
        close(false);
        if (!isActive) options.onSelect(profile.id);
      });
      list.append(row);
      items.push(row);
    }
    popover.append(list);
  }

  button.addEventListener('click', () => (popover.hidden ? open() : close()));

  wrap.addEventListener('keydown', (event) => {
    const key = (event as KeyboardEvent).key;
    if (key === 'Escape' && !popover.hidden) {
      event.preventDefault();
      close();
      return;
    }
    if (popover.hidden) return;
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (key === 'ArrowDown') {
      event.preventDefault();
      move(index === -1 ? -1 : index, 1);
    } else if (key === 'ArrowUp') {
      event.preventDefault();
      move(index === -1 ? 0 : index, -1);
    } else if (key === 'Home') {
      event.preventDefault();
      items[0]?.focus();
    } else if (key === 'End') {
      event.preventDefault();
      items[items.length - 1]?.focus();
    }
  });

  wrap.append(button, popover);
  return wrap;
}
