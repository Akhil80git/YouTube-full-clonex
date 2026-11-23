export interface MediaSessionHandlers {
  onPlay: () => void;
  onPause: () => void;
  onNext?: () => void;
  onPrev?: () => void;
  onSeekTo?: (seconds: number) => void;
  onSeekBy?: (deltaSeconds: number) => void;
  onStop?: () => void;
}

// Track last metadata & handler signature so we do NOT recreate MediaMetadata every 400ms
// (Recreating MediaMetadata repeatedly causes Android/Chrome notification cards to flicker/drop)
let lastMetaKey = '';
let lastPlaybackState: MediaSessionPlaybackState | null = null;
let handlersBound = false;
let latestHandlers: MediaSessionHandlers | null = null;

function createSilentWavBlobUrl(): string {
  // 1 second of 8kHz 8-bit unsigned mono PCM digital silence (128 = zero amplitude in 8-bit PCM)
  const sampleRate = 8000;
  const numSamples = sampleRate;
  const dataSize = numSamples;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) {
      view.setUint8(offset + i, s.charCodeAt(i));
    }
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // Mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true); // 8-bit
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);

  const bytes = new Uint8Array(buffer, 44);
  bytes.fill(128); // Digital silence

  return URL.createObjectURL(new Blob([buffer], {type: 'audio/wav'}));
}

export interface MediaNotificationAnchor {
  start: () => void;
  pause: () => void;
  stop: () => void;
  destroy: () => void;
}

/**
 * Keeps a silent top-level <audio loop> active while Music Mode plays so Android Chrome,
 * iOS Safari, and Desktop OS grant OS Notification Shade & Lock Screen Media Controls
 * (Next / Previous / Play / Pause / Seek) directly to TubeVault even when the screen locks
 * or the user switches to another app.
 */
export function createMediaNotificationAnchor(): MediaNotificationAnchor {
  if (typeof document === 'undefined' || typeof Audio === 'undefined') {
    return {
      start: () => {},
      pause: () => {},
      stop: () => {},
      destroy: () => {},
    };
  }

  let audio: HTMLAudioElement | null = null;
  let blobUrl: string | null = null;

  const ensureEl = () => {
    if (audio) return audio;
    blobUrl = createSilentWavBlobUrl();
    const el = document.createElement('audio');
    el.src = blobUrl;
    el.loop = true;
    el.preload = 'auto';
    // Must stay unmuted with tiny volume on pure digital-silence PCM so Android/Chrome shows the notification widget
    el.muted = false;
    el.volume = 0.05;
    el.setAttribute('playsinline', '');
    el.style.display = 'none';
    document.body.appendChild(el);
    audio = el;
    return el;
  };

  return {
    start: () => {
      try {
        const el = ensureEl();
        if (el.paused) {
          void el.play().catch(() => {});
        }
      } catch {
        // Ignore
      }
    },
    pause: () => {
      try {
        if (audio && !audio.paused) {
          audio.pause();
        }
      } catch {
        // Ignore
      }
    },
    stop: () => {
      try {
        if (audio) {
          audio.pause();
          audio.currentTime = 0;
        }
      } catch {
        // Ignore
      }
    },
    destroy: () => {
      try {
        if (audio) {
          audio.pause();
          audio.removeAttribute('src');
          audio.remove();
          audio = null;
        }
        if (blobUrl) {
          URL.revokeObjectURL(blobUrl);
          blobUrl = null;
        }
      } catch {
        // Ignore
      }
    },
  };
}

function bindMediaSessionHandlers(): void {
  if (handlersBound || typeof navigator === 'undefined' || !('mediaSession' in navigator)) {
    return;
  }
  const ms = navigator.mediaSession;
  const safeBind = (action: MediaSessionAction, fn: MediaSessionActionHandler | null) => {
    try {
      ms.setActionHandler(action, fn);
    } catch {
      // Action unsupported on this browser
    }
  };

  safeBind('play', () => latestHandlers?.onPlay());
  safeBind('pause', () => latestHandlers?.onPause());
  safeBind('nexttrack', () => latestHandlers?.onNext?.());
  safeBind('previoustrack', () => latestHandlers?.onPrev?.());
  safeBind('stop', () => {
    if (latestHandlers?.onStop) latestHandlers.onStop();
    else latestHandlers?.onPause();
  });
  safeBind('seekbackward', (details) => {
    latestHandlers?.onSeekBy?.(-(details.seekOffset || 10));
  });
  safeBind('seekforward', (details) => {
    latestHandlers?.onSeekBy?.(details.seekOffset || 10);
  });
  safeBind('seekto', (details) => {
    if (typeof details.seekTime === 'number') {
      latestHandlers?.onSeekTo?.(details.seekTime);
    }
  });
  handlersBound = true;
}

export function updateMediaSession(
  track: {
    videoId: string;
    title: string;
    authorName: string;
    collection?: string;
  } | null,
  state: {
    isPlaying: boolean;
    duration: number;
    currentTime: number;
    playbackRate: number;
  },
  handlers: MediaSessionHandlers,
  forceMetadata = false
): void {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;

  latestHandlers = handlers;
  const ms = navigator.mediaSession;

  if (!track) {
    lastMetaKey = '';
    lastPlaybackState = 'none';
    try {
      ms.playbackState = 'none';
      ms.metadata = null;
    } catch {
      // Ignore
    }
    return;
  }

  bindMediaSessionHandlers();

  try {
    const metaKey = `${track.videoId}|${track.title}|${track.authorName}|${track.collection || ''}`;
    if ((forceMetadata || metaKey !== lastMetaKey) && typeof MediaMetadata !== 'undefined') {
      lastMetaKey = metaKey;
      ms.metadata = new MediaMetadata({
        title: track.title,
        artist: track.authorName || 'YouTube',
        album: track.collection ? `TubeVault · ${track.collection}` : 'TubeVault Music',
        artwork: [
          {
            src: `https://i.ytimg.com/vi/${track.videoId}/hqdefault.jpg`,
            sizes: '480x360',
            type: 'image/jpeg',
          },
          {
            src: `https://i.ytimg.com/vi/${track.videoId}/maxresdefault.jpg`,
            sizes: '1280x720',
            type: 'image/jpeg',
          },
          {
            src: '/pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
          },
        ],
      });
    }

    const nextPlayState: MediaSessionPlaybackState = state.isPlaying ? 'playing' : 'paused';
    if (forceMetadata || lastPlaybackState !== nextPlayState) {
      lastPlaybackState = nextPlayState;
      ms.playbackState = nextPlayState;
    }

    if (
      typeof ms.setPositionState === 'function' &&
      Number.isFinite(state.duration) &&
      state.duration > 0
    ) {
      const clampedPos = Math.min(state.duration, Math.max(0, state.currentTime || 0));
      ms.setPositionState({
        duration: state.duration,
        playbackRate: state.playbackRate || 1,
        position: clampedPos,
      });
    }
  } catch {
    // Some browsers reject position updates during buffering
  }
}
