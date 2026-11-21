/**
 * RotorHazard timing device connection manager (Native Go Server + Simulation).
 *
 * - Real Mode (SlapRF Server):
 *   Delegates HTTP Basic Auth + Engine.IO v4 / Socket.IO v4 sessions (`:5000`) and `/24` LAN
 *   discovery directly to the native Go `rhManager` (`/v1/rh/*`), with
 *   zero browser mixed-content barriers and zero browser frame relay.
 *
 * - Simulation Mode (both Standalone Browser Demo & SlapRF Server):
 *   Delegates LAN discovery and multi-device connect/disconnect to `TrackSimulator`
 *   (`/v1/sim/rh/*`), where each virtual RotorHazard device runs
 *   `rotorhazard.SimServer` <-> `Client`.
 */

import { AppStore } from "../state/store";
import { ApiClient } from "./api_client";
import { capabilitiesSnapshot, openBackendConnectModal, resolveBackendUrl } from "./capabilities";

const SAVED_RH_TARGETS_KEY = "slaprf.rh.targets.v1";

export const DEFAULT_RH_PORT = 5000;
export const DEFAULT_RH_ADMIN_USER = "admin";
export const DEFAULT_RH_ADMIN_PASS = "rotorhazard";

export interface RHDiscoveredDevice {
  host: string;
  port: number;
  transport?: "websocket" | "usb";
  portName?: string;
  baudRate?: number;
  apiLevel?: number;
  label?: string;
  timerId?: number;
  nodeCount?: number;
  serverVersion?: string;
  connected?: boolean;
}

export interface RHUSBPortInfo {
  name: string;
  isUsb?: boolean;
  vid?: string;
  pid?: string;
  serialNumber?: string;
  product?: string;
  isEspressif?: boolean;
  label?: string;
  timerId?: number;
  nodeCount?: number;
  baudRate?: number;
  apiLevel?: number;
  connected?: boolean;
}

export interface RHClientDiagSnapshot {
  timerId: number;
  label: string;
  transport: "websocket" | "usb" | "sim";
  endpoint: string;
  portName?: string;
  baudRate?: number;
  apiLevel?: number;
  connected: boolean;
  authOk: boolean;
  authKnown: boolean;
  serverVersion: string;
  serverHostname?: string;
  nodeCount: number;
  gateArmed: boolean;
  clockSynced: boolean;
  clockOffsetMs: number;
  heartbeatsRx: number;
  passesRx: number;
  slotRssi: number[];
  crossingFlag: boolean[];
  nodeEnterLevels: number[];
  nodeExitLevels: number[];
  nodeFreqsMhz: number[];
  cpuTempC?: number;
  envSummary?: string;
  lastError?: string;
  scanLive?: boolean;
  lastScan?: {
    seq: number;
    start: number;
    stop: number;
    step: number;
    passMs: number;
    live: boolean;
    partial?: boolean;
    values: number[];
  };
}

export interface SavedRHTarget {
  timerId: number;
  label: string;
  transport?: "websocket" | "usb";
  host: string;
  port: number;
  adminUser: string;
  portName?: string;
  baudRate?: number;
}

/**
 * Splits an Engine.IO HTTP polling body into individual packets.
 * Supports Engine.IO v4 `\x1e` record-separator framing and legacy Engine.IO v3 `<len>:<packet>` framing.
 */
export function splitEngineIOPayload(raw: string): string[] {
  if (!raw) return [];
  if (raw.includes("\x1e")) {
    return raw.split("\x1e").filter((p) => p.length > 0);
  }
  const colon = raw.indexOf(":");
  if (colon > 0 && colon <= 8 && /^\d+$/.test(raw.slice(0, colon))) {
    const out: string[] = [];
    let i = 0;
    while (i < raw.length) {
      const cIdx = raw.indexOf(":", i);
      if (cIdx <= i || cIdx - i > 8) break;
      const lenStr = raw.slice(i, cIdx);
      if (!/^\d+$/.test(lenStr)) return [raw];
      const pktLen = Number(lenStr);
      if (!Number.isFinite(pktLen) || pktLen < 0 || cIdx + 1 + pktLen > raw.length) {
        return [raw];
      }
      if (pktLen > 0) {
        out.push(raw.slice(cIdx + 1, cIdx + 1 + pktLen));
      }
      i = cIdx + 1 + pktLen;
    }
    if (out.length > 0) return out;
  }
  return [raw];
}

