interface WakeLockSentinelLike {
  released: boolean;
  release(): Promise<void>;
  addEventListener(type: "release", listener: () => void): void;
}

interface NavigatorWithWakeLock {
  wakeLock?: {
    request(type: "screen"): Promise<WakeLockSentinelLike>;
  };
}

let wakeLockEnabled = true;
let sentinel: WakeLockSentinelLike | null = null;
let requesting = false;
let listenersInstalled = false;

async function acquireWakeLock(): Promise<void> {
  if (!wakeLockEnabled || requesting || document.visibilityState !== "visible") return;
  if (sentinel && !sentinel.released) return;
  const nav = navigator as unknown as NavigatorWithWakeLock;
  if (!nav.wakeLock || typeof nav.wakeLock.request !== "function") return;

  requesting = true;
  try {
    sentinel = await nav.wakeLock.request("screen");
    sentinel.addEventListener("release", () => {
      if (wakeLockEnabled && document.visibilityState === "visible") {
        void acquireWakeLock();
      }
    });
  } catch {
    // Browser may require a user gesture before granting the first wake lock;
    // the pointerdown/keydown listeners below will retry automatically.
  } finally {
    requesting = false;
  }
}

async function releaseWakeLock(): Promise<void> {
  const current = sentinel;
  sentinel = null;
  if (current && !current.released) {
    try {
      await current.release();
    } catch {
      // Ignore release errors
    }
  }
}

/** Enables or disables the Screen Wake Lock at runtime. */
export function setWakeLockEnabled(enabled: boolean): void {
  wakeLockEnabled = enabled;
  if (enabled) {
    void acquireWakeLock();
  } else {
    void releaseWakeLock();
  }
}

export function isWakeLockEnabled(): boolean {
  return wakeLockEnabled;
}

/**
 * Keeps the device screen awake while SlapRF is open on a phone, tablet, or laptop
 * using the W3C Screen Wake Lock API (`navigator.wakeLock.request("screen")`).
 *
 * Automatically re-acquires the lock after tab switches or user interactions when enabled.
 */
export function installWakeLock(): void {
  if (listenersInstalled) return;
  listenersInstalled = true;

  void acquireWakeLock();

  document.addEventListener("visibilitychange", () => {
    if (wakeLockEnabled && document.visibilityState === "visible") {
      void acquireWakeLock();
    }
  });

  const onUserGesture = (): void => {
    if (wakeLockEnabled && (!sentinel || sentinel.released)) {
      void acquireWakeLock();
    }
  };

  window.addEventListener("pointerdown", onUserGesture, { passive: true });
  window.addEventListener("touchstart", onUserGesture, { passive: true });
  window.addEventListener("keydown", onUserGesture, { passive: true });
}
