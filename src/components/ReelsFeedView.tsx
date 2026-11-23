import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  Check,
  ChevronDown,
  ChevronUp,
  Clapperboard,
  Copy,
  Headphones,
  Heart,
  Loader2,
  Maximize2,
  Plus,
  RefreshCw,
  Repeat,
  SkipForward,
  Volume2,
  VolumeX,
  WifiOff,
} from 'lucide-react';
import {
  ensureYouTubeIframeApi,
  getCachedReelsBatch,
  setCachedReelsBatch,
} from '../lib/offlineMedia';
import type {ReelItem, SuggestedVideoInput, VideoItem} from '../types/video';

interface YTReelPlayer {
  playVideo: () => void;
  pauseVideo: () => void;
  seekTo: (seconds: number, allowSeekAhead: boolean) => void;
  mute: () => void;
  unMute: () => void;
  isMuted: () => boolean;
  getPlayerState: () => number;
  destroy: () => void;
}

interface ReelsFeedViewProps {
  videos: VideoItem[];
  existingVideoIds: Set<string>;
  isOnline: boolean;
  onReelPlaybackStarted: () => void;
  onSaveReel: (suggested: SuggestedVideoInput) => void;
  onSaveAndLikeReel: (suggested: SuggestedVideoInput) => void;
  onPlayReelInMusic: (suggested: SuggestedVideoInput) => void;
  onOpenReelInPlayer: (suggested: SuggestedVideoInput) => void;
  onToggleLikeSaved: (video: VideoItem) => void;
}

const REEL_TOPICS = [
  {id: 'all', label: 'For You'},
  {id: 'liked', label: 'Liked'},
  {id: 'music', label: 'Music'},
  {id: 'comedy', label: 'Comedy'},
  {id: 'tech', label: 'Tech'},
  {id: 'motivation', label: 'Motivation'},
  {id: 'gaming', label: 'Gaming'},
];

interface ReelSlidePlayerProps {
  reel: ReelItem;
  isActive: boolean;
  isNearby: boolean;
  isOnline: boolean;
  muted: boolean;
  autoAdvance: boolean;
  onRequestUnmuteHint: () => void;
  onEndedAdvance: () => void;
  onPlaybackBlockedOrError: () => void;
}

