/**
 * Typed accessors for the native mobile host bridge injected inside:
 * - Android WebView (`SlapRFHost.java` -> `@JavascriptInterface window.SlapRFAndroid`)
 * - iOS / iPadOS WKWebView (`SlapRFViewController.swift` -> `WKUserScript window.SlapRFNative`
 *   and/or `window.webkit.messageHandlers.slaprf` + `__slaprf_sync__:` prompt bridge).
 *
 * Returns `null` / `false` in standard desktop and mobile web browsers.
 */

export type NativeHostPlatform = "android" | "ios";

export interface AndroidLanStatus {
  enabled: boolean;
  port: number;
  urls: string[];
  error?: string;
}

export interface SlapRFAndroidBridge {
  platform?: string;
  isAndroidApp(): boolean;
  isIosApp?(): boolean;
  speak(text: string, rate: number, volume: number, flush: boolean): void;
  stopSpeech(): void;
  isSpeaking(): boolean;
  playBeep?(freqHz: number, durationMs: number, volume: number): void;
  setKeepScreenOn(enabled: boolean): void;
  setThemeMode(mode: string): void;
  getLanStatusJson(): string;
  setLanEnabled(enabled: boolean): string;
  saveBase64File(filename: string, mimeType: string, base64Data: string): void;
  getStringPref?(key: string): string;
  setStringPref?(key: string, value: string): void;
}

interface WebKitMessageHandler {
  postMessage(message: unknown): void;
}

interface WindowWithNativeBridges {
  SlapRFNative?: SlapRFAndroidBridge;
  SlapRFAndroid?: SlapRFAndroidBridge;
  webkit?: {
    messageHandlers?: {
      slaprf?: WebKitMessageHandler;
    };
  };
}

const IOS_SYNC_PROMPT_PREFIX = "__slaprf_sync__:";

let cachedWebKitFallbackBridge: SlapRFAndroidBridge | null = null;
let cachedWebKitHandlerRef: WebKitMessageHandler | null = null;

function createWebKitBridge(handler: WebKitMessageHandler): SlapRFAndroidBridge {
  const post = (msg: Record<string, unknown>): void => {
    try {
      handler.postMessage(msg);
    } catch {
      // Ignore WebKit IPC failures
    }
  };
  const syncCall = (msg: Record<string, unknown>): string => {
    if (typeof window === "undefined" || typeof window.prompt !== "function") return "";
    try {
      const res = window.prompt(IOS_SYNC_PROMPT_PREFIX + JSON.stringify(msg), "");
      return typeof res === "string" ? res : "";
    } catch {
      return "";
    }
  };
  return {
    platform: "ios",
    isAndroidApp: () => true,
    isIosApp: () => true,
    speak: (text: string, rate: number, volume: number, flush: boolean) => {
      post({ op: "speak", text, rate, volume, flush });
    },
    stopSpeech: () => post({ op: "stopSpeech" }),
    isSpeaking: () => syncCall({ op: "isSpeaking" }) === "1",
    playBeep: (freqHz: number, durationMs: number, volume: number) => {
      post({ op: "playBeep", freqHz, durationMs, volume });
    },
    setKeepScreenOn: (enabled: boolean) => post({ op: "setKeepScreenOn", enabled }),
    setThemeMode: (mode: string) => post({ op: "setThemeMode", mode }),
    getLanStatusJson: () => syncCall({ op: "getLanStatusJson" }),
    setLanEnabled: (enabled: boolean) => syncCall({ op: "setLanEnabled", enabled }),
    getStringPref: (key: string) => syncCall({ op: "getStringPref", key }),
    setStringPref: (key: string, value: string) => post({ op: "setStringPref", key, value }),
    saveBase64File: (filename: string, mimeType: string, base64Data: string) => {
      post({ op: "saveBase64File", filename, mimeType, base64Data });
    },
  };
}

