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

/**
 * Keeps the device screen awake while SlapRF is open on a phone, tablet, or laptop
 * using the W3C Screen Wake Lock API (`navigator.wakeLock.request("screen")`).
 *
 * Automatically re-acquires the lock after tab switches or user interactions.
 */
export function installWakeLock(): void {
  const nav = navigator as unknown as NavigatorWithWakeLock;
  if (!nav.wakeLock || typeof nav.wakeLock.request !== "function") {
    return;
  }

  let sentinel: WakeLockSentinelLike | null = null;
  let requesting = false;

  const acquire = async (): Promise<void> => {
    if (requesting || document.visibilityState !== "visible") return;
    if (sentinel && !sentinel.released) return;
    requesting = true;
    try {
      sentinel = await nav.wakeLock!.request("screen");
      sentinel.addEventListener("release", () => {
        if (document.visibilityState === "visible") {
          void acquire();
        }
      });
    } catch {
      // Browser may require a user gesture before granting the first wake lock;
      // the pointerdown/keydown listeners below will retry automatically.
    } finally {
      requesting = false;
    }
  };

  void acquire();

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      void acquire();
    }
  });

  const onUserGesture = (): void => {
    if (!sentinel || sentinel.released) {
      void acquire();
    }
  };

  window.addEventListener("pointerdown", onUserGesture, { passive: true });
  window.addEventListener("touchstart", onUserGesture, { passive: true });
  window.addEventListener("keydown", onUserGesture, { passive: true });
}
