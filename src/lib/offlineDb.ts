import type {DataPreferences, StorageStats, VideoItem} from '../types/video';

export const DEFAULT_DATA_PREFERENCES: DataPreferences = {
  autoCacheThumbnails: true,
  autoHarvestSuggested: true,
  saveWatchProgress: true,
  cacheChaptersAndNotesMeta: true,
};

const DB_NAME = 'tubevault-offline-db';
const DB_VERSION = 1;

const STORE_VIDEOS = 'videos';
const STORE_THUMBS = 'thumbnails';
const STORE_SETTINGS = 'settings';

const LS_VIDEOS_KEY = 'tubevault_videos_v1';
const LS_SETTINGS_KEY = 'tubevault_settings_v1';

interface ThumbnailRecord {
  videoId: string;
  blob: Blob;
  updatedAt: number;
}

interface SettingRecord {
  key: string;
  value: unknown;
}

let dbPromise: Promise<IDBDatabase> | null = null;
let persistRequested = false;

// Fast in-memory video mirror to avoid blocking JSON.parse / JSON.stringify on every 4s progress tick
let memoryVideosCache: VideoItem[] | null = null;
let lsWriteTimer: ReturnType<typeof setTimeout> | null = null;

export function requestPersistentStorage(): void {
  if (persistRequested || typeof navigator === 'undefined') return;
  persistRequested = true;
  try {
    if (navigator.storage?.persist) {
      navigator.storage.persist().catch(() => {
        // Ignore permission denial on platforms that manage storage automatically
      });
    }
  } catch {
    // Ignore
  }
}

function readLocalStorageJson<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined' || !window.localStorage) return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeVideosToLocalStorageImmediate(items: VideoItem[]): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  const sorted = [...items].sort((a, b) => b.addedAt - a.addedAt);
  try {
    window.localStorage.setItem(LS_VIDEOS_KEY, JSON.stringify(sorted));
  } catch {
    try {
      const compact = sorted.map((v) => ({
        ...v,
        description: v.description ? v.description.slice(0, 240) : '',
      }));
      window.localStorage.setItem(LS_VIDEOS_KEY, JSON.stringify(compact));
    } catch {
      try {
        const sliced = sorted.slice(0, 350).map((v) => ({
          ...v,
          description: '',
        }));
        window.localStorage.setItem(LS_VIDEOS_KEY, JSON.stringify(sliced));
      } catch {
        // Quota exhausted cleanly; IndexedDB still holds full data
      }
    }
  }
}

function scheduleLocalStorageSync(items: VideoItem[], immediate = false): void {
  memoryVideosCache = [...items].sort((a, b) => b.addedAt - a.addedAt);
  if (immediate) {
    if (lsWriteTimer) {
      clearTimeout(lsWriteTimer);
      lsWriteTimer = null;
    }
    writeVideosToLocalStorageImmediate(memoryVideosCache);
    return;
  }
  if (lsWriteTimer) clearTimeout(lsWriteTimer);
  lsWriteTimer = setTimeout(() => {
    lsWriteTimer = null;
    if (memoryVideosCache) {
      writeVideosToLocalStorageImmediate(memoryVideosCache);
    }
  }, 350);
}

function readSettingsFromLocalStorage(): Record<string, unknown> {
  const parsed = readLocalStorageJson<Record<string, unknown>>(LS_SETTINGS_KEY, {});
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

function writeSettingToLocalStorage(key: string, value: unknown): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    const current = readSettingsFromLocalStorage();
    current[key] = value;
    window.localStorage.setItem(LS_SETTINGS_KEY, JSON.stringify(current));
  } catch {
    // Ignore localStorage quota failure
  }
}

export function getCachedVideosSync(): VideoItem[] {
  if (memoryVideosCache !== null) {
    return memoryVideosCache;
  }
  const cached = readLocalStorageJson<Array<VideoItem & {sourceType?: string}>>(LS_VIDEOS_KEY, []);
  if (!Array.isArray(cached)) {
    memoryVideosCache = [];
    return [];
  }
  memoryVideosCache = cached
    .filter(
      (v) =>
        v &&
        typeof v.id === 'string' &&
        typeof v.videoId === 'string' &&
        (!v.sourceType || v.sourceType === 'youtube')
    )
    .sort((a, b) => b.addedAt - a.addedAt);
  return memoryVideosCache;
}

export function getCachedSettingSync<T>(key: string, fallback: T): T {
  const settings = readSettingsFromLocalStorage();
  if (Object.prototype.hasOwnProperty.call(settings, key)) {
    return settings[key] as T;
  }
  return fallback;
}

