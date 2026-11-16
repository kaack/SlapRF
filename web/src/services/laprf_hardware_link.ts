/**
 * LapRF 8-Way hardware & simulated connection manager.
 *
 * - Real Mode (SlapRF Server): delegates Ethernet TCP `:5403` and native USB CDC (`115200` baud)
 *   connections and `/24` LAN discovery directly to the native Go `laprfManager` (`/api/laprf/*`
 *   and `/api/laprf-discover`) — zero browser WebSerial or byte-relay.
 * - Simulation Mode (both Standalone Browser Demo & SlapRF Server): delegates LAN discovery and
 *   connect/disconnect to the simulated LapRF 8-Way units managed by `TrackSimulator`.
 */

import { ApiClient } from "./api_client";
import { capabilitiesSnapshot, openBackendConnectModal, resolveBackendUrl } from "./capabilities";
import { isBackendSerialPort, pickUsbPort } from "./sim_serial_port";
import { AppStore } from "../state/store";

const SAVED_TARGETS_KEY = "slaprf.laprf.targets.v1";

export interface LapRFDiscoveredDevice {
  host: string;
  port: number;
  label?: string;
  timerId?: number;
  connected?: boolean;
  voltageMv?: number;
}

export interface LapRFClientDiagSnapshot {
  timerId: number;
  label: string;
  transport: "ethernet" | "usb" | "sim";
  endpoint: string;
  connected: boolean;
  voltageMv: number;
  gateArmed: boolean;
  rtcSynced: boolean;
  rtcOffsetMs: number;
  framesRx: number;
  passingsRx: number;
  slotRssi: number[];
  slotFreqsMhz?: number[];
  slotThresholds?: number[];
  lastError?: string;
}

export interface SavedEthernetTarget {
  timerId: number;
  label: string;
  host: string;
  port: number;
}

type Listener = () => void;

