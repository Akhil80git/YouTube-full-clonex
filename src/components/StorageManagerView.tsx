import React, {useMemo, useRef, useState} from 'react';
import {
  AlertTriangle,
  Bookmark,
  CheckCircle2,
  Clock,
  Compass,
  Database,
  Download,
  FileText,
  FolderEdit,
  HardDrive,
  Heart,
  Image as ImageIcon,
  Loader2,
  Moon,
  PieChart,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sun,
  Trash2,
  Upload,
} from 'lucide-react';
import {
  clearBrowserCacheStorage,
  clearDescriptionsAndChapters,
  clearThumbnailCache,
  clearWatchHistory,
  saveThumbnailBlob,
  saveVideosBulk,
} from '../lib/offlineDb';
import {formatBytes} from '../lib/youtube';
import type {DataPreferences, StorageStats, VideoChapter, VideoItem} from '../types/video';
import {CachedThumbnail, clearInMemoryThumbCache} from './CachedThumbnail';
import {PWAInstallButton} from './PWAInstallButton';

interface StorageManagerViewProps {
  stats: StorageStats;
  videos: VideoItem[];
  isOnline: boolean;
  darkMode: boolean;
  dataPrefs: DataPreferences;
  autoSuggestionsCount: number;
  autoSuggestionsLoading: boolean;
  externalSearchQuery?: string;
  onUpdateDataPrefs: (patch: Partial<DataPreferences>) => Promise<void> | void;
  onToggleTheme: () => void;
  onOpenSuggestions: () => void;
  onOpenAddHub?: () => void;
  onToggleLike: (video: VideoItem) => void;
  onSelectVideo: (id: string) => void;
  onDeleteSingleVideo: (video: VideoItem) => Promise<void> | void;
  onBulkDeleteVideos: (includeLiked: boolean) => Promise<number>;
  onRefreshLibrary: () => Promise<void>;
  onStatsChange: () => void;
}