export function getDataPreferencesSync(): DataPreferences {
  const stored = getCachedSettingSync<Partial<DataPreferences>>('dataPreferences', {});
  const autoHarvestLegacy = getCachedSettingSync<boolean>(
    'autoHarvestToHome',
    DEFAULT_DATA_PREFERENCES.autoHarvestSuggested
  );
  return {
    autoCacheThumbnails:
      typeof stored.autoCacheThumbnails === 'boolean'
        ? stored.autoCacheThumbnails
        : DEFAULT_DATA_PREFERENCES.autoCacheThumbnails,
    autoHarvestSuggested:
      typeof stored.autoHarvestSuggested === 'boolean'
        ? stored.autoHarvestSuggested
        : autoHarvestLegacy,
    saveWatchProgress:
      typeof stored.saveWatchProgress === 'boolean'
        ? stored.saveWatchProgress
        : DEFAULT_DATA_PREFERENCES.saveWatchProgress,
    cacheChaptersAndNotesMeta:
      typeof stored.cacheChaptersAndNotesMeta === 'boolean'
        ? stored.cacheChaptersAndNotesMeta
        : DEFAULT_DATA_PREFERENCES.cacheChaptersAndNotesMeta,
  };
}

export async function getDataPreferences(): Promise<DataPreferences> {
  const stored = await getSetting<Partial<DataPreferences>>('dataPreferences', {});
  const autoHarvestLegacy = await getSetting<boolean>(
    'autoHarvestToHome',
    DEFAULT_DATA_PREFERENCES.autoHarvestSuggested
  );
  const merged: DataPreferences = {
    autoCacheThumbnails:
      typeof stored.autoCacheThumbnails === 'boolean'
        ? stored.autoCacheThumbnails
        : DEFAULT_DATA_PREFERENCES.autoCacheThumbnails,
    autoHarvestSuggested:
      typeof stored.autoHarvestSuggested === 'boolean'
        ? stored.autoHarvestSuggested
        : autoHarvestLegacy,
    saveWatchProgress:
      typeof stored.saveWatchProgress === 'boolean'
        ? stored.saveWatchProgress
        : DEFAULT_DATA_PREFERENCES.saveWatchProgress,
    cacheChaptersAndNotesMeta:
      typeof stored.cacheChaptersAndNotesMeta === 'boolean'
        ? stored.cacheChaptersAndNotesMeta
        : DEFAULT_DATA_PREFERENCES.cacheChaptersAndNotesMeta,
  };
  writeSettingToLocalStorage('dataPreferences', merged);
  return merged;
}

export async function saveDataPreferences(
  patch: Partial<DataPreferences>
): Promise<DataPreferences> {
  const current = getDataPreferencesSync();
  const next: DataPreferences = {...current, ...patch};
  await setSetting('dataPreferences', next);
  if (typeof patch.autoHarvestSuggested === 'boolean') {
    await setSetting('autoHarvestToHome', patch.autoHarvestSuggested);
  }
  return next;
}

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }

    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_VIDEOS)) {
        db.createObjectStore(STORE_VIDEOS, {keyPath: 'id'});
      }
      if (!db.objectStoreNames.contains(STORE_THUMBS)) {
        db.createObjectStore(STORE_THUMBS, {keyPath: 'videoId'});
      }
      if (!db.objectStoreNames.contains('mediaBlobs')) {
        db.createObjectStore('mediaBlobs', {keyPath: 'videoId'});
      }
      if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
        db.createObjectStore(STORE_SETTINGS, {keyPath: 'key'});
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });

  return dbPromise;
}

function runTx<T>(
  storeName: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const store = tx.objectStore(storeName);
        const request = fn(store);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      })
  );
}

export async function getAllVideos(): Promise<VideoItem[]> {
  try {
    const items = await runTx<Array<VideoItem & {sourceType?: string}>>(
      STORE_VIDEOS,
      'readonly',
      (s) => s.getAll()
    );
    const valid = items
      .filter((v) => !v.sourceType || v.sourceType === 'youtube')
      .sort((a, b) => b.addedAt - a.addedAt);

    if (valid.length > 0) {
      scheduleLocalStorageSync(valid, true);
      return valid;
    }

    const lsFallback = getCachedVideosSync();
    if (lsFallback.length > 0) {
      saveVideosBulk(lsFallback).catch(() => {});
      return lsFallback;
    }

    return [];
  } catch {
    return getCachedVideosSync();
  }
}

