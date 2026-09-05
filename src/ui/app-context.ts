/**
 * Application runtime context (K8a) — the contract every view builds against.
 *
 * The context wires together the unlocked store, the domain services
 * (catalog, units engine, import pipeline) and cross-cutting UI concerns
 * (navigation, locale, toasts, lock). Views receive an AppContext and never
 * reach for storage or crypto directly.
 */

import type {
  Catalog,
  CreateProfileOptions,
  StoreApi,
  UnitsEngine,
  ImportPipeline,
} from '../core/contracts';
import type { MeasurementId, ProfileData, ProfileId, ProfileSummary } from '../core/types';
import type { Locale, StringKey } from '../i18n/index';

/** The set of top-level screens; also the router's hash routes. */
export type Route =
  | 'overview'
  | 'timeline'
  | 'entry'
  | 'metric'
  | 'import'
  | 'import-csv'
  | 'import-filter'
  | 'export'
  | 'review'
  | 'restore'
  | 'restore-done'
  | 'report'
  | 'compare'
  | 'metrics-manage'
  | 'settings';

export interface RouteState {
  route: Route;
  /** Optional target, e.g. a metric id for the detail view. */
  param?: string;
}

export type ToastKind = 'info' | 'success' | 'error';

/** An optional actionable button shown inside a toast (e.g. "Add details"). */
export interface ToastAction {
  label: string;
  onClick: () => void;
}

/**
 * A view is a self-contained module: it renders into a container and returns
 * an optional teardown to release listeners/observers when navigation leaves.
 */
export interface View {
  render(container: HTMLElement, ctx: AppContext, route: RouteState): void | (() => void);
}

export interface AppContext {
  /** Unlocked store — getData()/mutate() operate on in-memory ProfileData. */
  store: StoreApi;
  /** Rebuilt whenever ProfileData.metrics changes (user metrics/aliases). */
  catalog(): Catalog;
  units: UnitsEngine;
  /** Import pipeline bound to the current profile's id/time/id-generator deps. */
  pipeline(): ImportPipeline;

  data(): ProfileData;
  /** Apply a mutation to ProfileData and schedule a persist; refreshes catalog. */
  mutate(fn: (data: ProfileData) => void): void;

  // -- Profiles ------------------------------------------------------------
  // One person keeping records for several people. The switcher only exists
  // once there is more than one profile; everything below is a no-op-ish
  // convenience over `store` that also rebuilds the catalog/units and takes the
  // user somewhere that exists in the profile they just opened.

  /** Every profile, newest-used first (the active one leads). */
  profiles(): ProfileSummary[];
  /** Whose data `data()` currently returns. */
  activeProfileId(): ProfileId;
  /**
   * Open another profile: flushes the current one, swaps the data, rebuilds
   * catalog + units, lands on the Overview and announces the change. A metric
   * detail open at the time may not exist in the new profile — hence Overview.
   */
  switchProfile(id: ProfileId): Promise<void>;
  /** Create a profile and switch to it (same consequences as a switch). */
  createProfile(options: CreateProfileOptions): Promise<void>;
  /** Rename a profile; the header switcher and any open list follow. */
  renameProfile(id: ProfileId, name: string): Promise<void>;
  /**
   * Delete a profile, irreversibly. Rejects for the active and the last one —
   * the store enforces both. Deleting the second-to-last one takes the app back
   * to its single-profile appearance, switcher and all.
   */
  deleteProfile(id: ProfileId): Promise<void>;

  locale: Locale;
  setLocale(locale: Locale): void;
  t(key: StringKey, params?: Record<string, string | number>): string;

  navigate(route: Route, param?: string): void;
  currentRoute(): RouteState;

  toast(message: string, kind?: ToastKind, action?: ToastAction): void;
  lock(): Promise<void>;

  /** Fresh id/time helpers for records created by views (composition boundary). */
  newMeasurementId(): MeasurementId;
  now(): string;
}
