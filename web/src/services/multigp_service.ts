/**
 * MultiGP WebService (`v1.0.4`) client for SlapRF.
 *
 * - When `store.simulatorRunning === true` (both Hosted Browser & SlapRF Portable):
 *   routes all MultiGP WebService calls to the in-memory `SimBackend` (`/v1/sim/multigp/*`),
 *   keeping simulated credentials isolated from real chapter credentials.
 * - When `store.simulatorRunning === false` in SlapRF Portable:
 *   routes calls through the local Go reverse proxy (`/v1/race/multigp/proxy/*`) to
 *   `https://www.multigp.com/mgp/multigpwebservice/*`.
 */

import {
  MultiGPRaceEntry,
  MultiGPRaceSchedule,
  MultiGPRaceSummary,
  MultiGPRaceViewData,
  MultiGPSyncPlan,
  PilotCSVImportSummary,
} from "../types/models";
import { AppStore } from "../state/store";
import { ApiClient } from "./api_client";
import { capabilitiesSnapshot, openBackendConnectModal, resolveBackendUrl } from "./capabilities";

const SIM_PREFS_KEY = "slaprf.mgp.sim.v1";
const REAL_PREFS_KEY = "slaprf.mgp.real.v1";
export const DEFAULT_SIM_MGP_API_KEY = "MGP-SIM-BAYAREA-2026";

export interface MultiGPStoredPrefs {
  apiKey: string;
  chapterId: number;
  chapterName: string;
  verified: boolean;
  autoPushOnConfirm: boolean;
  userEdited?: boolean;
}

const DEFAULT_SIM_PREFS: MultiGPStoredPrefs = {
  apiKey: DEFAULT_SIM_MGP_API_KEY,
  chapterId: 1042,
  chapterName: "Bay Area FPV",
  verified: true,
  autoPushOnConfirm: false,
  userEdited: false,
};

const DEFAULT_REAL_PREFS: MultiGPStoredPrefs = {
  apiKey: "",
  chapterId: 0,
  chapterName: "",
  verified: false,
  autoPushOnConfirm: false,
};

export function formatMultiGPScoring(fmt: number): string {
  switch (fmt) {
    case 0:
      return "Aggregate Laps";
    case 1:
      return "Fastest Lap";
    case 2:
      return "Fastest 3 Consecutive";
    case 6:
      return "Fastest 2 Consecutive";
    default:
      return `Format #${fmt}`;
  }
}

type Listener = () => void;

export class MultiGPService {
  private simPrefs: MultiGPStoredPrefs = { ...DEFAULT_SIM_PREFS };
  private realPrefs: MultiGPStoredPrefs = { ...DEFAULT_REAL_PREFS };
  private readonly listeners = new Set<Listener>();

  constructor() {
    this.loadPrefs();
  }