const ReelSlidePlayer: React.FC<ReelSlidePlayerProps> = React.memo(
  ({
    reel,
    isActive,
    isNearby,
    isOnline,
    muted,
    autoAdvance,
    onRequestUnmuteHint,
    onEndedAdvance,
    onPlaybackBlockedOrError,
  }) => {
    const ytHostRef = useRef<HTMLDivElement | null>(null);
    const ytPlayerRef = useRef<YTReelPlayer | null>(null);
    const readyRef = useRef(false);

    const isActiveRef = useRef(isActive);
    isActiveRef.current = isActive;
    const mutedRef = useRef(muted);
    mutedRef.current = muted;
    const autoAdvanceRef = useRef(autoAdvance);
    autoAdvanceRef.current = autoAdvance;
    const onEndedAdvanceRef = useRef(onEndedAdvance);
    onEndedAdvanceRef.current = onEndedAdvance;
    const onErrorRef = useRef(onPlaybackBlockedOrError);
    onErrorRef.current = onPlaybackBlockedOrError;
    const onUnmuteHintRef = useRef(onRequestUnmuteHint);
    onUnmuteHintRef.current = onRequestUnmuteHint;

    const [videoReadyVisible, setVideoReadyVisible] = useState(false);

    // Pre-warm YT.Player for [activeIndex - 1, activeIndex, activeIndex + 1]
    useEffect(() => {
      if (!isOnline || !isNearby) {
        readyRef.current = false;
        setVideoReadyVisible(false);
        if (ytPlayerRef.current) {
          try {
            ytPlayerRef.current.destroy();
          } catch {
            // Ignore
          }
          ytPlayerRef.current = null;
        }
        return;
      }

      if (ytPlayerRef.current) return;

      let cancelled = false;
      ensureYouTubeIframeApi().then(() => {
        if (cancelled || !ytHostRef.current || !window.YT?.Player || ytPlayerRef.current) return;

        ytHostRef.current.innerHTML = '';
        const node = document.createElement('div');
        node.style.width = '100%';
        node.style.height = '100%';
        ytHostRef.current.appendChild(node);

        const activeNow = isActiveRef.current;
        ytPlayerRef.current = new (window.YT.Player as unknown as new (
          el: HTMLElement,
          opts: Record<string, unknown>
        ) => YTReelPlayer)(node, {
          videoId: reel.videoId,
          width: '100%',
          height: '100%',
          playerVars: {
            autoplay: activeNow ? 1 : 0,
            mute: activeNow && !mutedRef.current ? 0 : 1,
            playsinline: 1,
            rel: 0,
            modestbranding: 1,
            controls: 1,
            enablejsapi: 1,
            origin: window.location.origin,
          },
          events: {
            onReady: (ev: {target: YTReelPlayer}) => {
              if (cancelled) return;
              readyRef.current = true;
              try {
                if (isActiveRef.current) {
                  if (mutedRef.current) ev.target.mute();
                  else ev.target.unMute();
                  ev.target.playVideo();
                } else {
                  ev.target.mute();
                  ev.target.pauseVideo();
                }
              } catch {
                // Ignore
              }
            },
            onStateChange: (ev: {data: number; target: YTReelPlayer}) => {
              if (cancelled) return;
              const st = ev.data;
              if (st === 1) {
                if (isActiveRef.current) {
                  setVideoReadyVisible(true);
                } else {
                  try {
                    ev.target.pauseVideo();
                    ev.target.seekTo(0, true);
                  } catch {
                    // Ignore
                  }
                }
              } else if (st === 0) {
                if (isActiveRef.current) {
                  if (autoAdvanceRef.current) {
                    onEndedAdvanceRef.current();
                  } else {
                    try {
                      ev.target.seekTo(0, true);
                      ev.target.playVideo();
                    } catch {
                      // Ignore
                    }
                  }
                }
              }
            },
            onError: () => {
              if (!cancelled && isActiveRef.current) {
                onErrorRef.current();
              }
            },
          },
        });
      });

      return () => {
        cancelled = true;
      };
    }, [reel.videoId, isNearby, isOnline]);

    // Cleanup YT.Player on unmount
    useEffect(() => {
      return () => {
        readyRef.current = false;
        if (ytPlayerRef.current) {
          try {
            ytPlayerRef.current.destroy();
          } catch {
            // Ignore
          }
          ytPlayerRef.current = null;
        }
      };
    }, []);

    // Instant play/pause + autoplay recovery when activeIndex changes (zero iframe reload)
    useEffect(() => {
      const p = ytPlayerRef.current;
      if (!p || !readyRef.current) return;

      let recoveryTimer: ReturnType<typeof setTimeout> | null = null;

      try {
        if (isActive) {
          if (muted) p.mute();
          else p.unMute();
          p.playVideo();

          recoveryTimer = setTimeout(() => {
            if (!isActiveRef.current || !ytPlayerRef.current) return;
            try {
              const st = ytPlayerRef.current.getPlayerState();
              if (st !== 1 && st !== 3) {
                ytPlayerRef.current.mute();
                ytPlayerRef.current.playVideo();
                if (!mutedRef.current) {
                  onUnmuteHintRef.current();
                }
              }
            } catch {
              // Ignore
            }
          }, 750);
        } else {
          setVideoReadyVisible(false);
          p.mute();
          p.pauseVideo();
          p.seekTo(0, true);
        }
      } catch {
        // Ignore
      }

      return () => {
        if (recoveryTimer) clearTimeout(recoveryTimer);
      };
    }, [isActive]);

    // Instant mute/unmute without reloading iframe
    useEffect(() => {
      const p = ytPlayerRef.current;
      if (!p || !readyRef.current) return;
      try {
        if (!isActive) {
          p.mute();
        } else if (muted) {
          p.mute();
        } else {
          p.unMute();
        }
      } catch {
        // Ignore
      }
    }, [muted, isActive]);

    return (
      <>
        {/* Base Layer: Always-visible crisp poster thumbnail -> ZERO black screen */}
        <img
          src={reel.thumbnailUrl}
          alt={reel.title}
          loading={isNearby || isActive ? 'eager' : 'lazy'}
          decoding="async"
          onError={(e) => {
            const img = e.currentTarget;
            if (!img.dataset.fallbackApplied) {
              img.dataset.fallbackApplied = '1';
              img.src = `https://i.ytimg.com/vi/${reel.videoId}/hqdefault.jpg`;
            }
          }}
          className="absolute inset-0 w-full h-full object-cover z-0 select-none"
        />

        {isNearby && isOnline && (
          <div
            ref={ytHostRef}
            className={`absolute inset-0 w-full h-full z-10 transition-opacity duration-150 ${
              isActive && videoReadyVisible
                ? 'opacity-100 pointer-events-auto'
                : 'opacity-0 pointer-events-none'
            }`}
          />
        )}

        {isActive && !videoReadyVisible && isOnline && (
          <div className="pointer-events-none absolute top-14 left-1/2 -translate-x-1/2 z-15 px-2.5 py-1 rounded-full bg-black/55 backdrop-blur-md text-[10px] font-medium text-white/90 inline-flex items-center gap-1.5">
            <Loader2 className="w-3 h-3 animate-spin text-rose-500" />
            <span>Starting...</span>
          </div>
        )}
      </>
    );
  }
);

