/**
 * Profile store (K5b).
 *
 * Implements the load-into-memory storage model (design doc §4.1): after
 * unlock the ACTIVE profile's blob is decrypted, parsed and held in memory; all
 * reads operate on that in-memory state; writes serialize + seal + persist the
 * single blob (debounced, plus immediately on critical actions).
 *
 * Several profiles (design doc §4.3, `docs/ZADANI-VICE-PROFILU.md`): one person
 * keeping records for several people — a family — not several users sharing an
 * install. So the split is
 *
 *   data      → per profile (one sealed blob each, keyed by ProfileId)
 *   the key   → per DEVICE  (one key record, one passphrase)
 *
 * which is what lets a switch happen without ever returning to the lock screen.
 * A small sealed DIRECTORY record lists the profiles (name, colour, counts), so
 * drawing the switcher costs one small read instead of opening every blob —
 * and, because it is sealed too, an encrypted install does not leave the names
 * and sizes of its profiles lying in the clear next to the ciphertext.
 *
 * The concrete crypto is injected as a {@link CryptoProvider} (K5a) — this
 * module never touches WebCrypto directly, which keeps it independent of the
 * crypto implementation and trivially testable with an identity provider.
 */

import type {
  CreateProfileOptions,
  CryptoBox,
  CryptoProvider,
  InitOptions,
  KeyRecord,
  KvBackend,
  SchemaMigration,
  StoreApi,
  StoreStatus,
} from '../core/contracts';
import type { ProfileData, ProfileId, ProfileSummary } from '../core/types';
import { CURRENT_SCHEMA_VERSION, PROFILE_COLORS } from '../core/types';
import { WATCHED_TAG } from '../core/tags';

/**
 * The device's key record. The string is historical — it was the single
 * profile's key before profiles existed — and is deliberately left alone so an
 * existing install keeps unlocking with no crypto migration at all.
 */
const DEVICE_KEY = 'default';

/** The device's profile directory + which profile is active. */
const DEVICE_META = 'device';

/**
 * Where the pre-profiles release kept the one blob and its meta record. Read
 * once, on the first unlock after the update, then removed.
 */
const LEGACY_KEY = 'default';

/** Layout version of the device meta record (NOT ProfileData.schemaVersion). */
const META_LAYOUT = 1;

/** Debounce window for persisting mutations (design doc §4.1). */
const FLUSH_DEBOUNCE_MS = 500;

/**
 * The device meta record as persisted. Only `activeProfileId` (a UUID) and the
 * layout version are in the clear — everything that says something about the
 * person being tracked lives inside the sealed directory.
 */
interface DeviceMetaRecord {
  layout: number;
  activeProfileId: ProfileId;
  /** Sealed JSON of {@link ProfileSummary}[]. */
  directory: Uint8Array;
}

// ---------------------------------------------------------------------------
// Schema migrations
// ---------------------------------------------------------------------------

/**
 * Module-level registry of schema migrations, keyed by the version they
 * migrate *from* (a migration under key N turns a vN blob into vN+1).
 *
 * v1 is the current schema, so the production registry is empty — but the
 * runner code path below always exists and is exercised in tests by injecting
 * a synthetic v0 -> v1 migration through {@link createStore}'s options.
 */
const MIGRATIONS: ReadonlyMap<number, SchemaMigration> = new Map();

/**
 * Run every registered migration in order to bring `data` up to
 * {@link CURRENT_SCHEMA_VERSION}. Each step is a pure vN -> vN+1 function; the
 * runner enforces version progress so a migration cannot silently stall.
 */