export async function saveVideo(item: VideoItem): Promise<void> {
  const current = getCachedVideosSync();
  const idx = current.findIndex((v) => v.id === item.id);
  const next = idx >= 0 ? current.map((v) => (v.id === item.id ? item : v)) : [item, ...current];
  scheduleLocalStorageSync(next, false);

  try {
    await runTx(STORE_VIDEOS, 'readwrite', (s) => s.put(item));
  } catch {
    // Memory + localStorage mirror handles fallback
  }
}

export async function saveVideosBulk(items: VideoItem[]): Promise<void> {
  if (items.length === 0) return;

  const byId = new Map<string, VideoItem>();
  for (const existing of getCachedVideosSync()) {
    byId.set(existing.id, existing);
  }
  for (const incoming of items) {
    byId.set(incoming.id, incoming);
  }
  scheduleLocalStorageSync(Array.from(byId.values()), true);

  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_VIDEOS, 'readwrite');
      const store = tx.objectStore(STORE_VIDEOS);
      for (const item of items) {
        store.put(item);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // localStorage mirror succeeded
  }
}

export async function deleteVideoRecord(id: string, videoId: string): Promise<void> {
  const remaining = getCachedVideosSync().filter((v) => v.id !== id);
  scheduleLocalStorageSync(remaining, true);
  const stillReferenced = remaining.some((v) => v.videoId === videoId);

  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE_VIDEOS, STORE_THUMBS], 'readwrite');
      tx.objectStore(STORE_VIDEOS).delete(id);
      if (!stillReferenced) {
        tx.objectStore(STORE_THUMBS).delete(videoId);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // localStorage mirror succeeded
  }
}

export async function deleteVideosBulk(
  records: Array<{id: string; videoId: string}>
): Promise<void> {
  if (records.length === 0) return;

  const idSet = new Set(records.map((r) => r.id));
  const remaining = getCachedVideosSync().filter((v) => !idSet.has(v.id));
  scheduleLocalStorageSync(remaining, true);

  const remainingYtIds = new Set(remaining.map((v) => v.videoId));

  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE_VIDEOS, STORE_THUMBS], 'readwrite');
      const vStore = tx.objectStore(STORE_VIDEOS);
      const tStore = tx.objectStore(STORE_THUMBS);
      for (const rec of records) {
        vStore.delete(rec.id);
        if (!remainingYtIds.has(rec.videoId)) {
          tStore.delete(rec.videoId);
        }
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // localStorage mirror succeeded
  }
}

export async function saveThumbnailBlob(videoId: string, blob: Blob): Promise<void> {
  try {
    const record: ThumbnailRecord = {videoId, blob, updatedAt: Date.now()};
    await runTx(STORE_THUMBS, 'readwrite', (s) => s.put(record));
  } catch {
    // Ignore IDB blob write error cleanly
  }
}

export async function getThumbnailBlob(videoId: string): Promise<Blob | null> {
  try {
    const rec = await runTx<ThumbnailRecord | undefined>(STORE_THUMBS, 'readonly', (s) =>
      s.get(videoId)
    );
    return rec?.blob ?? null;
  } catch {
    return null;
  }
}

export async function clearThumbnailCache(): Promise<void> {
  const cached = getCachedVideosSync().map((v) => ({...v, thumbCached: false}));
  scheduleLocalStorageSync(cached, true);

  try {
    const db = await openDb();
    const videos = await getAllVideos();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE_THUMBS, STORE_VIDEOS], 'readwrite');
      tx.objectStore(STORE_THUMBS).clear();
      const videoStore = tx.objectStore(STORE_VIDEOS);
      for (const v of videos) {
        videoStore.put({...v, thumbCached: false});
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Ignore
  }
}

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  try {
    const rec = await runTx<SettingRecord | undefined>(STORE_SETTINGS, 'readonly', (s) =>
      s.get(key)
    );
    if (rec) {
      writeSettingToLocalStorage(key, rec.value);
      return rec.value as T;
    }
    return getCachedSettingSync(key, fallback);
  } catch {
    return getCachedSettingSync(key, fallback);
  }
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  writeSettingToLocalStorage(key, value);
  try {
    await runTx(STORE_SETTINGS, 'readwrite', (s) => s.put({key, value}));
  } catch {
    // localStorage already updated
  }
}

export async function clearWatchHistory(): Promise<number> {
  const videos = await getAllVideos();
  const affected = videos.filter((v) => v.lastWatchedAt !== null || v.lastPositionSeconds > 0);
  if (affected.length === 0) return 0;

  const cleared = videos.map((v) => ({
    ...v,
    lastWatchedAt: null,
    lastPositionSeconds: 0,
  }));
  await saveVideosBulk(cleared);
  return affected.length;
}

