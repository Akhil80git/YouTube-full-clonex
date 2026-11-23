import React, {useEffect, useRef, useState} from 'react';
import {Film} from 'lucide-react';
import {
  getDataPreferencesSync,
  getThumbnailBlob,
  saveThumbnailBlob,
} from '../lib/offlineDb';

// Fast in-memory session cache so thumbnails render in 0ms on tab switches & scrolls
const memoryThumbUrlCache = new Map<string, string>();
const inFlightThumbLoads = new Map<string, Promise<string | null>>();
const MAX_MEM_THUMBS = 350;

export function clearInMemoryThumbCache(): void {
  for (const url of memoryThumbUrlCache.values()) {
    if (url.startsWith('blob:')) {
      URL.revokeObjectURL(url);
    }
  }
  memoryThumbUrlCache.clear();
}

function rememberThumbUrl(videoId: string, url: string): string {
  if (memoryThumbUrlCache.size >= MAX_MEM_THUMBS && !memoryThumbUrlCache.has(videoId)) {
    const oldestKey = memoryThumbUrlCache.keys().next().value;
    if (oldestKey) {
      const oldUrl = memoryThumbUrlCache.get(oldestKey);
      memoryThumbUrlCache.delete(oldestKey);
      if (oldUrl && oldUrl.startsWith('blob:')) URL.revokeObjectURL(oldUrl);
    }
  }
  memoryThumbUrlCache.set(videoId, url);
  return url;
}

async function resolveThumbUrl(videoId: string, isOnline: boolean): Promise<string | null> {
  const hit = memoryThumbUrlCache.get(videoId);
  if (hit) return hit;

  const existingTask = inFlightThumbLoads.get(videoId);
  if (existingTask) return existingTask;

  const task = (async () => {
    try {
      const cachedBlob = await getThumbnailBlob(videoId);
      if (cachedBlob) {
        return rememberThumbUrl(videoId, URL.createObjectURL(cachedBlob));
      }

      if (!isOnline) return null;

      // If user turned OFF offline thumbnail caching, stream directly without saving to IndexedDB
      if (!getDataPreferencesSync().autoCacheThumbnails) {
        return rememberThumbUrl(
          videoId,
          `/api/youtube/thumbnail?videoId=${encodeURIComponent(videoId)}`
        );
      }

      const resp = await fetch(`/api/youtube/thumbnail?videoId=${encodeURIComponent(videoId)}`);
      if (!resp.ok) return null;
      const blob = await resp.blob();
      await saveThumbnailBlob(videoId, blob);
      return rememberThumbUrl(videoId, URL.createObjectURL(blob));
    } catch {
      return null;
    } finally {
      inFlightThumbLoads.delete(videoId);
    }
  })();

  inFlightThumbLoads.set(videoId, task);
  return task;
}

interface CachedThumbnailProps {
  videoId: string;
  alt: string;
  isOnline: boolean;
  fit?: 'contain' | 'cover';
  className?: string;
}

export const CachedThumbnail: React.FC<CachedThumbnailProps> = ({
  videoId,
  alt,
  isOnline,
  fit = 'contain',
  className = '',
}) => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const memHit = memoryThumbUrlCache.get(videoId) || null;
  const [inView, setInView] = useState(Boolean(memHit));
  const [srcUrl, setSrcUrl] = useState<string | null>(memHit);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const instant = memoryThumbUrlCache.get(videoId) || null;
    if (instant) {
      setSrcUrl(instant);
      setFailed(false);
      setInView(true);
    } else {
      setSrcUrl(null);
      setFailed(false);
    }
  }, [videoId]);

  useEffect(() => {
    const el = hostRef.current;
    if (!el || inView) return;

    if (typeof IntersectionObserver === 'undefined') {
      setInView(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setInView(true);
          observer.disconnect();
        }
      },
      {rootMargin: '400px'}
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [inView]);

  useEffect(() => {
    if (!inView) return;

    const instant = memoryThumbUrlCache.get(videoId);
    if (instant) {
      setSrcUrl(instant);
      setFailed(false);
      return;
    }

    let active = true;
    resolveThumbUrl(videoId, isOnline).then((url) => {
      if (!active) return;
      if (url) {
        setSrcUrl(url);
        setFailed(false);
      } else {
        setFailed(true);
      }
    });

    return () => {
      active = false;
    };
  }, [videoId, isOnline, inView]);

  if (!inView || failed || !srcUrl) {
    return (
      <div
        ref={hostRef}
        className={`flex flex-col items-center justify-center bg-gradient-to-br from-slate-200 to-slate-300 dark:from-[#171B24] dark:to-[#10131A] text-slate-500 dark:text-slate-400 select-none ${className}`}
      >
        <Film className="w-6 h-6 opacity-60" />
        <span className="mt-1 font-mono text-[10px] tracking-tight opacity-70">{videoId}</span>
      </div>
    );
  }

  return (
    <img
      src={srcUrl}
      alt={alt}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => {
        memoryThumbUrlCache.delete(videoId);
        setFailed(true);
      }}
      className={`${fit === 'cover' ? 'object-cover' : 'object-contain bg-black'} ${className}`}
    />
  );
};