function runMigrations(
  input: ProfileData,
  migrations: ReadonlyMap<number, SchemaMigration>,
): ProfileData {
  let data = input;
  if (data.schemaVersion > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Profile schema version ${data.schemaVersion} is newer than supported ${CURRENT_SCHEMA_VERSION}`,
    );
  }
  while (data.schemaVersion < CURRENT_SCHEMA_VERSION) {
    const from = data.schemaVersion;
    const migrate = migrations.get(from);
    if (!migrate) {
      throw new Error(`Missing schema migration from version ${from} to ${from + 1}`);
    }
    data = migrate(data);
    // Defensive: guarantee forward progress even if a migration forgot to bump.
    if (data.schemaVersion <= from) data.schemaVersion = from + 1;
  }
  return data;
}

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function serialize(data: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(data));
}

function deserialize(bytes: Uint8Array): ProfileData {
  return JSON.parse(decoder.decode(bytes)) as ProfileData;
}

function emptyProfileData(name: string, locale?: 'cs' | 'en'): ProfileData {
  const now = new Date().toISOString();
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    profile: {
      id: globalThis.crypto.randomUUID() as ProfileId,
      name,
      createdAt: now,
    },
    metrics: [],
    sources: [],
    measurements: [],
    settings: locale ? { locale } : {},
  };
}

/** The counts the switcher shows, recomputed from the data being written. */
function countsOf(data: ProfileData): Pick<
  ProfileSummary,
  'measurementCount' | 'firstMeasuredAt' | 'lastMeasuredAt'
> {
  let first: string | undefined;
  let last: string | undefined;
  for (const m of data.measurements) {
    if (first === undefined || m.takenAt < first) first = m.takenAt;
    if (last === undefined || m.takenAt > last) last = m.takenAt;
  }
  return {
    measurementCount: data.measurements.length,
    ...(first !== undefined ? { firstMeasuredAt: first } : {}),
    ...(last !== undefined ? { lastMeasuredAt: last } : {}),
  };
}

/** A directory row for a profile that has just been created or migrated in. */
function summaryOf(data: ProfileData, color: string, lastUsedAt: string): ProfileSummary {
  return {
    id: data.profile.id,
    name: data.profile.name,
    createdAt: data.profile.createdAt,
    color,
    lastUsedAt,
    ...countsOf(data),
  };
}

/**
 * What a new profile takes over from an existing one.
 *
 * The dividing line is: **the setup carries over, the findings and the opinions
 * never do.** Setting up a second person means "measure them the same way", not
 * "assume the same things about them".
 *
 *   metrics          ✓ definitions, learned lab aliases, panels — but with the
 *                      WATCHED star stripped: following someone's thyroid says
 *                      nothing about the next person, and inheriting the star
 *                      quietly puts another person's concerns on their overview
 *   units            ✓ custom unit definitions
 *   disabledMetrics  ✓ which built-ins are switched off (which panels I track)
 *   importMappings   ✓ a parser written for my lab's format
 *   settings         ✓ preferences (units system, tags, layouts) — except
 *                      `reportMetricIds`, a hand-picked list of THIS person's
 *                      metrics that would silently keep the new profile's own
 *                      imports out of its printed summary
 *   sources          ✗ recreated by the first import anyway
 *   measurements     ✗ obviously
 *   imports          ✗ the other person's import history
 *
 * `locale` / `theme` are dropped as well: they belong to the device now (see
 * `ui/device-prefs.ts`) and only linger in profiles written by older builds.
 */
function inheritInto(fresh: ProfileData, parent: ProfileData): void {
  fresh.metrics = structuredClone(parent.metrics).map((metric) => ({
    ...metric,
    ...(metric.tags ? { tags: metric.tags.filter((tag) => tag !== WATCHED_TAG) } : {}),
  }));
  if (parent.units) fresh.units = structuredClone(parent.units);
  if (parent.disabledMetrics) fresh.disabledMetrics = structuredClone(parent.disabledMetrics);
  if (parent.importMappings) fresh.importMappings = structuredClone(parent.importMappings);

  const settings = structuredClone(parent.settings);
  delete settings.reportMetricIds;
  delete settings.locale;
  delete settings.theme;
  fresh.settings = settings;
}

// ---------------------------------------------------------------------------
// Store factory
// ---------------------------------------------------------------------------

export interface CreateStoreOptions {
  /**
   * Override the schema-migration registry. Intended for tests that need to
   * exercise the migration runner with a synthetic migration; production code
   * relies on the module-level default.
   */
  migrations?: ReadonlyMap<number, SchemaMigration>;
  /**
   * The Vitametr build writing the data (e.g. '0.1.0'). Stamped into
   * ProfileData.appVersion on every write for diagnostics — it never drives
   * behavior. Defaults to 'unknown'.
   */
  appVersion?: string;
}

/**
 * Create a {@link StoreApi} over a {@link KvBackend} and an injected
 * {@link CryptoProvider}. The returned store owns all in-memory session state
 * (the data key box, the profile directory and the active profile's data).
 */
export function createStore(
  backend: KvBackend,
  crypto: CryptoProvider,
  options: CreateStoreOptions = {},
): StoreApi {
  const migrations = options.migrations ?? MIGRATIONS;
  const appVersion = options.appVersion ?? 'unknown';

  // In-memory session state; all present iff the store is unlocked.
  let box: CryptoBox | undefined;
  let data: ProfileData | undefined;
  let directory: ProfileSummary[] | undefined;
  let activeId: ProfileId | undefined;

  // Debounced-flush bookkeeping.
  let flushTimer: ReturnType<typeof setTimeout> | undefined;

  function clearFlushTimer(): void {
    if (flushTimer !== undefined) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
  }

  function requireUnlocked(): {
    box: CryptoBox;
    data: ProfileData;
    directory: ProfileSummary[];
    activeId: ProfileId;
  } {
    if (!box || !data || !directory || activeId === undefined) {
      throw new Error('Store is locked');
    }
    return { box, data, directory, activeId };
  }

  /** Seal and store one profile's data under its own id. */
  async function persistBlob(
    activeBox: CryptoBox,
    id: ProfileId,
    current: ProfileData,
  ): Promise<void> {
    // Stamp the writer build (diagnostics only) on every write.
    current.appVersion = appVersion;
    const sealed = await activeBox.seal(serialize(current));
    await backend.put('blobs', id, sealed);
  }

  /** Write the device record: active profile in the clear, directory sealed. */
  async function persistMeta(
    activeBox: CryptoBox,
    active: ProfileId,
    entries: readonly ProfileSummary[],
  ): Promise<void> {
    const record: DeviceMetaRecord = {
      layout: META_LAYOUT,
      activeProfileId: active,
      directory: await activeBox.seal(serialize(entries)),
    };
    await backend.put('meta', DEVICE_META, record);
  }

  /** Persist the active profile AND the directory row that describes it. */
  async function persistActive(): Promise<void> {
    if (!box || !data || !directory || activeId === undefined) return;
    await persistBlob(box, activeId, data);
    const row = directory.find((p) => p.id === activeId);
    if (row) Object.assign(row, countsOf(data), { name: data.profile.name });
    await persistMeta(box, activeId, directory);
  }

  async function readKeyRecord(): Promise<KeyRecord | undefined> {
    return (await backend.get('keys', DEVICE_KEY)) as KeyRecord | undefined;
  }

  async function readDeviceMeta(): Promise<DeviceMetaRecord | undefined> {
    return (await backend.get('meta', DEVICE_META)) as DeviceMetaRecord | undefined;
  }

  /** Open a profile's blob and bring it up to the current schema. */
  async function loadProfile(activeBox: CryptoBox, id: ProfileId): Promise<ProfileData> {
    const sealed = (await backend.get('blobs', id)) as Uint8Array | undefined;
    if (!sealed) throw new Error(`Profile blob is missing: ${id}`);
    return runMigrations(deserialize(await activeBox.open(sealed)), migrations);
  }

  /**
   * First unlock after the update from a single-profile install: adopt the one
   * existing blob as the first profile.
   *
   * The blob's BYTES are moved, never re-sealed — the contents are the user's
   * data and this step has no business rewriting them. It runs only once the
   * passphrase has already opened the blob, so a wrong passphrase leaves the
   * old layout untouched, and it is re-entrant: a crash between the two writes
   * leaves the legacy record in place and the next unlock repeats the move.
   */
  async function migrateLegacy(activeBox: CryptoBox): Promise<ProfileData> {
    const sealed = (await backend.get('blobs', LEGACY_KEY)) as Uint8Array | undefined;
    if (!sealed) throw new Error('Profile blob is missing');
    const migrated = runMigrations(deserialize(await activeBox.open(sealed)), migrations);
    const id = migrated.profile.id;

    await backend.put('blobs', id, sealed);
    const entries = [summaryOf(migrated, PROFILE_COLORS[0], new Date().toISOString())];
    await persistMeta(activeBox, id, entries);

    // Only now is the old layout redundant. A failure here is harmless: the
    // next unlock finds the device record and never looks at these again.
    await backend.delete('blobs', LEGACY_KEY);
    await backend.delete('meta', LEGACY_KEY);

    directory = entries;
    activeId = id;
    return migrated;
  }

  const store: StoreApi = {
    async status(): Promise<StoreStatus> {
      const record = await readKeyRecord();
      if (!record) return 'uninitialized';
      return box && data ? 'unlocked' : 'locked';
    },

    async mode(): Promise<'encrypted' | 'plaintext'> {
      const record = await readKeyRecord();
      if (!record) throw new Error('Store is not initialized');
      return record.mode;
    },

    async init(initOptions: InitOptions): Promise<ProfileData> {
      if (await readKeyRecord()) {
        throw new Error('Store is already initialized');
      }

      const created =
        initOptions.passphrase !== undefined
          ? await crypto.createEncrypted(initOptions.passphrase)
          : crypto.createPlaintext();

      const fresh = emptyProfileData(initOptions.profileName, initOptions.locale);
      const entries = [summaryOf(fresh, PROFILE_COLORS[0], new Date().toISOString())];

      await persistBlob(created.box, fresh.profile.id, fresh);
      await backend.put('keys', DEVICE_KEY, created.keyRecord);
      await persistMeta(created.box, fresh.profile.id, entries);

      box = created.box;
      data = fresh;
      directory = entries;
      activeId = fresh.profile.id;
      return fresh;
    },

    async unlock(passphrase?: string): Promise<ProfileData> {
      const record = await readKeyRecord();
      if (!record) throw new Error('Store is not initialized');

      const activeBox =
        record.mode === 'encrypted'
          ? await crypto.unlockEncrypted(passphrase ?? '', record)
          : crypto.unlockPlaintext(record);

      const meta = await readDeviceMeta();
      if (!meta) {
        // Pre-profiles install: adopt its blob as the first profile.
        const migrated = await migrateLegacy(activeBox);
        box = activeBox;
        data = migrated;
        return migrated;
      }

      const entries = JSON.parse(
        decoder.decode(await activeBox.open(meta.directory)),
      ) as ProfileSummary[];
      const opened = await loadProfile(activeBox, meta.activeProfileId);

      box = activeBox;
      data = opened;
      directory = entries;
      activeId = meta.activeProfileId;
      return opened;
    },

    getData(): ProfileData {
      if (!data) throw new Error('Store is locked');
      return data;
    },

    mutate(fn: (data: ProfileData) => void): void {
      if (!data) throw new Error('Store is locked');
      fn(data);
      // Debounce: reset the window on every mutation so a burst persists once.
      clearFlushTimer();
      flushTimer = setTimeout(() => {
        flushTimer = undefined;
        // Fire-and-forget; explicit flush()/lock() surface persistence errors.
        void store.flush().catch(() => {});
      }, FLUSH_DEBOUNCE_MS);
    },

    async flush(): Promise<void> {
      clearFlushTimer();
      if (!box || !data) return;
      await persistActive();
    },

    async lock(): Promise<void> {
      await store.flush();
      box = undefined;
      data = undefined;
      directory = undefined;
      activeId = undefined;
    },

    // -- Profiles ------------------------------------------------------------

    listProfiles(): ProfileSummary[] {
      const session = requireUnlocked();
      // The open profile's row is derived from what is in MEMORY, not from what
      // last reached the disk: a debounced write must not make the switcher say
      // "0 readings" about the value just entered.
      const rows = session.directory.map((p) =>
        p.id === session.activeId
          ? { ...p, name: session.data.profile.name, ...countsOf(session.data) }
          : p,
      );
      // Most recently used first, and the active profile always leads.
      return rows.sort((a, b) => {
        if (a.id === session.activeId) return -1;
        if (b.id === session.activeId) return 1;
        return b.lastUsedAt.localeCompare(a.lastUsedAt);
      });
    },

    activeProfileId(): ProfileId {
      return requireUnlocked().activeId;
    },

    async createProfile(profileOptions: CreateProfileOptions): Promise<ProfileData> {
      const session = requireUnlocked();
      // Whatever is pending belongs to the profile we are leaving.
      await store.flush();

      const fresh = emptyProfileData(profileOptions.name);
      if (profileOptions.inheritFrom !== undefined) {
        const parent =
          profileOptions.inheritFrom === session.activeId
            ? session.data
            : await loadProfile(session.box, profileOptions.inheritFrom);
        inheritInto(fresh, parent);
      }

      const color = PROFILE_COLORS[session.directory.length % PROFILE_COLORS.length];
      const entries = [...session.directory, summaryOf(fresh, color, new Date().toISOString())];

      await persistBlob(session.box, fresh.profile.id, fresh);
      await persistMeta(session.box, fresh.profile.id, entries);

      data = fresh;
      directory = entries;
      activeId = fresh.profile.id;
      return fresh;
    },

    async switchProfile(id: ProfileId): Promise<ProfileData> {
      const session = requireUnlocked();
      if (id === session.activeId) return session.data;
      if (!session.directory.some((p) => p.id === id)) {
        throw new Error(`Unknown profile: ${id}`);
      }
      // The debounced write belongs to the profile being left — never to the
      // one being opened. This has to happen before `data` is swapped.
      await store.flush();

      const opened = await loadProfile(session.box, id);
      const entries = session.directory.map((p) =>
        p.id === id ? { ...p, lastUsedAt: new Date().toISOString() } : p,
      );
      await persistMeta(session.box, id, entries);

      data = opened;
      directory = entries;
      activeId = id;
      return opened;
    },

    async readProfile(id: ProfileId): Promise<ProfileData> {
      const session = requireUnlocked();
      if (id === session.activeId) return session.data;
      if (!session.directory.some((p) => p.id === id)) {
        throw new Error(`Unknown profile: ${id}`);
      }
      return loadProfile(session.box, id);
    },

    async renameProfile(id: ProfileId, name: string): Promise<void> {
      const session = requireUnlocked();
      if (!session.directory.some((p) => p.id === id)) {
        throw new Error(`Unknown profile: ${id}`);
      }
      // The name lives in two places (the blob owns it, the directory shows
      // it); both are written here so they cannot drift apart.
      if (id === session.activeId) {
        session.data.profile.name = name;
        await persistActive();
        return;
      }
      const other = await loadProfile(session.box, id);
      other.profile.name = name;
      await persistBlob(session.box, id, other);
      const entries = session.directory.map((p) => (p.id === id ? { ...p, name } : p));
      await persistMeta(session.box, session.activeId, entries);
      directory = entries;
    },

    async deleteProfile(id: ProfileId): Promise<void> {
      const session = requireUnlocked();
      // "Last" is checked first on purpose: with a single profile it is also the
      // active one, and "switch to another one first" would be impossible advice.
      if (session.directory.length <= 1) {
        throw new Error('The last profile cannot be deleted — use "delete all data" instead');
      }
      if (id === session.activeId) {
        throw new Error('The active profile cannot be deleted — switch to another one first');
      }
      const entries = session.directory.filter((p) => p.id !== id);
      await backend.delete('blobs', id);
      await persistMeta(session.box, session.activeId, entries);
      directory = entries;
    },

    // -- Encryption ----------------------------------------------------------

    async changePassphrase(oldPassphrase: string, newPassphrase: string): Promise<void> {
      const record = await readKeyRecord();
      if (!record) throw new Error('Store is not initialized');
      const nextRecord = await crypto.changePassphrase(oldPassphrase, newPassphrase, record);
      await backend.put('keys', DEVICE_KEY, nextRecord);
      // The data key (DEK) is unchanged, so every profile's blob stays valid.
    },

    async enableEncryption(passphrase: string): Promise<void> {
      const session = requireUnlocked();

      const upgraded = await crypto.upgradeToEncrypted(passphrase);
      // Re-seal EVERY profile under the new box, not just the open one —
      // otherwise the others would stay readable with the old (identity) key.
      for (const profile of session.directory) {
        const current =
          profile.id === session.activeId
            ? session.data
            : await loadProfile(session.box, profile.id);
        await persistBlob(upgraded.box, profile.id, current);
      }
      await backend.put('keys', DEVICE_KEY, upgraded.keyRecord);
      await persistMeta(upgraded.box, session.activeId, session.directory);
      box = upgraded.box;
    },

    async disableEncryption(currentPassphrase: string): Promise<void> {
      const session = requireUnlocked();
      const record = await readKeyRecord();
      if (!record) throw new Error('Store is not initialized');
      if (record.mode !== 'encrypted') return; // already plaintext — no-op
      // Verify the current passphrase before stripping protection.
      await crypto.unlockEncrypted(currentPassphrase, record);

      const plain = crypto.createPlaintext();
      for (const profile of session.directory) {
        const current =
          profile.id === session.activeId
            ? session.data
            : await loadProfile(session.box, profile.id);
        await persistBlob(plain.box, profile.id, current);
      }
      await backend.put('keys', DEVICE_KEY, plain.keyRecord);
      await persistMeta(plain.box, session.activeId, session.directory);
      box = plain.box;
    },

    async verifyPassphrase(passphrase: string): Promise<boolean> {
      const record = await readKeyRecord();
      if (!record) throw new Error('Store is not initialized');
      if (record.mode !== 'encrypted') return true; // plaintext — no passphrase to verify
      try {
        await crypto.unlockEncrypted(passphrase, record);
        return true;
      } catch {
        return false;
      }
    },

    async wipe(): Promise<void> {
      clearFlushTimer();
      await backend.clear();
      box = undefined;
      data = undefined;
      directory = undefined;
      activeId = undefined;
    },
  };

  return store;
}