export async function clearDescriptionsAndChapters(): Promise<number> {
  const videos = await getAllVideos();
  const affected = videos.filter(
    (v) => v.description.trim().length > 0 || (v.chapters && v.chapters.length > 0)
  );
  if (affected.length === 0) return 0;

  const trimmed = videos.map((v) => ({
    ...v,
    description: '',
    chapters: undefined,
  }));
  await saveVideosBulk(trimmed);
  return affected.length;
}

export async function clearBrowserCacheStorage(): Promise<void> {
  try {
    const db = await openDb();
    if (db.objectStoreNames.contains('mediaBlobs')) {
      await new Promise<void>((resolve) => {
        const tx = db.transaction('mediaBlobs', 'readwrite');
        tx.objectStore('mediaBlobs').clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      });
    }
  } catch {
    // Ignore
  }

  if (typeof window !== 'undefined' && 'caches' in window) {
    try {
      const names = await window.caches.keys();
      await Promise.all(names.map((name) => window.caches.delete(name)));
    } catch {
      // Ignore
    }
  }
}

function measureUtf8Bytes(input: unknown): number {
  const str = typeof input === 'string' ? input : JSON.stringify(input) || '';
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(str).byteLength;
  }
  return str.length * 2;
}

export async function getStorageStats(): Promise<StorageStats> {
  let videos: VideoItem[] = getCachedVideosSync();
  let thumbsCount = 0;
  let thumbnailsBytes = 0;
  let settingsBytes = 0;

  try {
    const [idbVideos, thumbs, settingsList] = await Promise.all([
      getAllVideos(),
      runTx<ThumbnailRecord[]>(STORE_THUMBS, 'readonly', (s) => s.getAll()),
      runTx<SettingRecord[]>(STORE_SETTINGS, 'readonly', (s) => s.getAll()),
    ]);
    if (idbVideos.length > 0) videos = idbVideos;
    thumbsCount = thumbs.length;
    thumbnailsBytes = thumbs.reduce((sum, rec) => sum + (rec.blob?.size || 0), 0);
    settingsBytes = measureUtf8Bytes(settingsList);
  } catch {
    thumbsCount = videos.filter((v) => v.thumbCached).length;
    settingsBytes = measureUtf8Bytes(readSettingsFromLocalStorage());
  }

  let metadataBytes = 0;
  let notesAndBookmarksBytes = 0;
  for (const v of videos) {
    const core = {
      id: v.id,
      videoId: v.videoId,
      originalUrl: v.originalUrl,
      title: v.title,
      authorName: v.authorName,
      authorUrl: v.authorUrl,
      durationSeconds: v.durationSeconds,
      collection: v.collection,
      addedAt: v.addedAt,
      lastWatchedAt: v.lastWatchedAt,
      lastPositionSeconds: v.lastPositionSeconds,
      playbackRate: v.playbackRate,
      thumbCached: v.thumbCached,
      liked: v.liked,
    };
    const rich = {
      description: v.description || '',
      bookmarks: v.bookmarks || [],
      chapters: v.chapters || [],
      notes: v.notes || '',
    };
    metadataBytes += measureUtf8Bytes(core);
    notesAndBookmarksBytes += measureUtf8Bytes(rich);
  }

  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      const lsSet = window.localStorage.getItem(LS_SETTINGS_KEY);
      if (lsSet) settingsBytes = Math.max(settingsBytes, measureUtf8Bytes(lsSet));
    } catch {
      // Ignore
    }
  }

  let quotaBytes: number | null = null;
  let usageBytes: number | null = null;
  if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
    try {
      const est = await navigator.storage.estimate();
      quotaBytes = est.quota ?? null;
      usageBytes = est.usage ?? null;
    } catch {
      // Ignore storage estimate unavailability
    }
  }

  const appDataBytes = thumbnailsBytes + metadataBytes + notesAndBookmarksBytes + settingsBytes;
  const otherBrowserBytes =
    usageBytes != null && usageBytes > appDataBytes ? usageBytes - appDataBytes : 0;
  const totalMeasuredBytes = appDataBytes + otherBrowserBytes;

  return {
    quotaBytes,
    usageBytes,
    videoCount: videos.length,
    cachedThumbsCount: thumbsCount,
    breakdown: {
      thumbnailsBytes,
      thumbnailsCount: thumbsCount,
      metadataBytes,
      notesAndBookmarksBytes,
      settingsBytes,
      otherBrowserBytes,
      totalMeasuredBytes,
    },
  };
}