export function encodeBasicAuth(username: string, password: string): string {
  const raw = `${username}:${password}`;
  try {
    const bytes = new TextEncoder().encode(raw);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) {
      bin += String.fromCharCode(bytes[i]);
    }
    return btoa(bin);
  } catch {
    return btoa(raw);
  }
}

export function isHttpsMixedContentTarget(pageProtocol: string, targetHost: string): boolean {
  if (pageProtocol !== "https:") return false;
  const h = targetHost.trim().toLowerCase();
  return h !== "localhost" && h !== "127.0.0.1" && h !== "[::1]";
}

type Listener = () => void;

export class RotorHazardHardwareLink {
  private readonly listeners = new Set<Listener>();
  private backendSnapshots: RHClientDiagSnapshot[] = [];
  private pollTimer: number | null = null;
  private pollInFlight = false;
  private lastError = "";

  public subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    this.ensurePolling();
    return () => {
      this.listeners.delete(fn);
      if (this.listeners.size === 0 && this.pollTimer !== null) {
        window.clearInterval(this.pollTimer);
        this.pollTimer = null;
      }
    };
  }

  /** Subscribes to link state notifications without starting a background poll timer on its own. */
  public onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private ensurePolling(): void {
    if (this.pollTimer !== null || typeof window === "undefined") return;
    void this.refreshStatus();
    this.pollTimer = window.setInterval(() => {
      void this.refreshStatus();
    }, 1500);
  }

  public async refreshStatus(): Promise<void> {
    if (!capabilitiesSnapshot().portable || this.pollInFlight) return;
    this.pollInFlight = true;
    try {
      const resp = await fetch(resolveBackendUrl("/v1/rh/sessions"), {
        method: "GET",
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (!resp.ok) return;
      const data = (await resp.json()) as {
        sessions?: RHClientDiagSnapshot[];
        savedTargets?: SavedRHTarget[];
      };
      const next = Array.isArray(data.sessions) ? data.sessions : [];
      const changed = JSON.stringify(next) !== JSON.stringify(this.backendSnapshots);
      this.backendSnapshots = next;

      if (Array.isArray(data.savedTargets)) {
        try {
          window.localStorage.setItem(SAVED_RH_TARGETS_KEY, JSON.stringify(data.savedTargets.slice(-6)));
        } catch {
          // Ignore storage errors
        }
      }

      if (changed) {
        this.notify();
      }
    } catch {
      // Ignore transient network errors while polling
    } finally {
      this.pollInFlight = false;
    }
  }

  private notify(): void {
    this.listeners.forEach((fn) => {
      try {
        fn();
      } catch (err) {
        console.error("[RotorHazardHardwareLink] listener error:", err);
      }
    });
  }

  public get errorMessage(): string {
    return this.lastError;
  }

  public clearError(): void {
    if (!this.lastError) return;
    this.lastError = "";
    this.notify();
  }

  public loadSavedTargets(): SavedRHTarget[] {
    try {
      const raw = window.localStorage.getItem(SAVED_RH_TARGETS_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as SavedRHTarget[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private saveTarget(t: SavedRHTarget): void {
    try {
      const list = this.loadSavedTargets().filter(
        (x) => !(x.host === t.host && x.port === t.port) && x.timerId !== t.timerId
      );
      list.push(t);
      window.localStorage.setItem(SAVED_RH_TARGETS_KEY, JSON.stringify(list.slice(-6)));
    } catch {
      // Ignore storage errors
    }
  }

  private removeSavedTarget(timerId: number): void {
    try {
      const list = this.loadSavedTargets().filter((x) => x.timerId !== timerId);
      window.localStorage.setItem(SAVED_RH_TARGETS_KEY, JSON.stringify(list));
    } catch {
      // Ignore storage errors
    }
  }

  public async scanLan(
    store: AppStore,
    api: ApiClient,
    port = DEFAULT_RH_PORT
  ): Promise<{ subnet: string; devices: RHDiscoveredDevice[] }> {
    this.lastError = "";
    if (store.simulatorRunning) {
      const res = await api.simRotorHazardDiscover();
      this.notify();
      return res;
    }

    const caps = capabilitiesSnapshot();
    if (!caps.portable) {
      openBackendConnectModal("real-hardware");
      throw new Error("Connect to a SlapRF Server to scan LAN for RotorHazard devices.");
    }

    await this.refreshStatus();
    const resp = await fetch(
      resolveBackendUrl(`/v1/rh/devices?port=${encodeURIComponent(String(port || DEFAULT_RH_PORT))}`),
      {
        method: "GET",
        headers: { Accept: "application/json" },
      }
    );
    if (!resp.ok) {
      throw new Error(`LAN scan failed (HTTP ${resp.status})`);
    }
    const data = (await resp.json()) as {
      subnet: string;
      devices: Array<{ host: string; port: number; sid?: string }>;
    };
    const connectedEps = new Set(
      this.backendSnapshots.filter((s) => s.connected).map((s) => s.endpoint)
    );
    const devices: RHDiscoveredDevice[] = (data.devices ?? []).map((d, idx) => {
      const ep = `${d.host}:${d.port || DEFAULT_RH_PORT}`;
      return {
        host: d.host,
        port: d.port || DEFAULT_RH_PORT,
        label: `R${idx + 1}`,
        connected: connectedEps.has(ep),
      };
    });
    this.notify();
    return { subnet: data.subnet || "LAN", devices };
  }

  public async connectDevice(
    store: AppStore,
    api: ApiClient,
    opts: {
      host: string;
      port?: number;
      adminUser?: string;
      adminPass?: string;
      preferredLabel?: string;
      preferredTimerId?: number;
    }
  ): Promise<void> {
    const cleanHost = opts.host.trim();
    const cleanPort = opts.port && opts.port > 0 ? Math.round(opts.port) : DEFAULT_RH_PORT;
    const adminUser = (opts.adminUser ?? DEFAULT_RH_ADMIN_USER).trim();
    const adminPass = opts.adminPass ?? DEFAULT_RH_ADMIN_PASS;

    if (!cleanHost) {
      this.lastError = "Enter a RotorHazard IP address or hostname (e.g. 192.168.1.101).";
      this.notify();
      throw new Error(this.lastError);
    }

    this.lastError = "";
    if (store.simulatorRunning) {
      await api.simRotorHazardAction({
        action: "connect-host",
        host: cleanHost,
        port: cleanPort,
        label: opts.preferredLabel,
        adminUser,
        adminPass,
      });
      this.notify();
      return;
    }

    if (!capabilitiesSnapshot().portable) {
      openBackendConnectModal("real-hardware");
      this.lastError = "Connect to a SlapRF Server to link physical RotorHazard devices.";
      this.notify();
      throw new Error(this.lastError);
    }

    const resp = await fetch(resolveBackendUrl("/v1/rh/sessions"), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        timerId: opts.preferredTimerId ?? 0,
        label: opts.preferredLabel?.trim() || "",
        host: cleanHost,
        port: cleanPort,
        adminUser,
        adminPass,
      }),
    });
    const payload = (await resp.json().catch(() => ({}))) as {
      error?: string;
      session?: RHClientDiagSnapshot;
    };
    await this.refreshStatus();
    await api.refresh().catch(() => undefined);

    if (!resp.ok) {
      const msg = payload.error || `Could not connect to RotorHazard device at ${cleanHost}:${cleanPort}.`;
      this.lastError = msg;
      this.notify();
      throw new Error(msg);
    }

    if (payload.session) {
      this.saveTarget({
        timerId: payload.session.timerId,
        label: payload.session.label,
        host: cleanHost,
        port: cleanPort,
        adminUser,
      });
    }
    this.notify();
  }

  public async listUSBPorts(store: AppStore, showAll = false): Promise<RHUSBPortInfo[]> {
    if (store.simulatorRunning) {
      const units = store.simState?.rotorhazardUnits ?? [];
      return units
        .filter((u) => u.poweredOn)
        .map((u, idx) => {
          const portName = u.portName?.trim() || `SIM-RH-USB${idx + 1}`;
          const rawLbl = u.label?.trim() || "";
          const normLabel = rawLbl
            ? /^rh(\d+)$/i.test(rawLbl)
              ? `R${rawLbl.slice(2)}`
              : rawLbl
            : `R${Math.max(1, u.timerId - 1)}`;
          return {
            name: portName,
            isUsb: true,
            product: `Simulated RotorHazard USB (${u.nodeCount === 4 ? 4 : 8} nodes)`,
            label: normLabel,
            timerId: u.timerId,
            nodeCount: u.nodeCount === 4 ? 4 : 8,
            baudRate: u.baudRate || 115200,
            apiLevel: u.apiLevel || 36,
            connected: Boolean(u.poweredOn && u.connected),
          };
        });
    }

    if (!capabilitiesSnapshot().portable) {
      return [];
    }

    const resp = await fetch(
      resolveBackendUrl(`/v1/usb/ports?transport=usb${showAll ? "&all=1" : ""}`),
      {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!resp.ok) {
      throw new Error(`USB port enumeration failed (HTTP ${resp.status})`);
    }
    const data = (await resp.json()) as {
      ports?: Array<{
        name: string;
        isUsb?: boolean;
        vid?: string;
        pid?: string;
        serialNumber?: string;
        product?: string;
        isEspressif?: boolean;
      }>;
    };
    const connectedPorts = new Set(
      this.backendSnapshots
        .filter((s) => s.connected && s.transport === "usb")
        .map((s) => (s.portName || s.endpoint).toUpperCase())
    );
    return (data.ports ?? []).map((p) => ({
      ...p,
      connected: connectedPorts.has(p.name.toUpperCase()),
    }));
  }

  public async connectUSBDevice(
    store: AppStore,
    api: ApiClient,
    opts: {
      portName: string;
      baudRate?: number;
      preferredLabel?: string;
      preferredTimerId?: number;
    }
  ): Promise<void> {
    const cleanPort = opts.portName.trim();
    const baudRate = opts.baudRate && opts.baudRate > 0 ? Math.round(opts.baudRate) : 0;

    if (!cleanPort) {
      this.lastError = "Select a RotorHazard USB serial port to connect.";
      this.notify();
      throw new Error(this.lastError);
    }

    this.lastError = "";
    if (store.simulatorRunning) {
      await api.simRotorHazardAction({
        action: "connect-port",
        portName: cleanPort,
        baudRate: baudRate || undefined,
        label: opts.preferredLabel,
      });
      this.notify();
      return;
    }

    if (!capabilitiesSnapshot().portable) {
      openBackendConnectModal("real-hardware");
      this.lastError = "Connect to a SlapRF Server to link physical RotorHazard USB devices.";
      this.notify();
      throw new Error(this.lastError);
    }

    const resp = await fetch(resolveBackendUrl("/v1/rh/sessions"), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        transport: "usb",
        timerId: opts.preferredTimerId ?? 0,
        label: opts.preferredLabel?.trim() || "",
        portName: cleanPort,
        baudRate,
      }),
    });
    const payload = (await resp.json().catch(() => ({}))) as {
      error?: string;
      session?: RHClientDiagSnapshot;
    };
    await this.refreshStatus();
    await api.refresh().catch(() => undefined);

    if (!resp.ok) {
      const msg = payload.error || `Could not connect to RotorHazard USB node on ${cleanPort}.`;
      this.lastError = msg;
      this.notify();
      throw new Error(msg);
    }

    if (payload.session) {
      this.saveTarget({
        timerId: payload.session.timerId,
        label: payload.session.label,
        transport: "usb",
        host: "",
        port: 0,
        adminUser: "",
        portName: cleanPort,
        baudRate: payload.session.baudRate || baudRate || 115200,
      });
    }
    this.notify();
  }

  public async disconnectDevice(
    store: AppStore,
    api: ApiClient,
    timerId: number
  ): Promise<void> {
    this.lastError = "";
    if (store.simulatorRunning) {
      await api.simRotorHazardAction({ action: "disconnect", timerId });
      this.notify();
      return;
    }

    this.removeSavedTarget(timerId);
    if (capabilitiesSnapshot().portable) {
      await fetch(resolveBackendUrl(`/v1/rh/sessions/${encodeURIComponent(String(timerId))}`), {
        method: "DELETE",
      }).catch(() => undefined);
      await this.refreshStatus();
    }
    await api.refresh().catch(() => undefined);
    this.notify();
  }

  public async runUSBScan(
    store: AppStore,
    api: ApiClient | undefined,
    opts: {
      timerId: number;
      mode: "once" | "live" | "stop";
      start: number;
      stop: number;
      step: number;
    }
  ): Promise<{
    ok: boolean;
    scanLive?: boolean;
    scan?: {
      seq: number;
      start: number;
      stop: number;
      step: number;
      passMs: number;
      live: boolean;
      values: number[];
    };
  }> {
    this.lastError = "";
    if (store.simulatorRunning) {
      if (!api) {
        throw new Error("Missing API client for simulated RotorHazard USB scan.");
      }
      const res = await api.runRHUSBScan(opts);
      await api.pollStatusNow().catch(() => undefined);
      this.notify();
      return res;
    }

    if (!capabilitiesSnapshot().portable) {
      openBackendConnectModal("real-hardware");
      throw new Error("Connect to a SlapRF Server to run spectrum scans on RotorHazard USB devices.");
    }

    const resp = await fetch(
      resolveBackendUrl(`/v1/rh/sessions/${encodeURIComponent(String(opts.timerId))}:scan`),
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          mode: opts.mode,
          start: opts.start,
          stop: opts.stop,
          step: opts.step,
        }),
      }
    );
    const payload = (await resp.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      scanLive?: boolean;
      scan?: {
        seq: number;
        start: number;
        stop: number;
        step: number;
        passMs: number;
        live: boolean;
        values: number[];
      };
    };
    await this.refreshStatus();
    if (!resp.ok) {
      const msg = payload.error || `RotorHazard USB spectrum scan failed (HTTP ${resp.status}).`;
      this.lastError = msg;
      this.notify();
      throw new Error(msg);
    }
    return {
      ok: true,
      scanLive: payload.scanLive,
      scan: payload.scan,
    };
  }

  public snapshots(store: AppStore): RHClientDiagSnapshot[] {
    const wantUSB = store.timingHardwareMode === "rotorhazard_usb";
    if (store.simulatorRunning) {
      const units = store.simState?.rotorhazardUnits ?? [];
      return units.map((u, idx) => {
        const nCount = u.nodeCount === 4 ? 4 : 8;
        const rawLbl = u.label?.trim() || "";
        const normLabel = rawLbl
          ? /^rh(\d+)$/i.test(rawLbl)
            ? `R${rawLbl.slice(2)}`
            : rawLbl
          : `R${Math.max(1, u.timerId - 1)}`;
        const isUSB = wantUSB || u.transport === "usb";
        const usbPort = u.portName?.trim() || `SIM-RH-USB${idx + 1}`;
        const apiLevel = u.apiLevel || 36;
        const baudRate = u.baudRate || 115200;
        return {
          timerId: u.timerId,
          label: normLabel,
          transport: isUSB ? ("usb" as const) : ("sim" as const),
          endpoint: isUSB ? usbPort : `${u.host || "192.168.1.101"}:${u.port || DEFAULT_RH_PORT}`,
          portName: isUSB ? usbPort : undefined,
          baudRate: isUSB ? baudRate : undefined,
          apiLevel: isUSB ? apiLevel : undefined,
          connected: u.poweredOn && u.connected,
          authOk: isUSB ? true : u.authOk,
          authKnown: true,
          serverVersion: isUSB ? u.serverVersion || `API ${apiLevel}` : u.serverVersion || "4.5.1",
          serverHostname: isUSB ? "" : u.serverHostname || "",
          nodeCount: nCount,
          gateArmed: u.poweredOn && u.gateArmed,
          clockSynced: u.poweredOn && u.connected,
          clockOffsetMs: u.clockDeltaMs ?? 0,
          heartbeatsRx: u.heartbeatsRx ?? 0,
          passesRx: u.passesRx ?? 0,
          slotRssi: Array.isArray(u.slotRssi) ? u.slotRssi : [0, 0, 0, 0, 0, 0, 0, 0],
          crossingFlag: Array.isArray(u.crossingFlag)
            ? u.crossingFlag
            : [false, false, false, false, false, false, false, false],
          nodeEnterLevels: Array.isArray(u.nodeEnterLevels) ? u.nodeEnterLevels : [],
          nodeExitLevels: Array.isArray(u.nodeExitLevels) ? u.nodeExitLevels : [],
          nodeFreqsMhz: Array.isArray(u.nodeFreqsMhz) ? u.nodeFreqsMhz : [],
          cpuTempC: u.cpuTempC,
          envSummary: u.envSummary,
          scanLive: Boolean(u.scanLive),
          lastScan: u.lastScan,
        };
      });
    }
    return this.backendSnapshots.filter((s) =>
      wantUSB ? s.transport === "usb" : s.transport !== "usb"
    );
  }
}

export const sharedRHLink = new RotorHazardHardwareLink();
