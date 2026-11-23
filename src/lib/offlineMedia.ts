import {getDataPreferencesSync, saveThumbnailBlob} from './offlineDb';
import type {ReelItem, VideoChapter, VideoItem} from '../types/video';

let ytApiPromise: Promise<void> | null = null;

export function ensureYouTubeIframeApi(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  if (window.YT?.Player) return Promise.resolve();
  if (ytApiPromise) return ytApiPromise;

  ytApiPromise = new Promise<void>((resolve) => {
    const check = () => {
      if (window.YT?.Player) {
        resolve();
        return true;
      }
      return false;
    };

    if (check()) return;

    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (prev) {
        try {
          prev();
        } catch {
          // Ignore
        }
      }
      resolve();
    };

    const existing = document.querySelector(
      'script[src="https://www.youtube.com/iframe_api"]'
    );
    if (!existing) {
      const tag = document.createElement('script');
      tag.src = 'https://www.youtube.com/iframe_api';
      tag.async = true;
      document.head.appendChild(tag);
    }

    const poll = setInterval(() => {
      if (check()) {
        clearInterval(poll);
      }
    }, 80);
    setTimeout(() => clearInterval(poll), 10000);
  });

  return ytApiPromise;
}

// Fast in-memory Reels cache so switching to Reels tab is instant
interface CachedReelsBatch {
  reels: ReelItem[];
  nextPage: number;
  fetchedAt: number;
}

const reelsTopicCache = new Map<string, CachedReelsBatch>();
const reelsInflight = new Map<string, Promise<CachedReelsBatch | null>>();

export function getCachedReelsBatch(topic: string): CachedReelsBatch | null {
  const cached = reelsTopicCache.get(topic);
  if (!cached) return null;
  if (Date.now() - cached.fetchedAt > 5 * 60 * 1000) return null;
  return cached;
}

export function setCachedReelsBatch(topic: string, reels: ReelItem[], nextPage: number): void {
  reelsTopicCache.set(topic, {
    reels,
    nextPage,
    fetchedAt: Date.now(),
  });
}

export async function prefetchReelsFeed(topic = 'all'): Promise<CachedReelsBatch | null> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return null;
  const existing = getCachedReelsBatch(topic);
  if (existing && existing.reels.length > 0) return existing;

  const inflight = reelsInflight.get(topic);
  if (inflight) return inflight;

  const task = fetch(`/api/youtube/reels?topic=${encodeURIComponent(topic)}&page=0`)
    .then(async (resp) => {
      if (!resp.ok) return null;
      const data = (await resp.json()) as {reels?: ReelItem[]; nextPage?: number};
      const reels = Array.isArray(data.reels) ? data.reels : [];
      if (reels.length === 0) return null;
      const batch: CachedReelsBatch = {
        reels,
        nextPage: typeof data.nextPage === 'number' ? data.nextPage : 1,
        fetchedAt: Date.now(),
      };
      reelsTopicCache.set(topic, batch);

      if (typeof Image !== 'undefined') {
        for (const r of reels.slice(0, 4)) {
          const img = new Image();
          img.src = r.thumbnailUrl;
        }
      }
      return batch;
    })
    .catch(() => null)
    .finally(() => {
      reelsInflight.delete(topic);
    });

  reelsInflight.set(topic, task);
  return task;
}

export async function enrichVideoOfflineMetaAndThumb(video: VideoItem): Promise<VideoItem> {
  let next = {...video};
  if (typeof navigator === 'undefined' || !navigator.onLine) {
    return next;
  }

  const prefs = getDataPreferencesSync();
  const needsMeta =
    prefs.cacheChaptersAndNotesMeta &&
    (!next.chapters ||
      next.title.startsWith('YouTube Video (') ||
      next.authorName === 'YouTube Creator');

  const tasks: Array<Promise<void>> = [];

  if (needsMeta) {
    tasks.push(
      fetch(`/api/youtube/metadata?videoId=${encodeURIComponent(video.videoId)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then(
          (
            meta: {
              title?: string;
              authorName?: string;
              authorUrl?: string;
              description?: string;
              durationSeconds?: number | null;
              chapters?: VideoChapter[];
            } | null
          ) => {
            if (!meta) return;
            next = {
              ...next,
              title:
                next.title.startsWith('YouTube Video (') && meta.title
                  ? meta.title
                  : next.title,
              authorName:
                next.authorName === 'YouTube Creator' && meta.authorName
                  ? meta.authorName
                  : next.authorName,
              authorUrl: meta.authorUrl || next.authorUrl,
              description: meta.description || next.description,
              durationSeconds: meta.durationSeconds ?? next.durationSeconds,
              chapters: Array.isArray(meta.chapters) ? meta.chapters : next.chapters ?? [],
            };
          }
        )
        .catch(() => {})
    );
  }

  if (prefs.autoCacheThumbnails && !next.thumbCached) {
    tasks.push(
      fetch(`/api/youtube/thumbnail?videoId=${encodeURIComponent(video.videoId)}`)
        .then((r) => (r.ok ? r.blob() : null))
        .then(async (blob) => {
          if (blob) {
            await saveThumbnailBlob(video.videoId, blob);
            next = {...next, thumbCached: true};
          }
        })
        .catch(() => {})
    );
  }

  await Promise.all(tasks);
  return next;
}