export class LapRFHardwareLink {
  private readonly listeners = new Set<Listener>();
  private backendSnapshots: LapRFClientDiagSnapshot[] = [];
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
      const resp = await fetch(resolveBackendUrl("/api/laprf/status"), {
        method: "GET",
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (!resp.ok) return;
      const data = (await resp.json()) as {
        sessions?: LapRFClientDiagSnapshot[];
        savedTargets?: Array<{
          timerId: number;
          label: string;
          transport?: string;
          host?: string;
          port?: number;
        }>;
      };
      const next = Array.isArray(data.sessions) ? data.sessions : [];
      const changed = JSON.stringify(next) !== JSON.stringify(this.backendSnapshots);
      this.backendSnapshots = next;

      if (Array.isArray(data.savedTargets)) {
        const ethTargets: SavedEthernetTarget[] = data.savedTargets
          .filter((t) => (t.transport ?? "ethernet") === "ethernet" && t.host)
          .map((t) => ({
            timerId: t.timerId,
            label: t.label || `LapRF (${t.host})`,
            host: t.host!,
            port: t.port || 5403,
          }));
        try {
          window.localStorage.setItem(SAVED_TARGETS_KEY, JSON.stringify(ethTargets.slice(-6)));
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
        console.error("[LapRFHardwareLink] listener error:", err);
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

  public loadSavedTargets(): SavedEthernetTarget[] {
    try {
      const raw = window.localStorage.getItem(SAVED_TARGETS_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as SavedEthernetTarget[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private saveTarget(t: SavedEthernetTarget): void {
    try {
      const list = this.loadSavedTargets().filter(
        (x) => !(x.host === t.host && x.port === t.port) && x.timerId !== t.timerId
      );
      list.push(t);
      window.localStorage.setItem(SAVED_TARGETS_KEY, JSON.stringify(list.slice(-6)));
    } catch {
      // Ignore storage errors
    }
  }

  private removeSavedTarget(timerId: number): void {
    try {
      const list = this.loadSavedTargets().filter((x) => x.timerId !== timerId);
      window.localStorage.setItem(SAVED_TARGETS_KEY, JSON.stringify(list));
    } catch {
      // Ignore storage errors
    }
  }

  public async discover(
    store: AppStore,
    api: ApiClient
  ): Promise<{ subnet: string; devices: LapRFDiscoveredDevice[] }> {
    this.lastError = "";
    if (store.simulatorRunning) {
      return await api.simLapRFDiscover();
    }
    if (!capabilitiesSnapshot().portable) {
      openBackendConnectModal("real-hardware");
      throw new Error("Connect to a SlapRF Server to scan LAN for LapRF 8-Way hardware.");
    }
    await this.refreshStatus();
    const resp = await fetch(resolveBackendUrl("/api/laprf-discover"), {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    if (!resp.ok) {
      throw new Error(`LAN scan failed (${resp.status})`);
    }
    const data = (await resp.json()) as {
      subnet?: string;
      devices?: Array<{ host: string; port: number }>;
    };
    return {
      subnet: data.subnet || "LAN",
      devices: (data.devices ?? []).map((d, idx) => ({
        host: d.host,
        port: d.port || 5403,
        label: `LapRF (${d.host})`,
        connected: this.backendSnapshots.some(
          (s) => s.connected && s.endpoint === `${d.host}:${d.port || 5403}`
        ),
        timerId: idx + 2,
      })),
    };
  }

  public async connectEthernet(
    store: AppStore,
    api: ApiClient,
    host: string,
    port = 5403,
    label = ""
  ): Promise<void> {
    this.lastError = "";
    const cleanHost = host.trim() || "192.168.1.2";
    const cleanPort = port > 0 && port <= 65535 ? port : 5403;

    if (store.simulatorRunning) {
      try {
        await api.simLapRFAction({
          action: "connect-host",
          host: cleanHost,
          port: cleanPort,
          label: label.trim() || undefined,
        });
        this.notify();
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
        this.notify();
        throw err;
      }
      return;
    }

    if (!capabilitiesSnapshot().portable) {
      openBackendConnectModal("real-hardware");
      this.lastError = "Connect to a SlapRF Server to link physical LapRF 8-Way hardware.";
      this.notify();
      throw new Error(this.lastError);
    }

    const assignedLabel = label.trim() || `LapRF (${cleanHost})`;
    const resp = await fetch(resolveBackendUrl("/api/laprf/connect"), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        transport: "ethernet",
        host: cleanHost,
        port: cleanPort,
        label: assignedLabel,
      }),
    });
    const payload = (await resp.json().catch(() => ({}))) as {
      error?: string;
      session?: LapRFClientDiagSnapshot;
    };
    await this.refreshStatus();
    await api.refresh().catch(() => undefined);

    if (!resp.ok) {
      const errMsg = payload.error || `Unable to reach LapRF 8-Way at ${cleanHost}:${cleanPort}`;
      this.lastError = errMsg;
      this.notify();
      throw new Error(errMsg);
    }

    if (payload.session) {
      this.saveTarget({
        timerId: payload.session.timerId,
        label: payload.session.label || assignedLabel,
        host: cleanHost,
        port: cleanPort,
      });
    }
    this.notify();
  }

  public async connectUsb(store: AppStore, api: ApiClient): Promise<void> {
    this.lastError = "";
    if (store.simulatorRunning) {
      const units = store.simState?.laprfUnits ?? [];
      const target = units.find((u) => !u.connected && u.poweredOn) ?? units.find((u) => u.poweredOn) ?? units[0];
      if (target) {
        await api.simLapRFAction({ action: "connect", timerId: target.timerId });
      } else {
        await api.simLapRFAction({ action: "add" });
      }
      this.notify();
      return;
    }

    if (!capabilitiesSnapshot().portable) {
      openBackendConnectModal("real-hardware");
      this.lastError = "Connect to a SlapRF Server to open physical USB serial ports.";
      this.notify();
      throw new Error(this.lastError);
    }

    const selected = await pickUsbPort({ showAllPorts: true });
    if (!isBackendSerialPort(selected)) {
      throw new Error("Expected a native OS USB port from SlapRF Server.");
    }

    const resp = await fetch(resolveBackendUrl("/api/laprf/connect"), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        transport: "usb",
        portName: selected.portName,
        label: `LapRF (${selected.portName})`,
      }),
    });
    const payload = (await resp.json().catch(() => ({}))) as {
      error?: string;
      session?: LapRFClientDiagSnapshot;
    };
    await this.refreshStatus();
    await api.refresh().catch(() => undefined);

    if (!resp.ok) {
      const errMsg = payload.error || `Failed to open LapRF 8-Way on ${selected.portName}`;
      this.lastError = errMsg;
      this.notify();
      throw new Error(errMsg);
    }
    this.notify();
  }

  public async disconnect(store: AppStore, api: ApiClient, timerId: number): Promise<void> {
    if (store.simulatorRunning) {
      await api.simLapRFAction({ action: "disconnect", timerId });
      this.notify();
      return;
    }
    this.removeSavedTarget(timerId);
    if (capabilitiesSnapshot().portable) {
      await fetch(resolveBackendUrl("/api/laprf/disconnect"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timerId }),
      }).catch(() => undefined);
      await this.refreshStatus();
    }
    await api.refresh().catch(() => undefined);
    this.notify();
  }

  public snapshots(store: AppStore): LapRFClientDiagSnapshot[] {
    if (store.simulatorRunning) {
      const units = store.simState?.laprfUnits ?? [];
      return units
        .filter((u) => u.connected)
        .map((u) => ({
          timerId: u.timerId,
          label: u.label,
          transport: "sim" as const,
          endpoint: `${u.host}:${u.port}`,
          connected: u.poweredOn && u.connected,
          voltageMv: !u.poweredOn ? 0 : u.voltageMv,
          gateArmed: u.poweredOn && u.gateArmed,
          rtcSynced: u.poweredOn && u.connected,
          rtcOffsetMs: u.rtcDeltaMs ?? 0,
          framesRx: 0,
          passingsRx: 0,
          slotRssi: Array.isArray(u.slotRssi) ? u.slotRssi : [0, 0, 0, 0, 0, 0, 0, 0],
          slotFreqsMhz: Array.isArray(u.slotFreqsMhz) ? u.slotFreqsMhz : [],
          slotThresholds: Array.isArray(u.slotThresholds) ? u.slotThresholds : [],
        })) as LapRFClientDiagSnapshot[];
    }
    return this.backendSnapshots;
  }
}

export const sharedLapRFLink = new LapRFHardwareLink();