export function getAndroidBridge(): SlapRFAndroidBridge | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as WindowWithNativeBridges;
  const direct = w.SlapRFNative ?? w.SlapRFAndroid;
  if (direct && typeof direct.isAndroidApp === "function") {
    try {
      if (direct.isAndroidApp()) return direct;
    } catch {
      // Fall through to WebKit handler check
    }
  }
  const wkHandler = w.webkit?.messageHandlers?.slaprf;
  if (wkHandler && typeof wkHandler.postMessage === "function") {
    if (cachedWebKitHandlerRef !== wkHandler || !cachedWebKitFallbackBridge) {
      cachedWebKitHandlerRef = wkHandler;
      cachedWebKitFallbackBridge = createWebKitBridge(wkHandler);
    }
    return cachedWebKitFallbackBridge;
  }
  return null;
}

export function getNativeHostPlatform(): NativeHostPlatform | null {
  const b = getAndroidBridge();
  if (!b) return null;
  try {
    if (b.platform === "ios" || (typeof b.isIosApp === "function" && b.isIosApp())) {
      return "ios";
    }
  } catch {
    // Default to android
  }
  return "android";
}

export function isIosHostApp(): boolean {
  return getNativeHostPlatform() === "ios";
}

export function isNativeHostApp(): boolean {
  return getAndroidBridge() !== null;
}

export function isAndroidHostApp(): boolean {
  return getAndroidBridge() !== null;
}

export function getAndroidLanStatus(): AndroidLanStatus | null {
  const b = getAndroidBridge();
  if (!b) return null;
  try {
    const raw = b.getLanStatusJson();
    if (!raw) return { enabled: false, port: 0, urls: [] };
    const parsed = JSON.parse(raw) as Partial<AndroidLanStatus>;
    return {
      enabled: Boolean(parsed.enabled),
      port: typeof parsed.port === "number" ? parsed.port : 0,
      urls: Array.isArray(parsed.urls) ? parsed.urls.filter((u): u is string => typeof u === "string") : [],
      error: typeof parsed.error === "string" ? parsed.error : undefined,
    };
  } catch {
    return { enabled: false, port: 0, urls: [] };
  }
}

export function setAndroidLanEnabled(enabled: boolean): AndroidLanStatus | null {
  const b = getAndroidBridge();
  if (!b) return null;
  try {
    const raw = b.setLanEnabled(enabled);
    if (!raw) return getAndroidLanStatus();
    const parsed = JSON.parse(raw) as Partial<AndroidLanStatus>;
    return {
      enabled: Boolean(parsed.enabled),
      port: typeof parsed.port === "number" ? parsed.port : 0,
      urls: Array.isArray(parsed.urls) ? parsed.urls.filter((u): u is string => typeof u === "string") : [],
      error: typeof parsed.error === "string" ? parsed.error : undefined,
    };
  } catch {
    return getAndroidLanStatus();
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function utf8ToBase64(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text));
}

/**
 * Triggers a binary file save using the native mobile host export dialog when inside
 * the Android or iOS app, or falls back to a standard `<a download>` Blob link in web browsers.
 */
export function downloadBinaryFile(filename: string, mimeType: string, bytes: Uint8Array): void {
  const b = getAndroidBridge();
  if (b) {
    try {
      b.saveBase64File(filename, mimeType, bytesToBase64(bytes));
      return;
    } catch {
      // Fall through to standard anchor download if bridge call fails
    }
  }
  const blob = new Blob([bytes], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Triggers a file save using the native mobile host export dialog when inside
 * the Android or iOS app, or falls back to a standard `<a download>` Blob link in web browsers.
 */
export function downloadTextFile(filename: string, mimeType: string, content: string): void {
  const b = getAndroidBridge();
  if (b) {
    try {
      b.saveBase64File(filename, mimeType, utf8ToBase64(content));
      return;
    } catch {
      // Fall through to standard anchor download if bridge call fails
    }
  }
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
