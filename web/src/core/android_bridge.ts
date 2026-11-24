/**
 * Typed accessors for the optional `@JavascriptInterface` (`window.SlapRFAndroid`)
 * injected when SlapRF runs inside the native Android host shell (`SlapRFHost.java`).
 *
 * Returns `null` / `false` in standard desktop and mobile web browsers.
 */

export interface AndroidLanStatus {
  enabled: boolean;
  port: number;
  urls: string[];
  error?: string;
}

export interface SlapRFAndroidBridge {
  isAndroidApp(): boolean;
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

interface WindowWithAndroidBridge {
  SlapRFAndroid?: SlapRFAndroidBridge;
}

export function getAndroidBridge(): SlapRFAndroidBridge | null {
  if (typeof window === "undefined") return null;
  const b = (window as unknown as WindowWithAndroidBridge).SlapRFAndroid;
  if (!b || typeof b.isAndroidApp !== "function") return null;
  try {
    return b.isAndroidApp() ? b : null;
  } catch {
    return null;
  }
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
 * Triggers a binary file save using Android's native `ACTION_CREATE_DOCUMENT` dialog when inside
 * the Android app, or falls back to a standard `<a download>` Blob link in web browsers.
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
 * Triggers a file save using Android's native `ACTION_CREATE_DOCUMENT` dialog when inside
 * the Android app, or falls back to a standard `<a download>` Blob link in web browsers.
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