export const StorageManagerView: React.FC<StorageManagerViewProps> = ({
  stats,
  videos,
  isOnline,
  darkMode,
  dataPrefs,
  autoSuggestionsCount,
  autoSuggestionsLoading,
  externalSearchQuery = '',
  onUpdateDataPrefs,
  onToggleTheme,
  onOpenSuggestions,
  onOpenAddHub,
  onToggleLike,
  onSelectVideo,
  onDeleteSingleVideo,
  onBulkDeleteVideos,
  onRefreshLibrary,
  onStatsChange,
}) => {
  const importRef = useRef<HTMLInputElement | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [editingCollection, setEditingCollection] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [confirmMode, setConfirmMode] = useState<'none' | 'unliked' | 'all'>('none');
  const [deletingBulk, setDeletingBulk] = useState(false);
  const [libSearch, setLibSearch] = useState('');
  const [libFilter, setLibFilter] = useState<'all' | 'liked' | 'unliked'>('all');
  const [confirmSingleLikedId, setConfirmSingleLikedId] = useState<string | null>(null);

  const likedCount = useMemo(() => videos.filter((v) => v.liked).length, [videos]);
  const unlikedCount = videos.length - likedCount;

  const totalBookmarks = useMemo(
    () => videos.reduce((acc, v) => acc + v.bookmarks.length, 0),
    [videos]
  );

  const totalNotesCount = useMemo(
    () => videos.filter((v) => v.notes.trim().length > 0).length,
    [videos]
  );

  const collectionBreakdown = useMemo(() => {
    const map = new Map<string, number>();
    for (const v of videos) {
      const col = v.collection || 'Watch Later';
      map.set(col, (map.get(col) || 0) + 1);
    }
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
  }, [videos]);

  const effectiveQuery = (externalSearchQuery || libSearch).trim().toLowerCase();

  const filteredVideos = useMemo(() => {
    return videos.filter((v) => {
      if (libFilter === 'liked' && !v.liked) return false;
      if (libFilter === 'unliked' && v.liked) return false;
      if (effectiveQuery) {
        const hay = `${v.title} ${v.authorName} ${v.collection} ${v.originalUrl}`.toLowerCase();
        if (!hay.includes(effectiveQuery)) return false;
      }
      return true;
    });
  }, [videos, libFilter, effectiveQuery]);

  async function handleBulkDeleteConfirm(includeLiked: boolean) {
    setDeletingBulk(true);
    setMessage(null);
    try {
      const removed = await onBulkDeleteVideos(includeLiked);
      setConfirmMode('none');
      if (includeLiked) {
        setMessage(`Removed all ${removed} videos & URLs from your library.`);
      } else {
        setMessage(
          `Removed ${removed} unliked videos. ${likedCount} liked video${likedCount === 1 ? '' : 's'} kept safe!`
        );
      }
    } finally {
      setDeletingBulk(false);
    }
  }

  async function handleSyncPending() {
    if (!isOnline || syncing) return;
    setSyncing(true);
    setMessage(null);
    let syncedCount = 0;

    const updated: VideoItem[] = [];
    for (const v of videos) {
      let next = {...v};
      const needsMeta =
        v.title.startsWith('YouTube Video (') ||
        v.authorName.includes('Pending Sync') ||
        v.chapters === undefined;

      if (dataPrefs.cacheChaptersAndNotesMeta && needsMeta) {
        try {
          const resp = await fetch(
            `/api/youtube/metadata?videoId=${encodeURIComponent(v.videoId)}`
          );
          if (resp.ok) {
            const meta = (await resp.json()) as {
              title?: string;
              authorName?: string;
              authorUrl?: string;
              description?: string;
              durationSeconds?: number | null;
              chapters?: VideoChapter[];
            };
            next = {
              ...next,
              title: v.title.startsWith('YouTube Video (') && meta.title ? meta.title : next.title,
              authorName:
                v.authorName.includes('Pending Sync') && meta.authorName
                  ? meta.authorName
                  : next.authorName,
              authorUrl: meta.authorUrl || next.authorUrl,
              description: meta.description || next.description,
              durationSeconds: meta.durationSeconds ?? next.durationSeconds,
              chapters: Array.isArray(meta.chapters) ? meta.chapters : next.chapters ?? [],
            };
            syncedCount++;
          }
        } catch {
          // Ignore individual failures
        }
      }

      if (dataPrefs.autoCacheThumbnails && !v.thumbCached) {
        try {
          const tResp = await fetch(
            `/api/youtube/thumbnail?videoId=${encodeURIComponent(v.videoId)}`
          );
          if (tResp.ok) {
            const blob = await tResp.blob();
            await saveThumbnailBlob(v.videoId, blob);
            next.thumbCached = true;
            syncedCount++;
          }
        } catch {
          // Ignore
        }
      }
      updated.push(next);
    }

    await saveVideosBulk(updated);
    await onRefreshLibrary();
    onStatsChange();
    setSyncing(false);
    setMessage(
      `Synced ${syncedCount} records based on your active Data Controls.${
        !dataPrefs.autoCacheThumbnails ? ' (Thumbnail caching is currently Off.)' : ''
      }`
    );
  }

  async function handleClearThumbs() {
    await clearThumbnailCache();
    clearInMemoryThumbCache();
    await onRefreshLibrary();
    onStatsChange();
    setMessage('Cleared all cached thumbnails. Links, liked videos, chapters, bookmarks, and notes remain safe.');
  }

  async function handleClearWatchHistory() {
    const count = await clearWatchHistory();
    await onRefreshLibrary();
    onStatsChange();
    setMessage(
      count > 0
        ? `Cleared watch progress & history across ${count} videos.`
        : 'Watch history is already clean.'
    );
  }

  async function handleClearDescriptionsAndChapters() {
    const count = await clearDescriptionsAndChapters();
    await onRefreshLibrary();
    onStatsChange();
    setMessage(
      count > 0
        ? `Cleared heavy descriptions & chapters on ${count} videos (your notes, bookmarks & links stay safe).`
        : 'No cached descriptions or chapters to clear.'
    );
  }

  async function handleClearBrowserCache() {
    await clearBrowserCacheStorage();
    onStatsChange();
    setMessage('Cleared browser PWA & runtime caches.');
  }

  async function handleRenameCollection(oldName: string) {
    const trimmed = renameValue.trim();
    if (!trimmed || trimmed === oldName) {
      setEditingCollection(null);
      return;
    }
    const affected = videos
      .filter((v) => v.collection === oldName)
      .map((v) => ({...v, collection: trimmed}));
    if (affected.length > 0) {
      await saveVideosBulk(affected);
      await onRefreshLibrary();
    }
    setEditingCollection(null);
    setMessage(`Renamed collection "${oldName}" to "${trimmed}".`);
  }

  function handleExportBackup() {
    const payload = {
      exportedAt: new Date().toISOString(),
      app: 'TubeVault',
      videos,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {type: 'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tubevault-library-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setMessage('Exported your entire library, liked videos, collections, bookmarks, and notes as JSON.');
  }

  async function handleImportBackup(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as {videos?: VideoItem[]};
      if (!Array.isArray(parsed.videos)) {
        throw new Error('Invalid TubeVault backup file.');
      }
      await saveVideosBulk(parsed.videos);
      await onRefreshLibrary();
      onStatsChange();
      setMessage(`Imported ${parsed.videos.length} videos from backup.`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Backup import failed');
    } finally {
      e.target.value = '';
    }
  }

  const {breakdown} = stats;
  const totalMeasured = breakdown.totalMeasuredBytes;

  const formatSharePct = (bytes: number): string => {
    if (totalMeasured <= 0 || bytes <= 0) return '0%';
    const pct = (bytes / totalMeasured) * 100;
    if (pct < 0.1) return '<0.1%';
    return `${pct.toFixed(1)}%`;
  };

  const getSegmentWidthPct = (bytes: number): number => {
    if (totalMeasured <= 0 || bytes <= 0) return 0;
    return Math.max(1.5, (bytes / totalMeasured) * 100);
  };

  const storageBreakdownRows = [
    {
      id: 'thumbnails',
      label: 'Cached Thumbnails',
      detail: `${breakdown.thumbnailsCount} image${breakdown.thumbnailsCount === 1 ? '' : 's'} saved for offline preview`,
      bytes: breakdown.thumbnailsBytes,
      dotClass: 'bg-rose-500',
      textClass: 'text-rose-600 dark:text-rose-400',
      icon: ImageIcon,
      onClear: breakdown.thumbnailsBytes > 0 || stats.cachedThumbsCount > 0 ? handleClearThumbs : undefined,
      clearLabel: 'Clear Thumbs',
    },
    {
      id: 'notesChapters',
      label: 'Notes, Chapters & Bookmarks',
      detail: `${totalBookmarks} pins · ${totalNotesCount} notes · video descriptions & chapters`,
      bytes: breakdown.notesAndBookmarksBytes,
      dotClass: 'bg-emerald-500',
      textClass: 'text-emerald-600 dark:text-emerald-400',
      icon: FileText,
      onClear: breakdown.notesAndBookmarksBytes > 200 ? handleClearDescriptionsAndChapters : undefined,
      clearLabel: 'Trim Desc/Chapters',
    },
    {
      id: 'metadata',
      label: 'Video URLs, Titles & Watch History',
      detail: `${videos.length} saved YouTube links & playback positions`,
      bytes: breakdown.metadataBytes,
      dotClass: 'bg-sky-500',
      textClass: 'text-sky-600 dark:text-sky-400',
      icon: Bookmark,
      onClear: videos.some((v) => v.lastPositionSeconds > 0 || v.lastWatchedAt !== null)
        ? handleClearWatchHistory
        : undefined,
      clearLabel: 'Clear History',
    },
    {
      id: 'settings',
      label: 'App Settings & Preferences',
      detail: 'Theme & user data control toggles',
      bytes: breakdown.settingsBytes,
      dotClass: 'bg-violet-500',
      textClass: 'text-violet-600 dark:text-violet-400',
      icon: Settings2,
    },
    {
      id: 'browser',
      label: 'Browser / PWA Cache & Other',
      detail: 'App offline cache, IndexedDB index & runtime files',
      bytes: breakdown.otherBrowserBytes,
      dotClass: 'bg-amber-500',
      textClass: 'text-amber-600 dark:text-amber-400',
      icon: HardDrive,
      onClear: breakdown.otherBrowserBytes > 0 ? handleClearBrowserCache : undefined,
      clearLabel: 'Clear Cache',
    },
  ];

  const dataToggleItems: Array<{
    key: keyof DataPreferences;
    title: string;
    description: string;
    enabled: boolean;
    icon: typeof ImageIcon;
  }> = [
    {
      key: 'autoCacheThumbnails',
      title: 'Save Thumbnails Offline',
      description: dataPrefs.autoCacheThumbnails
        ? 'ON — Thumbnail images are cached locally so feeds work without internet.'
        : 'OFF — Stops saving new thumbnails locally; loads thumbnails live online only.',
      enabled: dataPrefs.autoCacheThumbnails,
      icon: ImageIcon,
    },
    {
      key: 'autoHarvestSuggested',
      title: 'Auto-Save Suggested Hub Videos',
      description: dataPrefs.autoHarvestSuggested
        ? 'ON — Suggested YouTube links auto-save into your Home Hub as you watch.'
        : 'OFF — Only videos you manually add, search, or Like are saved.',
      enabled: dataPrefs.autoHarvestSuggested,
      icon: Compass,
    },
    {
      key: 'saveWatchProgress',
      title: 'Save Watch Progress & History',
      description: dataPrefs.saveWatchProgress
        ? 'ON — Remembers playback timestamps for Continue Watching.'
        : 'OFF — Stops recording playback timestamps and watch history.',
      enabled: dataPrefs.saveWatchProgress,
      icon: Clock,
    },
    {
      key: 'cacheChaptersAndNotesMeta',
      title: 'Auto-Fetch Descriptions & Chapters',
      description: dataPrefs.cacheChaptersAndNotesMeta
        ? 'ON — Stores full video descriptions & chapter markers locally.'
        : 'OFF — Stores only lightweight URLs, titles & channel names.',
      enabled: dataPrefs.cacheChaptersAndNotesMeta,
      icon: FileText,
    },
  ];

  const quotaUsagePercent =
    stats.quotaBytes && stats.usageBytes
      ? Math.min(100, Math.max(0.5, (stats.usageBytes / stats.quotaBytes) * 100))
      : 0;

  return (
    <div className="space-y-6">
      {/* Header + App Tools (moved cleanly out of Top Nav into Library) */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
            Library, Tools &amp; Storage
          </h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Manage all saved URLs, Liked videos, auto-suggestions, app theme, and backups.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onOpenSuggestions}
            className="min-h-[40px] px-3.5 rounded-xl border border-slate-200 dark:border-[#242A38] bg-white dark:bg-[#13161D] hover:border-rose-500/70 text-xs font-semibold text-slate-800 dark:text-slate-100 inline-flex items-center gap-2 cursor-pointer"
          >
            {autoSuggestionsLoading ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin text-rose-500 shrink-0" />
            ) : (
              <Compass className="w-3.5 h-3.5 text-rose-500 shrink-0" />
            )}
            <span>Suggestion</span>
            {autoSuggestionsCount > 0 && (
              <span className="px-1.5 py-0.5 rounded bg-rose-600/15 text-rose-600 dark:text-rose-400 font-mono text-[10px] font-bold tabular-nums">
                {autoSuggestionsCount}
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={onToggleTheme}
            className="min-h-[40px] px-3.5 rounded-xl border border-slate-200 dark:border-[#242A38] bg-white dark:bg-[#13161D] hover:border-rose-500/70 text-xs font-semibold text-slate-800 dark:text-slate-100 inline-flex items-center gap-2 cursor-pointer"
          >
            {darkMode ? (
              <>
                <Sun className="w-3.5 h-3.5 text-amber-400" />
                <span>Light Mode</span>
              </>
            ) : (
              <>
                <Moon className="w-3.5 h-3.5 text-slate-700" />
                <span>Dark Mode</span>
              </>
            )}
          </button>

          {onOpenAddHub && (
            <button
              type="button"
              onClick={onOpenAddHub}
              className="min-h-[40px] px-3.5 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Add Links</span>
            </button>
          )}

          <PWAInstallButton />
        </div>
      </div>

      {/* Bulk Clear / Protect Liked Videos Card */}
      <div className="rounded-2xl border border-slate-200 dark:border-[#1E2430] bg-white dark:bg-[#13161D] p-5 sm:p-6 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-rose-500" />
              <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
                Clean All Video URLs (Liked Protection)
              </h2>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              <strong>Liked ({likedCount})</strong> videos stay safe when you clear unliked URLs ({unlikedCount}). Only remove liked videos when you explicitly choose &ldquo;Delete All (Including Liked)&rdquo;.
            </p>
          </div>

          <div className="flex items-center gap-2 font-mono text-xs tabular-nums">
            <span className="px-2.5 py-1 rounded-lg bg-rose-500/10 text-rose-500 font-semibold">
              {likedCount} Liked
            </span>
            <span className="px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-[#1E2430] text-slate-600 dark:text-slate-300">
              {unlikedCount} Unliked
            </span>
          </div>
        </div>

        {confirmMode === 'none' ? (
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={unlikedCount === 0 || deletingBulk}
              onClick={() => setConfirmMode('unliked')}
              className="min-h-[42px] px-4 rounded-xl bg-rose-600 hover:bg-rose-700 disabled:opacity-40 text-white text-xs font-semibold inline-flex items-center gap-2 cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Delete Unliked URLs ({unlikedCount})</span>
            </button>

            <button
              type="button"
              disabled={videos.length === 0 || deletingBulk}
              onClick={() => setConfirmMode('all')}
              className="min-h-[42px] px-4 rounded-xl border border-rose-500/40 text-rose-600 dark:text-rose-400 hover:bg-rose-500/10 disabled:opacity-40 text-xs font-semibold inline-flex items-center gap-2 cursor-pointer"
            >
              <AlertTriangle className="w-3.5 h-3.5" />
              <span>Delete All Including Liked ({videos.length})</span>
            </button>
          </div>
        ) : (
          <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-4 flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs font-medium text-rose-700 dark:text-rose-300">
              {confirmMode === 'unliked'
                ? `Delete ${unlikedCount} unliked video URLs? All ${likedCount} liked videos will remain untouched.`
                : `Delete ALL ${videos.length} videos including ${likedCount} liked video${likedCount === 1 ? '' : 's'}? This cannot be undone.`}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={deletingBulk}
                onClick={() => handleBulkDeleteConfirm(confirmMode === 'all')}
                className="min-h-[38px] px-4 rounded-lg bg-rose-600 hover:bg-rose-700 text-white text-xs font-semibold cursor-pointer"
              >
                {deletingBulk
                  ? 'Deleting...'
                  : confirmMode === 'unliked'
                    ? 'Confirm Delete Unliked'
                    : 'Confirm Delete Everything'}
              </button>
              <button
                type="button"
                disabled={deletingBulk}
                onClick={() => setConfirmMode('none')}
                className="min-h-[38px] px-3 rounded-lg border border-slate-300 dark:border-[#2C3446] bg-white dark:bg-[#13161D] text-xs font-medium text-slate-700 dark:text-slate-200 cursor-pointer"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* 4-Column Metric Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="rounded-2xl border border-slate-200 dark:border-[#1E2430] bg-white dark:bg-[#13161D] p-5">
          <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
            Saved Videos
          </div>
          <div className="mt-2 font-mono text-2xl font-bold tabular-nums text-slate-900 dark:text-white">
            {stats.videoCount}
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200 dark:border-[#1E2430] bg-white dark:bg-[#13161D] p-5">
          <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
            Liked Videos
          </div>
          <div className="mt-2 font-mono text-2xl font-bold tabular-nums text-rose-500">
            {likedCount}
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200 dark:border-[#1E2430] bg-white dark:bg-[#13161D] p-5">
          <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
            Cached Thumbs
          </div>
          <div className="mt-2 font-mono text-2xl font-bold tabular-nums text-emerald-500">
            {stats.cachedThumbsCount}
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200 dark:border-[#1E2430] bg-white dark:bg-[#13161D] p-5">
          <div className="text-xs font-medium text-slate-500 dark:text-slate-400">
            Pins &amp; Notes
          </div>
          <div className="mt-2 font-mono text-2xl font-bold tabular-nums text-slate-900 dark:text-white">
            {totalBookmarks + totalNotesCount}
          </div>
        </div>
      </div>

      {/* Exact Storage Breakdown (% + Size) + User Data Controls (On/Off Anytime) */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-4">
        {/* Storage Breakdown Card */}
        <div className="xl:col-span-7 rounded-2xl border border-slate-200 dark:border-[#1E2430] bg-white dark:bg-[#13161D] p-5 sm:p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2.5">
              <PieChart className="w-4 h-4 text-rose-500" />
              <div>
                <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
                  Storage Data Breakdown (% &amp; Size)
                </h2>
                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                  Exact share of Thumbnails, Notes/Chapters, Video URLs &amp; Browser Cache
                </p>
              </div>
            </div>
            <div className="text-right font-mono text-xs tabular-nums">
              <div className="font-semibold text-slate-900 dark:text-white">
                {formatBytes(totalMeasured)} used
              </div>
              <div className="text-[11px] text-slate-500 dark:text-slate-400">
                {stats.quotaBytes != null
                  ? `${quotaUsagePercent.toFixed(2)}% of ${formatBytes(stats.quotaBytes)} quota`
                  : 'Local IndexedDB'}
              </div>
            </div>
          </div>

          {/* Multi-Segment Percentage Bar */}
          <div className="space-y-1.5">
            <div className="w-full h-3.5 rounded-full bg-slate-100 dark:bg-[#0B0D11] border border-slate-200/70 dark:border-[#242A38] overflow-hidden flex">
              {totalMeasured > 0 ? (
                storageBreakdownRows.map((row) => {
                  const widthPct = getSegmentWidthPct(row.bytes);
                  if (widthPct <= 0) return null;
                  return (
                    <div
                      key={row.id}
                      title={`${row.label}: ${formatSharePct(row.bytes)} (${formatBytes(row.bytes)})`}
                      className={`h-full ${row.dotClass} transition-all duration-300`}
                      style={{width: `${widthPct}%`}}
                    />
                  );
                })
              ) : (
                <div className="h-full w-0" />
              )}
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] font-mono tabular-nums text-slate-500 dark:text-slate-400">
              {storageBreakdownRows.map((row) => (
                <span key={`legend-${row.id}`} className="inline-flex items-center gap-1.5">
                  <span className={`w-2 h-2 rounded-full ${row.dotClass}`} />
                  <span>{row.label.split(',')[0]}:</span>
                  <strong className="text-slate-800 dark:text-slate-200">
                    {formatSharePct(row.bytes)}
                  </strong>
                </span>
              ))}
            </div>
          </div>

          {/* Detailed Per-Category Percentage Rows */}
          <div className="divide-y divide-slate-100 dark:divide-[#1E2430] rounded-xl border border-slate-200/70 dark:border-[#1E2430] bg-slate-50/60 dark:bg-[#0B0D11]/70">
            {storageBreakdownRows.map((row) => {
              const Icon = row.icon;
              const share = formatSharePct(row.bytes);
              return (
                <div
                  key={row.id}
                  className="px-3.5 py-2.5 flex flex-wrap sm:flex-nowrap items-center justify-between gap-2.5"
                >
                  <div className="flex items-center gap-2.5 min-w-0 flex-1">
                    <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${row.dotClass}`} />
                    <Icon className={`w-4 h-4 shrink-0 ${row.textClass}`} />
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-slate-900 dark:text-white truncate">
                        {row.label}
                      </div>
                      <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                        {row.detail}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2.5 shrink-0 ml-auto">
                    <div className="text-right font-mono tabular-nums">
                      <div className={`text-xs font-bold ${row.textClass}`}>{share}</div>
                      <div className="text-[11px] text-slate-500 dark:text-slate-400">
                        {formatBytes(row.bytes)}
                      </div>
                    </div>

                    {row.onClear && (
                      <button
                        type="button"
                        onClick={row.onClear}
                        className="px-2.5 py-1 rounded-lg border border-slate-200 dark:border-[#242A38] bg-white dark:bg-[#13161D] hover:border-rose-500/60 hover:text-rose-500 text-[11px] font-medium text-slate-700 dark:text-slate-200 cursor-pointer transition-colors"
                      >
                        {row.clearLabel}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="pt-1 flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={handleSyncPending}
              disabled={!isOnline || syncing}
              className="min-h-[40px] px-4 rounded-xl bg-slate-900 dark:bg-white text-white dark:text-slate-900 text-xs font-semibold disabled:opacity-40 inline-flex items-center gap-2 cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
              <span>{syncing ? 'Syncing Allowed Data...' : 'Sync Enabled Cache'}</span>
            </button>

            <button
              type="button"
              onClick={handleClearThumbs}
              disabled={stats.cachedThumbsCount === 0 && breakdown.thumbnailsBytes === 0}
              className="min-h-[40px] px-3.5 rounded-xl border border-slate-200 dark:border-[#242A38] text-xs font-medium text-slate-700 dark:text-slate-300 hover:text-rose-600 dark:hover:text-rose-400 disabled:opacity-40 inline-flex items-center gap-2 cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Clear Thumbnail Cache</span>
            </button>

            <button
              type="button"
              onClick={onStatsChange}
              className="min-h-[40px] px-3 rounded-xl border border-slate-200 dark:border-[#242A38] text-xs font-medium text-slate-600 dark:text-slate-300 hover:border-rose-500/60 inline-flex items-center gap-1.5 cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Recalculate</span>
            </button>
          </div>
        </div>

        {/* User Data Save Controls (On / Off Switches Anytime) */}
        <div className="xl:col-span-5 rounded-2xl border border-slate-200 dark:border-[#1E2430] bg-white dark:bg-[#13161D] p-5 sm:p-6 space-y-4">
          <div className="flex items-center gap-2.5">
            <SlidersHorizontal className="w-4 h-4 text-rose-500" />
            <div>
              <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
                Data &amp; Cache Controls (On / Off Anytime)
              </h2>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                Choose what TubeVault saves in your Library — turn anything off or back on anytime.
              </p>
            </div>
          </div>

          <div className="space-y-2.5">
            {dataToggleItems.map((item) => {
              const Icon = item.icon;
              return (
                <div
                  key={item.key}
                  className="rounded-xl border border-slate-200/80 dark:border-[#242A38] bg-slate-50/70 dark:bg-[#0B0D11]/80 p-3.5 flex items-start justify-between gap-3"
                >
                  <div className="flex items-start gap-2.5 min-w-0">
                    <Icon
                      className={`w-4 h-4 mt-0.5 shrink-0 ${
                        item.enabled ? 'text-rose-500' : 'text-slate-400'
                      }`}
                    />
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-slate-900 dark:text-white">
                        {item.title}
                      </div>
                      <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
                        {item.description}
                      </p>
                      {item.key === 'autoCacheThumbnails' &&
                        !item.enabled &&
                        breakdown.thumbnailsBytes > 0 && (
                          <button
                            type="button"
                            onClick={handleClearThumbs}
                            className="mt-1.5 text-[11px] font-semibold text-rose-600 dark:text-rose-400 hover:underline cursor-pointer"
                          >
                            Also clear old thumbnails ({formatBytes(breakdown.thumbnailsBytes)})
                          </button>
                        )}
                    </div>
                  </div>

                  <button
                    type="button"
                    role="switch"
                    aria-checked={item.enabled}
                    aria-label={item.title}
                    onClick={() => onUpdateDataPrefs({[item.key]: !item.enabled})}
                    className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors cursor-pointer ${
                      item.enabled ? 'bg-rose-600' : 'bg-slate-300 dark:bg-[#2A3244]'
                    }`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                        item.enabled ? 'translate-x-6' : 'translate-x-1'
                      }`}
                    />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Backup Export & Import */}
      <div className="rounded-2xl border border-slate-200 dark:border-[#1E2430] bg-white dark:bg-[#13161D] p-5 sm:p-6 space-y-4">
          <div className="flex items-center gap-2.5">
            <Database className="w-4 h-4 text-rose-500" />
            <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
              Library &amp; Notes Backup
            </h2>
          </div>

          <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
            Export your curated queue, liked videos, collections, chapters, timestamp bookmarks, and study notes as JSON.
          </p>

          <input
            ref={importRef}
            type="file"
            accept="application/json,.json"
            onChange={handleImportBackup}
            className="hidden"
          />

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={handleExportBackup}
              disabled={videos.length === 0}
              className="min-h-[42px] px-4 rounded-xl border border-slate-200 dark:border-[#242A38] text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-[#1C212C] disabled:opacity-40 inline-flex items-center gap-2 cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Export Library JSON</span>
            </button>

            <button
              type="button"
              onClick={() => importRef.current?.click()}
              className="min-h-[42px] px-4 rounded-xl border border-slate-200 dark:border-[#242A38] text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-[#1C212C] inline-flex items-center gap-2 cursor-pointer"
            >
              <Upload className="w-3.5 h-3.5" />
              <span>Import Backup JSON</span>
            </button>
          </div>
      </div>

      {/* Collection Organizer */}
      {collectionBreakdown.length > 0 && (
        <div className="rounded-2xl border border-slate-200 dark:border-[#1E2430] bg-white dark:bg-[#13161D] p-6 space-y-4">
          <div className="flex items-center gap-2.5">
            <FolderEdit className="w-4 h-4 text-rose-500" />
            <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
              Collections
            </h2>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {collectionBreakdown.map(([col, count]) => (
              <div
                key={col}
                className="rounded-xl border border-slate-200 dark:border-[#242A38] bg-slate-50 dark:bg-[#0B0D11] px-4 py-3 flex items-center justify-between gap-2"
              >
                {editingCollection === col ? (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      handleRenameCollection(col);
                    }}
                    className="flex items-center gap-2 w-full"
                  >
                    <input
                      type="text"
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      autoFocus
                      className="flex-1 min-w-0 rounded-lg border border-slate-300 dark:border-[#2C3446] bg-white dark:bg-[#13161D] px-2.5 py-1 text-xs text-slate-900 dark:text-white"
                    />
                    <button
                      type="submit"
                      className="px-2.5 py-1 rounded-lg bg-rose-600 text-white text-xs font-semibold cursor-pointer"
                    >
                      Save
                    </button>
                  </form>
                ) : (
                  <>
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-slate-900 dark:text-white truncate">
                        {col}
                      </div>
                      <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400 tabular-nums">
                        {count} video{count === 1 ? '' : 's'}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setEditingCollection(col);
                        setRenameValue(col);
                      }}
                      className="text-xs font-medium text-slate-500 hover:text-rose-500 cursor-pointer shrink-0"
                    >
                      Rename
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Library Saved URLs List (Like / Protect / Delete individually) */}
      {videos.length > 0 && (
        <div className="rounded-2xl border border-slate-200 dark:border-[#1E2430] bg-white dark:bg-[#13161D] p-5 sm:p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-white">
              Saved Video URLs ({filteredVideos.length})
            </h2>

            <div className="flex flex-wrap items-center gap-2">
              {!externalSearchQuery && (
                <div className="relative">
                  <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <input
                    type="search"
                    value={libSearch}
                    onChange={(e) => setLibSearch(e.target.value)}
                    placeholder="Filter saved URLs..."
                    className="min-h-[36px] w-48 rounded-lg border border-slate-200 dark:border-[#242A38] bg-slate-50 dark:bg-[#0B0D11] pl-8 pr-3 text-xs text-slate-900 dark:text-slate-100"
                  />
                </div>
              )}

              <div className="flex items-center gap-1 p-1 rounded-lg bg-slate-100 dark:bg-[#0B0D11] border border-slate-200 dark:border-[#242A38]">
                {[
                  {id: 'all', label: `All (${videos.length})`},
                  {id: 'liked', label: `Liked (${likedCount})`},
                  {id: 'unliked', label: `Unliked (${unlikedCount})`},
                ].map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setLibFilter(tab.id as typeof libFilter)}
                    className={`px-2.5 py-1 rounded text-[11px] font-semibold cursor-pointer ${
                      libFilter === tab.id
                        ? 'bg-white dark:bg-[#1E2430] text-slate-900 dark:text-white shadow-sm'
                        : 'text-slate-500 dark:text-slate-400'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="divide-y divide-slate-100 dark:divide-[#1E2430] max-h-[420px] overflow-y-auto pr-1">
            {filteredVideos.map((item) => (
              <div
                key={item.id}
                className="py-2.5 flex items-center gap-3 justify-between"
              >
                <button
                  type="button"
                  onClick={() => onSelectVideo(item.id)}
                  className="flex items-center gap-3 min-w-0 flex-1 text-left group cursor-pointer"
                >
                  <div className="w-16 aspect-video rounded-lg overflow-hidden bg-black shrink-0 relative">
                    <CachedThumbnail
                      videoId={item.videoId}
                      alt={item.title}
                      isOnline={isOnline}
                      fit="cover"
                      className="w-full h-full"
                    />
                    <span className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 bg-black/40 transition-opacity">
                      <Play className="w-3.5 h-3.5 text-white fill-current" />
                    </span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-semibold text-slate-900 dark:text-white truncate group-hover:text-rose-500 transition-colors">
                      {item.title}
                    </div>
                    <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                      {item.authorName} · {item.collection}
                    </div>
                  </div>
                </button>

                <div className="flex items-center gap-1.5 shrink-0">

                  <button
                    type="button"
                    onClick={() => onToggleLike(item)}
                    title={item.liked ? 'Liked (Protected)' : 'Like to protect'}
                    className={`min-h-[34px] px-2.5 rounded-lg border text-[11px] font-semibold inline-flex items-center gap-1 cursor-pointer ${
                      item.liked
                        ? 'border-rose-500/40 bg-rose-500/10 text-rose-500'
                        : 'border-slate-200 dark:border-[#242A38] text-slate-500 hover:text-rose-500'
                    }`}
                  >
                    <Heart className={`w-3.5 h-3.5 ${item.liked ? 'fill-current' : ''}`} />
                    <span className="hidden sm:inline">{item.liked ? 'Liked' : 'Like'}</span>
                  </button>

                  {item.liked ? (
                    confirmSingleLikedId === item.id ? (
                      <button
                        type="button"
                        onClick={() => {
                          setConfirmSingleLikedId(null);
                          onDeleteSingleVideo(item);
                        }}
                        className="min-h-[34px] px-2.5 rounded-lg bg-rose-600 text-white text-[11px] font-semibold cursor-pointer"
                      >
                        Remove Liked?
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmSingleLikedId(item.id)}
                        title="Liked video — tap once to confirm removal"
                        aria-label={`Remove liked video ${item.title}`}
                        className="min-h-[34px] min-w-[34px] flex items-center justify-center rounded-lg text-slate-400 hover:text-rose-500 cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )
                  ) : (
                    <button
                      type="button"
                      onClick={() => onDeleteSingleVideo(item)}
                      aria-label={`Delete ${item.title}`}
                      className="min-h-[34px] min-w-[34px] flex items-center justify-center rounded-lg text-slate-400 hover:text-rose-500 cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {message && (
        <div className="flex items-center gap-2 text-xs font-medium text-emerald-600 dark:text-emerald-400">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span>{message}</span>
        </div>
      )}
    </div>
  );
};