  public subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    this.listeners.forEach((fn) => {
      try {
        fn();
      } catch (err) {
        console.error("[MultiGPService] listener error:", err);
      }
    });
  }

  private loadPrefs(): void {
    try {
      const sRaw = window.localStorage.getItem(SIM_PREFS_KEY);
      if (sRaw) {
        const p = JSON.parse(sRaw) as Partial<MultiGPStoredPrefs>;
        this.simPrefs = { ...DEFAULT_SIM_PREFS, ...p };
      }
    } catch {
      // Ignore storage errors
    }
    try {
      const rRaw = window.localStorage.getItem(REAL_PREFS_KEY);
      if (rRaw) {
        const p = JSON.parse(rRaw) as Partial<MultiGPStoredPrefs>;
        this.realPrefs = { ...DEFAULT_REAL_PREFS, ...p };
      }
    } catch {
      // Ignore storage errors
    }
  }

  private savePrefs(isSim: boolean): void {
    try {
      if (isSim) {
        window.localStorage.setItem(SIM_PREFS_KEY, JSON.stringify(this.simPrefs));
      } else {
        window.localStorage.setItem(REAL_PREFS_KEY, JSON.stringify(this.realPrefs));
      }
    } catch {
      // Ignore storage errors
    }
  }

  public reloadPrefs(): void {
    this.simPrefs = { ...DEFAULT_SIM_PREFS };
    this.realPrefs = { ...DEFAULT_REAL_PREFS };
    this.loadPrefs();
    this.notify();
  }

  public resetDefaults(isSim: boolean, store?: AppStore): void {
    if (isSim) {
      this.simPrefs = {
        ...DEFAULT_SIM_PREFS,
        apiKey: store?.simMultiGP?.apiKey || DEFAULT_SIM_MGP_API_KEY,
        chapterId: store?.simMultiGP?.chapterId || DEFAULT_SIM_PREFS.chapterId,
        chapterName: store?.simMultiGP?.chapterName || DEFAULT_SIM_PREFS.chapterName,
        verified: true,
        autoPushOnConfirm: false,
        userEdited: false,
      };
      this.savePrefs(true);
    } else {
      this.realPrefs = { ...DEFAULT_REAL_PREFS };
      this.savePrefs(false);
    }
    this.notify();
  }

  public prefsFor(isSim: boolean, store?: AppStore): MultiGPStoredPrefs {
    if (isSim) {
      if (store?.simMultiGP && !this.simPrefs.userEdited) {
        if (store.simMultiGP.apiKey) {
          this.simPrefs.apiKey = store.simMultiGP.apiKey;
        }
        if (store.simMultiGP.chapterName) {
          this.simPrefs.chapterName = store.simMultiGP.chapterName;
        }
        if (store.simMultiGP.chapterId) {
          this.simPrefs.chapterId = store.simMultiGP.chapterId;
        }
        this.simPrefs.verified = true;
      } else if (
        store?.simMultiGP &&
        this.simPrefs.verified &&
        this.simPrefs.apiKey === store.simMultiGP.apiKey &&
        this.simPrefs.chapterName !== store.simMultiGP.chapterName
      ) {
        this.simPrefs.chapterName = store.simMultiGP.chapterName;
      }
      return { ...this.simPrefs };
    }
    return { ...this.realPrefs };
  }

  public getPrefs(store: AppStore): MultiGPStoredPrefs {
    return this.prefsFor(store.simulatorRunning, store);
  }

  public setApiKey(isSim: boolean, apiKey: string): void {
    const clean = apiKey.trim();
    if (isSim) {
      if (this.simPrefs.apiKey !== clean || !this.simPrefs.userEdited) {
        this.simPrefs.apiKey = clean;
        this.simPrefs.verified = false;
        this.simPrefs.userEdited = true;
        this.savePrefs(true);
        this.notify();
      }
    } else {
      if (this.realPrefs.apiKey !== clean) {
        this.realPrefs.apiKey = clean;
        this.realPrefs.verified = false;
        this.savePrefs(false);
        this.notify();
      }
    }
  }

  public setAutoPushOnConfirm(isSim: boolean, enabled: boolean): void {
    if (isSim) {
      this.simPrefs.autoPushOnConfirm = enabled;
      this.savePrefs(true);
    } else {
      this.realPrefs.autoPushOnConfirm = enabled;
      this.savePrefs(false);
    }
    this.notify();
  }

  public isAvailable(store: AppStore): boolean {
    return store.simulatorRunning || capabilitiesSnapshot().portable;
  }

  private async postWebService<T>(
    store: AppStore,
    api: ApiClient,
    subPath: string,
    body: unknown
  ): Promise<T> {
    if (store.simulatorRunning) {
      try {
        return await api.simMultiGPWebService<T>(subPath, body);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const braceIdx = msg.indexOf("{");
        if (braceIdx >= 0) {
          try {
            const parsed = JSON.parse(msg.slice(braceIdx)) as Record<string, unknown>;
            if (typeof parsed.status === "boolean") {
              return parsed as T;
            }
          } catch {
            // Fall through to rethrow original error
          }
        }
        throw err;
      }
    }
    if (!capabilitiesSnapshot().portable) {
      openBackendConnectModal("real-hardware");
      throw new Error("Connect to a SlapRF Server to sync with live MultiGP chapters (or enable Simulation active).");
    }
    const resp = await fetch(resolveBackendUrl(`/v1/race/multigp/proxy/${subPath}`), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      throw new Error(`MultiGP HTTP ${resp.status}${txt ? `: ${txt.slice(0, 140)}` : ""}`);
    }
    return (await resp.json()) as T;
  }

  private resolveKey(store: AppStore, explicitKey?: string): string {
    if (explicitKey !== undefined) return explicitKey.trim();
    const prefs = this.prefsFor(store.simulatorRunning, store);
    return prefs.apiKey.trim();
  }

  public async verifyChapterKey(
    store: AppStore,
    api: ApiClient,
    explicitKey?: string
  ): Promise<{ chapterId: number; chapterName: string }> {
    const isSim = store.simulatorRunning;
    const key = this.resolveKey(store, explicitKey);
    if (!key) {
      throw new Error("Enter a MultiGP Chapter API Key first.");
    }
    const res = await this.postWebService<{
      status: boolean;
      statusDescription?: string;
      chapterId?: number | string;
      chapterName?: string;
    }>(store, api, "chapter/findChapterFromApiKey", { apiKey: key });

    if (!res.status) {
      if (isSim) {
        this.simPrefs.verified = false;
        this.savePrefs(true);
      } else {
        this.realPrefs.verified = false;
        this.savePrefs(false);
      }
      this.notify();
      throw new Error(res.statusDescription || "Invalid MultiGP Chapter API Key.");
    }

    const chapterId = Number(res.chapterId ?? 0) || 0;
    const chapterName = (res.chapterName || "MultiGP Chapter").trim();
    if (isSim) {
      this.simPrefs = {
        ...this.simPrefs,
        apiKey: key,
        chapterId,
        chapterName,
        verified: true,
      };
      this.savePrefs(true);
    } else {
      this.realPrefs = {
        ...this.realPrefs,
        apiKey: key,
        chapterId,
        chapterName,
        verified: true,
      };
      this.savePrefs(false);
    }
    this.notify();
    return { chapterId, chapterName };
  }

  public async listRaces(store: AppStore, api: ApiClient): Promise<MultiGPRaceSummary[]> {
    const key = this.resolveKey(store);
    if (!key) {
      throw new Error("Configure your MultiGP Chapter API Key in Settings first.");
    }
    const res = await this.postWebService<{
      status: boolean;
      statusDescription?: string;
      data?: MultiGPRaceSummary[];
    }>(store, api, "race/listForChapter", { apiKey: key });
    if (!res.status) {
      throw new Error(res.statusDescription || "Failed to list chapter races from MultiGP.");
    }
    return Array.isArray(res.data) ? res.data : [];
  }

  public async importChapterPilots(
    store: AppStore,
    api: ApiClient
  ): Promise<PilotCSVImportSummary & { chapterName: string }> {
    const key = this.resolveKey(store);
    if (!key) {
      throw new Error("Configure your MultiGP Chapter API Key in Settings first.");
    }
    const prefs = this.getPrefs(store);
    let chapterName = prefs.chapterName || "MultiGP Chapter";
    const entries: MultiGPRaceEntry[] = [];
    const seenIds = new Set<number>();
    const seenNames = new Set<string>();
    const pushEntry = (ent: MultiGPRaceEntry) => {
      const pid = Number(ent.pilotId ?? 0) || 0;
      const uname = (ent.userName || ent.displayName || "").trim();
      if (!pid && !uname) return;
      if (pid > 0 && seenIds.has(pid)) return;
      const nKey = uname.toLowerCase();
      if (nKey && seenNames.has(nKey)) return;
      if (pid > 0) seenIds.add(pid);
      if (nKey) seenNames.add(nKey);
      entries.push({ ...ent, pilotId: pid, userName: uname });
    };

    try {
      const res = await this.postWebService<{
        status: boolean;
        statusDescription?: string;
        chapterName?: string;
        data?: MultiGPRaceEntry[];
      }>(store, api, "pilot/listForChapter", { apiKey: key });
      if (res.status && Array.isArray(res.data)) {
        if (res.chapterName) chapterName = res.chapterName;
        for (const ent of res.data) pushEntry(ent);
      }
    } catch {
      // Fallback to gathering chapter pilots across chapter races below if live endpoint is unavailable
    }

    if (entries.length === 0) {
      const races = await this.listRaces(store, api);
      for (const r of races.slice(0, 8)) {
        try {
          const v = await this.viewRace(store, api, r.id);
          if (v.chapterName) chapterName = v.chapterName;
          for (const ent of v.entries ?? []) pushEntry(ent);
        } catch {
          // continue
        }
      }
    }

    const summary = await api.multiGPImportPilots(entries);
    return { ...summary, chapterName };
  }

  public async viewRace(
    store: AppStore,
    api: ApiClient,
    mgpRaceId: number | string
  ): Promise<MultiGPRaceViewData> {
    const key = this.resolveKey(store);
    if (!key) {
      throw new Error("Configure your MultiGP Chapter API Key in Settings first.");
    }
    const res = await this.postWebService<{
      status: boolean;
      statusDescription?: string;
      data?: MultiGPRaceViewData;
    }>(store, api, `race/view?id=${encodeURIComponent(String(mgpRaceId))}`, { apiKey: key });
    if (!res.status || !res.data) {
      throw new Error(res.statusDescription || `Failed to load MultiGP race #${mgpRaceId}.`);
    }
    return res.data;
  }

  public async pullZippyQRounds(
    store: AppStore,
    api: ApiClient,
    slaprfRaceId: string,
    mgpRaceId: number,
    fromCycle = 1,
    fromHeat = 1
  ): Promise<{ addedHeats: number; cycleCount: number }> {
    const key = this.resolveKey(store);
    if (!key) {
      throw new Error("Configure your MultiGP Chapter API Key in Settings first.");
    }
    const res = await this.postWebService<{
      status: boolean;
      statusDescription?: string;
      cycleCount?: number;
      data?: MultiGPRaceSchedule;
    }>(
      store,
      api,
      `race/getAdditionalRounds?id=${mgpRaceId}&cycle=${Math.max(1, fromCycle)}&heat=${Math.max(
        1,
        fromHeat
      )}`,
      { apiKey: key }
    );
    if (!res.status) {
      throw new Error(res.statusDescription || "Failed to pull ZippyQ rounds from MultiGP.");
    }
    const rounds = res.data?.rounds ?? [];
    const appended = await api.multiGPAppendZippyQ(slaprfRaceId, rounds);
    return {
      addedHeats: appended.addedHeats,
      cycleCount: res.cycleCount ?? rounds.length,
    };
  }

  public async pushSyncPlan(
    store: AppStore,
    api: ApiClient,
    plan: MultiGPSyncPlan,
    onProgress?: (done: number, total: number, label: string) => void
  ): Promise<{ slotsPushed: number; overallPushed: boolean; mgpRaceId: number }> {
    const key = this.resolveKey(store);
    if (!key) {
      throw new Error("Configure and verify your MultiGP Chapter API Key in Settings first.");
    }
    const prefs = this.prefsFor(store.simulatorRunning, store);
    if (!prefs.verified) {
      throw new Error("Your MultiGP Chapter connection has not been verified yet.");
    }

    let targetRaceId = plan.mgpRaceId;
    const ops = plan.operations ?? [];
    const hasOverall = Array.isArray(plan.overallResults) && plan.overallResults.length > 0;
    const needsCreate = !targetRaceId || targetRaceId <= 0;
    const totalSteps = (needsCreate ? 1 : 0) + ops.length + (hasOverall ? 1 : 0);
    let step = 0;

    if (needsCreate) {
      step++;
      const raceTitle = (plan.mgpRaceName || "SlapRF Race").trim();
      onProgress?.(step, Math.max(1, totalSteps), `Creating race "${raceTitle}" on MultiGP…`);
      const created = await this.postWebService<{
        status: boolean;
        statusDescription?: string;
        raceId?: number;
        data?: { id?: number; name?: string };
      }>(store, api, "race/create", {
        apiKey: key,
        data: {
          name: raceTitle,
        },
      });
      const resolvedId = Number(created.raceId ?? created.data?.id ?? 0);
      if (!created.status || !Number.isFinite(resolvedId) || resolvedId <= 0) {
        throw new Error(
          created.statusDescription ||
            "Unable to create a new race on MultiGP. Ensure the race exists on MultiGP or check your Chapter API permissions."
        );
      }
      targetRaceId = resolvedId;
      plan.mgpRaceId = targetRaceId;
    }

    const syncedHeatSet = new Set<string>();
    for (const op of ops) {
      step++;
      onProgress?.(step, Math.max(1, totalSteps), `${op.heatTitle} · Slot ${op.slot} (${op.callsign})`);
      const res = await this.postWebService<{ status: boolean; statusDescription?: string }>(
        store,
        api,
        `race/assignSlot?id=${targetRaceId}&cycle=${op.cycle}&heat=${op.heat}&slot=${op.slot}`,
        {
          apiKey: key,
          data: {
            ...op.data,
            pilotCallsign: op.callsign,
          },
        }
      );
      if (!res.status) {
        throw new Error(
          res.statusDescription ||
            `MultiGP assignSlot failed on Round ${op.cycle} Heat ${op.heat} Slot ${op.slot}`
        );
      }
      if (op.heatId) syncedHeatSet.add(op.heatId);
    }

    let overallPushed = false;
    if (hasOverall && plan.overallResults) {
      step++;
      onProgress?.(step, Math.max(1, totalSteps), "Overall podium standings");
      const res = await this.postWebService<{ status: boolean; statusDescription?: string }>(
        store,
        api,
        `race/captureOverallRaceResult?id=${targetRaceId}`,
        {
          apiKey: key,
          data: {
            raceId: targetRaceId,
            bracketResults: plan.overallResults,
          },
        }
      );
      if (!res.status) {
        throw new Error(res.statusDescription || "MultiGP captureOverallRaceResult failed.");
      }
      overallPushed = true;
    }

    await api.multiGPMarkSynced(plan.raceId, Array.from(syncedHeatSet), overallPushed, {
      mgpRaceId: targetRaceId,
      mgpRaceName: plan.mgpRaceName || "SlapRF Race",
      chapterId: prefs.chapterId,
      chapterName: prefs.chapterName,
    });
    if (store.simulatorRunning) {
      await api.pollStatusNow().catch(() => undefined);
    }
    return { slotsPushed: ops.length, overallPushed, mgpRaceId: targetRaceId };
  }
}

export const sharedMultiGPService = new MultiGPService();