ReelSlidePlayer.displayName = 'ReelSlidePlayer';

export const ReelsFeedView: React.FC<ReelsFeedViewProps> = ({
  videos,
  existingVideoIds,
  isOnline,
  onReelPlaybackStarted,
  onSaveReel,
  onSaveAndLikeReel,
  onPlayReelInMusic,
  onOpenReelInPlayer,
  onToggleLikeSaved,
}) => {
  const [topic, setTopic] = useState('all');
  const [reels, setReels] = useState<ReelItem[]>(() => {
    const cached = getCachedReelsBatch('all');
    return cached?.reels ?? [];
  });
  const [nextPage, setNextPage] = useState(() => {
    const cached = getCachedReelsBatch('all');
    return cached?.nextPage ?? 0;
  });
  const [loadingInitial, setLoadingInitial] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [muted, setMuted] = useState(false);
  const [autoAdvance, setAutoAdvance] = useState(false);
  const [tapForSoundHint, setTapForSoundHint] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const slideRefs = useRef<Array<HTMLDivElement | null>>([]);
  const seenIdsRef = useRef<Set<string>>(new Set());
  const fetchingRef = useRef(false);
  const onPlaybackRef = useRef(onReelPlaybackStarted);
  onPlaybackRef.current = onReelPlaybackStarted;

  const savedByYtId = useMemo(() => {
    const map = new Map<string, VideoItem>();
    for (const v of videos) {
      map.set(v.videoId, v);
    }
    return map;
  }, [videos]);

  const likedReels = useMemo<ReelItem[]>(() => {
    return videos
      .filter((v) => v.liked)
      .map((v) => ({
        videoId: v.videoId,
        title: v.title,
        authorName: v.authorName,
        viewText: 'Liked',
        thumbnailUrl: `https://i.ytimg.com/vi/${v.videoId}/oar2.jpg`,
        shortsUrl: `https://www.youtube.com/shorts/${v.videoId}`,
      }));
  }, [videos]);

  const fetchBatch = useCallback(
    async (targetTopic: string, pageNum: number, reset: boolean) => {
      if (targetTopic === 'liked') return;
      if (!isOnline || fetchingRef.current) return;
      fetchingRef.current = true;
      if (reset) {
        setLoadingInitial(true);
        setError(null);
      } else {
        setLoadingMore(true);
      }

      try {
        let attempts = 0;
        let currentPage = pageNum;
        let added: ReelItem[] = [];

        while (attempts < 2 && added.length === 0) {
          const resp = await fetch(
            `/api/youtube/reels?topic=${encodeURIComponent(targetTopic)}&page=${currentPage}`
          );
          const data = (await resp.json()) as {
            reels?: ReelItem[];
            nextPage?: number;
            error?: string;
          };
          if (!resp.ok) {
            throw new Error(data.error || 'Could not load Reels');
          }

          const batch = Array.isArray(data.reels) ? data.reels : [];
          const fresh = batch.filter((item) => !seenIdsRef.current.has(item.videoId));
          for (const item of fresh) {
            seenIdsRef.current.add(item.videoId);
          }
          added = fresh;
          currentPage = typeof data.nextPage === 'number' ? data.nextPage : currentPage + 1;
          attempts++;
        }

        if (added.length > 0) {
          setReels((prev) => {
            const next = reset ? added : [...prev, ...added];
            if (reset) setCachedReelsBatch(targetTopic, added, currentPage);
            return next;
          });
        }
        setNextPage(currentPage);
      } catch (err) {
        if (reset) {
          setError(err instanceof Error ? err.message : 'Failed to load Reels');
        }
      } finally {
        fetchingRef.current = false;
        setLoadingInitial(false);
        setLoadingMore(false);
      }
    },
    [isOnline]
  );

  // Switch cleanly between Liked local feed and online topic feeds (using warm cache)
  useEffect(() => {
    setTapForSoundHint(false);
    if (topic === 'liked') {
      seenIdsRef.current = new Set(likedReels.map((r) => r.videoId));
      setReels(likedReels);
      setActiveIndex(0);
      setLoadingInitial(false);
      setError(null);
      if (containerRef.current) containerRef.current.scrollTo({top: 0});
      return;
    }

    const cached = getCachedReelsBatch(topic);
    if (cached && cached.reels.length > 0) {
      seenIdsRef.current = new Set(cached.reels.map((r) => r.videoId));
      setReels(cached.reels);
      setNextPage(cached.nextPage);
      setActiveIndex(0);
      setLoadingInitial(false);
      setError(null);
      if (containerRef.current) containerRef.current.scrollTo({top: 0});
      return;
    }

    seenIdsRef.current = new Set();
    setReels([]);
    setActiveIndex(0);
    setNextPage(0);
    if (containerRef.current) containerRef.current.scrollTo({top: 0});
    if (isOnline) {
      fetchBatch(topic, 0, true);
    }
  }, [topic, isOnline, fetchBatch]);

  useEffect(() => {
    if (topic === 'liked') {
      setReels(likedReels);
    }
  }, [topic, likedReels]);

  useEffect(() => {
    if (reels.length > 0) {
      onPlaybackRef.current();
    }
  }, [activeIndex, reels.length]);

  // Preload upcoming thumbnail posters ahead of user scroll -> ZERO blank/black frames
  useEffect(() => {
    if (typeof Image === 'undefined' || reels.length === 0) return;
    const end = Math.min(reels.length, activeIndex + 7);
    for (let i = activeIndex + 1; i < end; i++) {
      const img = new Image();
      img.src = reels[i].thumbnailUrl;
    }
  }, [activeIndex, reels]);

  // Crisp, lag-free scroll index tracking
  useEffect(() => {
    const root = containerRef.current;
    if (!root || reels.length === 0) return;

    let rafId = 0;
    const handleScroll = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        const h = root.clientHeight;
        if (h > 0) {
          const idx = Math.max(0, Math.min(reels.length - 1, Math.round(root.scrollTop / h)));
          setActiveIndex((prev) => (prev === idx ? prev : idx));
        }
      });
    };

    root.addEventListener('scroll', handleScroll, {passive: true});
    return () => {
      root.removeEventListener('scroll', handleScroll);
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [reels.length]);

  // Endless auto-pagination: prefetch next batch 6 reels before reaching end
  useEffect(() => {
    if (
      topic !== 'liked' &&
      isOnline &&
      reels.length > 0 &&
      activeIndex >= reels.length - 6 &&
      !loadingMore
    ) {
      fetchBatch(topic, nextPage, false);
    }
  }, [activeIndex, reels.length, topic, nextPage, loadingMore, isOnline, fetchBatch]);

  const scrollToReel = useCallback(
    (index: number) => {
      const clamped = Math.max(0, Math.min(reels.length - 1, index));
      const root = containerRef.current;
      if (root && root.clientHeight > 0) {
        root.scrollTo({top: clamped * root.clientHeight, behavior: 'smooth'});
      } else {
        const el = slideRefs.current[clamped];
        if (el) el.scrollIntoView({behavior: 'smooth', block: 'start'});
      }
      setActiveIndex(clamped);
    },
    [reels.length]
  );

  // Desktop keyboard Up / Down navigation
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if (e.key === 'ArrowDown' || e.key.toLowerCase() === 'j') {
        e.preventDefault();
        scrollToReel(activeIndex + 1);
      } else if (e.key === 'ArrowUp' || e.key.toLowerCase() === 'k') {
        e.preventDefault();
        scrollToReel(activeIndex - 1);
      } else if (e.key.toLowerCase() === 'm') {
        e.preventDefault();
        setMuted((m) => !m);
        setTapForSoundHint(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeIndex, scrollToReel]);

  async function handleCopyShortUrl(reel: ReelItem) {
    try {
      await navigator.clipboard.writeText(reel.shortsUrl);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = reel.shortsUrl;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopiedId(reel.videoId);
    setTimeout(() => setCopiedId((prev) => (prev === reel.videoId ? null : prev)), 2000);
  }

  function showBriefNotice(msg: string) {
    setStatusNotice(msg);
    setTimeout(() => setStatusNotice((prev) => (prev === msg ? null : prev)), 3200);
  }

  return (
    <div className="relative -mx-2.5 sm:mx-0 -my-4 sm:-my-1 rounded-none sm:rounded-3xl overflow-hidden bg-black border-0 sm:border sm:border-slate-800 shadow-2xl h-[calc(100dvh-56px-56px)] md:h-[calc(100dvh-92px)]">
      {/* Top Floating Topic Bar + Auto-Advance Switch */}
      <div className="absolute top-0 inset-x-0 z-20 p-3 bg-gradient-to-b from-black/85 via-black/45 to-transparent pointer-events-none">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar pointer-events-auto">
            <div className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full bg-rose-600 text-white text-xs font-bold shrink-0 shadow">
              <Clapperboard className="w-3.5 h-3.5" />
              <span>Reels</span>
            </div>
            {REEL_TOPICS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTopic(t.id)}
                className={`px-3 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap shrink-0 transition-colors cursor-pointer ${
                  topic === t.id
                    ? 'bg-white text-black shadow'
                    : 'bg-white/15 hover:bg-white/25 text-white backdrop-blur-md'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => setAutoAdvance((v) => !v)}
            title={autoAdvance ? 'Auto-Scroll Next Reel: On' : 'Seamless Loop: On'}
            className={`pointer-events-auto px-2.5 py-1.5 rounded-full text-[11px] font-semibold whitespace-nowrap shrink-0 inline-flex items-center gap-1 backdrop-blur-md border transition-colors cursor-pointer ${
              autoAdvance
                ? 'bg-rose-600 border-rose-500 text-white'
                : 'bg-black/45 border-white/20 text-white/90 hover:bg-black/70'
            }`}
          >
            {autoAdvance ? <SkipForward className="w-3 h-3" /> : <Repeat className="w-3 h-3" />}
            <span className="hidden sm:inline">{autoAdvance ? 'Auto-Next' : 'Loop'}</span>
          </button>
        </div>
      </div>

      {/* Tap-for-sound fallback pill when mobile browser blocks unmuted autoplay */}
      {tapForSoundHint && (
        <button
          type="button"
          onClick={() => {
            setMuted(false);
            setTapForSoundHint(false);
          }}
          className="absolute top-16 left-1/2 -translate-x-1/2 z-30 px-3.5 py-1.5 rounded-full bg-rose-600 hover:bg-rose-700 text-white text-xs font-semibold shadow-lg inline-flex items-center gap-1.5 cursor-pointer animate-pulse"
        >
          <Volume2 className="w-3.5 h-3.5" />
          <span>Tap for Sound</span>
        </button>
      )}

      {statusNotice && (
        <div className="pointer-events-none absolute top-16 left-1/2 -translate-x-1/2 z-30 max-w-[90%] px-3.5 py-1.5 rounded-full bg-emerald-600/95 text-white text-xs font-semibold shadow-lg truncate">
          {statusNotice}
        </div>
      )}

      {!isOnline ? (
        <div className="h-full flex flex-col items-center justify-center p-6 text-center text-white space-y-3">
          <div className="w-12 h-12 rounded-2xl bg-amber-500/20 border border-amber-500/40 flex items-center justify-center text-amber-400">
            <WifiOff className="w-6 h-6" />
          </div>
          <h2 className="text-base font-semibold">Internet Disconnected</h2>
          <p className="text-xs text-slate-400 max-w-xs">
            Reconnect to stream endless vertical YouTube Shorts &amp; Reels.
          </p>
        </div>
      ) : loadingInitial && reels.length === 0 ? (
        <div className="h-full flex flex-col items-center justify-center text-white gap-3">
          <Loader2 className="w-7 h-7 animate-spin text-rose-500" />
          <span className="text-xs font-medium text-slate-300">Loading superfast Reels...</span>
        </div>
      ) : error && reels.length === 0 ? (
        <div className="h-full flex flex-col items-center justify-center p-6 text-center text-white space-y-3">
          <p className="text-sm text-rose-400">{error}</p>
          <button
            type="button"
            onClick={() => fetchBatch(topic, 0, true)}
            className="min-h-[40px] px-4 rounded-xl bg-rose-600 hover:bg-rose-700 text-xs font-semibold inline-flex items-center gap-2 cursor-pointer"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Retry</span>
          </button>
        </div>
      ) : reels.length === 0 && topic === 'liked' ? (
        <div className="h-full flex flex-col items-center justify-center p-6 text-center text-white space-y-3">
          <Heart className="w-9 h-9 text-rose-500 opacity-80" />
          <h2 className="text-base font-semibold">No Liked Reels Yet</h2>
          <p className="text-xs text-slate-400 max-w-xs">
            Tap Like on any Reel or video to keep it in your Liked list.
          </p>
        </div>
      ) : (
        /* Endless Vertical Snap-Scroll Feed */
        <div
          ref={containerRef}
          className="h-full w-full overflow-y-scroll snap-y snap-mandatory no-scrollbar overscroll-y-contain"
        >
          {reels.map((reel, idx) => {
            const isActive = idx === activeIndex;
            const isNearby = Math.abs(idx - activeIndex) <= 1;
            const savedItem = savedByYtId.get(reel.videoId);
            const alreadySaved = existingVideoIds.has(reel.videoId);
            const isCopied = copiedId === reel.videoId;

            const payload: SuggestedVideoInput = {
              videoId: reel.videoId,
              title: reel.title,
              authorName: reel.authorName,
            };

            return (
              <div
                key={`${reel.videoId}-${idx}`}
                ref={(el) => {
                  slideRefs.current[idx] = el;
                }}
                data-reel-index={idx}
                className="relative h-full w-full snap-start snap-always flex items-center justify-center bg-black overflow-hidden"
              >
                <div className="relative w-full h-full sm:w-auto sm:h-[calc(100%-24px)] sm:aspect-[9/16] sm:rounded-2xl overflow-hidden bg-black sm:border sm:border-white/10 shadow-2xl">
                  <ReelSlidePlayer
                    reel={reel}
                    isActive={isActive}
                    isNearby={isNearby}
                    isOnline={isOnline}
                    muted={muted}
                    autoAdvance={autoAdvance}
                    onRequestUnmuteHint={() => setTapForSoundHint(true)}
                    onEndedAdvance={() => {
                      if (idx + 1 < reels.length) scrollToReel(idx + 1);
                    }}
                    onPlaybackBlockedOrError={() => {
                      if (idx + 1 < reels.length) scrollToReel(idx + 1);
                    }}
                  />

                  {/* Bottom Title Scrim */}
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 h-32 bg-gradient-to-t from-black/90 via-black/45 to-transparent p-4 pr-16 flex flex-col justify-end">
                    <div className="text-xs font-semibold text-white line-clamp-2 leading-snug drop-shadow">
                      {reel.title}
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-[11px] text-white/75 font-mono">
                      <span>{reel.authorName}</span>
                      {reel.viewText && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span>{reel.viewText}</span>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Right-Side Vertical Reels Action Rail */}
                  <div className="absolute right-2.5 bottom-16 z-20 flex flex-col items-center gap-3">
                    <button
                      type="button"
                      onClick={() => {
                        if (savedItem) {
                          const willLike = !savedItem.liked;
                          onToggleLikeSaved(savedItem);
                          if (willLike) showBriefNotice('Added to Liked');
                        } else {
                          onSaveAndLikeReel(payload);
                          showBriefNotice('Liked & saved');
                        }
                      }}
                      aria-label={savedItem?.liked ? 'Liked reel' : 'Like & save reel'}
                      className="flex flex-col items-center gap-1 cursor-pointer group"
                    >
                      <span
                        className={`w-11 h-11 rounded-full backdrop-blur-md border flex items-center justify-center transition-transform active:scale-90 ${
                          savedItem?.liked
                            ? 'bg-rose-600 border-rose-500 text-white shadow-lg shadow-rose-600/35'
                            : 'bg-black/55 border-white/20 text-white hover:bg-black/80'
                        }`}
                      >
                        <Heart className={`w-5 h-5 ${savedItem?.liked ? 'fill-current' : ''}`} />
                      </span>
                      <span className="text-[10px] font-semibold text-white drop-shadow">
                        {savedItem?.liked ? 'Liked' : 'Like'}
                      </span>
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        onSaveReel(payload);
                        showBriefNotice('Saved to your Library!');
                      }}
                      aria-label={alreadySaved ? 'Saved in library' : 'Save reel'}
                      className="flex flex-col items-center gap-1 cursor-pointer"
                    >
                      <span
                        className={`w-11 h-11 rounded-full backdrop-blur-md border flex items-center justify-center transition-transform active:scale-90 ${
                          alreadySaved
                            ? 'bg-emerald-600 border-emerald-500 text-white'
                            : 'bg-black/55 border-white/20 text-white hover:bg-black/80'
                        }`}
                      >
                        {alreadySaved ? (
                          <Check className="w-5 h-5" />
                        ) : (
                          <Plus className="w-5 h-5" />
                        )}
                      </span>
                      <span className="text-[10px] font-semibold text-white drop-shadow">
                        {alreadySaved ? 'Saved' : 'Save'}
                      </span>
                    </button>

                    <button
                      type="button"
                      onClick={() => onPlayReelInMusic(payload)}
                      aria-label="Listen in Music mode"
                      className="flex flex-col items-center gap-1 cursor-pointer"
                    >
                      <span className="w-11 h-11 rounded-full bg-black/55 hover:bg-black/80 backdrop-blur-md border border-white/20 text-white flex items-center justify-center transition-transform active:scale-90">
                        <Headphones className="w-5 h-5" />
                      </span>
                      <span className="text-[10px] font-semibold text-white drop-shadow">
                        Audio
                      </span>
                    </button>

                    <button
                      type="button"
                      onClick={() => onOpenReelInPlayer(payload)}
                      aria-label="Open in full player"
                      className="flex flex-col items-center gap-1 cursor-pointer"
                    >
                      <span className="w-11 h-11 rounded-full bg-black/55 hover:bg-black/80 backdrop-blur-md border border-white/20 text-white flex items-center justify-center transition-transform active:scale-90">
                        <Maximize2 className="w-4 h-4" />
                      </span>
                      <span className="text-[10px] font-semibold text-white drop-shadow">
                        Player
                      </span>
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        setMuted((m) => !m);
                        setTapForSoundHint(false);
                      }}
                      aria-label={muted ? 'Unmute reel' : 'Mute reel'}
                      className="flex flex-col items-center gap-1 cursor-pointer"
                    >
                      <span className="w-10 h-10 rounded-full bg-black/55 hover:bg-black/80 backdrop-blur-md border border-white/20 text-white flex items-center justify-center">
                        {muted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
                      </span>
                    </button>

                    <button
                      type="button"
                      onClick={() => handleCopyShortUrl(reel)}
                      aria-label="Copy Shorts URL"
                      className="flex flex-col items-center gap-1 cursor-pointer"
                    >
                      <span className="w-10 h-10 rounded-full bg-black/55 hover:bg-black/80 backdrop-blur-md border border-white/20 text-white flex items-center justify-center">
                        {isCopied ? (
                          <Check className="w-4 h-4 text-emerald-400" />
                        ) : (
                          <Copy className="w-4 h-4" />
                        )}
                      </span>
                    </button>
                  </div>
                </div>

                {/* Desktop Side Scroll Arrows */}
                <div className="hidden md:flex flex-col gap-2 absolute right-6 top-1/2 -translate-y-1/2 z-20">
                  <button
                    type="button"
                    onClick={() => scrollToReel(idx - 1)}
                    disabled={idx === 0}
                    aria-label="Previous reel"
                    className="w-11 h-11 rounded-full bg-white/10 hover:bg-white/20 disabled:opacity-25 backdrop-blur-md border border-white/15 text-white flex items-center justify-center cursor-pointer"
                  >
                    <ChevronUp className="w-5 h-5" />
                  </button>
                  <div className="text-center font-mono text-[10px] text-white/60 tabular-nums">
                    {idx + 1}
                  </div>
                  <button
                    type="button"
                    onClick={() => scrollToReel(idx + 1)}
                    aria-label="Next reel"
                    className="w-11 h-11 rounded-full bg-white/10 hover:bg-white/20 backdrop-blur-md border border-white/15 text-white flex items-center justify-center cursor-pointer"
                  >
                    <ChevronDown className="w-5 h-5" />
                  </button>
                </div>
              </div>
            );
          })}

          {loadingMore && (
            <div className="h-24 flex items-center justify-center gap-2 text-xs text-white/70 bg-black">
              <Loader2 className="w-4 h-4 animate-spin text-rose-500" />
              <span>Loading more Reels...</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
