import { esc } from "../core/format";
import { icons } from "../core/icons";
import { showToast } from "./Toast";
import { ApiClient } from "../services/api_client";
import {
  DEFAULT_SIM_MGP_API_KEY,
  formatMultiGPScoring,
  sharedMultiGPService,
} from "../services/multigp_service";
import { AppStore } from "../state/store";
import {
  MultiGPRaceSummary,
  MultiGPRaceViewData,
  MultiGPSyncPlan,
  RaceTournamentState,
} from "../types/models";

let activeMultiGPModalCleanup: (() => void) | null = null;

export function closeActiveMultiGPModal(): void {
  activeMultiGPModalCleanup?.();
}

type ImportMode = "schedule" | "bracket";

export function openMultiGPImportModal(
  store: AppStore,
  api: ApiClient,
  onImported: (created: RaceTournamentState) => void
): void {
  if (activeMultiGPModalCleanup) {
    activeMultiGPModalCleanup();
  }

  const backdrop = document.createElement("div");
  backdrop.className = "slaprf-modal-backdrop";
  backdrop.setAttribute("role", "dialog");
  backdrop.setAttribute("aria-modal", "true");
  backdrop.setAttribute("aria-label", "Download race from MultiGP");

  let loadingList = false;
  let loadingDetail = false;
  let importing = false;
  let verifyingKey = false;
  let errorMsg = "";
  let races: MultiGPRaceSummary[] = [];
  let selectedRaceId = "";
  let selectedDetail: MultiGPRaceViewData | null = null;
  let importMode: ImportMode = "schedule";
  let bracketTemplate = "double_elimination";

  const curPrefs = () => sharedMultiGPService.prefsFor(store.simulatorRunning, store);
  let draftApiKey =
    curPrefs().apiKey ||
    (store.simulatorRunning ? store.simMultiGP?.apiKey || DEFAULT_SIM_MGP_API_KEY : "");

  const cleanup = (): void => {
    window.removeEventListener("keydown", onKeyDown, true);
    if (backdrop.parentNode) {
      backdrop.parentNode.removeChild(backdrop);
    }
    if (activeMultiGPModalCleanup === cleanup) {
      activeMultiGPModalCleanup = null;
    }
  };
  activeMultiGPModalCleanup = cleanup;

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape" && !importing) {
      e.preventDefault();
      e.stopPropagation();
      cleanup();
    }
  };
  window.addEventListener("keydown", onKeyDown, true);

  const selectAndLoadDetail = async (id: string): Promise<void> => {
    selectedRaceId = id;
    selectedDetail = null;
    loadingDetail = true;
    errorMsg = "";
    render();
    try {
      const detail = await sharedMultiGPService.viewRace(store, api, id);
      if (selectedRaceId !== id) return;
      selectedDetail = detail;
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : String(err);
    } finally {
      if (selectedRaceId === id) {
        loadingDetail = false;
        render();
      }
    }
  };

  const loadRacesList = async (): Promise<void> => {
    loadingList = true;
    errorMsg = "";
    render();
    try {
      const list = await sharedMultiGPService.listRaces(store, api);
      races = list;
      if (races.length > 0) {
        const keep = races.find((r) => String(r.id) === selectedRaceId) ?? races[0];
        await selectAndLoadDetail(String(keep.id));
      } else {
        selectedRaceId = "";
        selectedDetail = null;
      }
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : String(err);
    } finally {
      loadingList = false;
      render();
    }
  };

  const render = (): void => {
    const isSim = store.simulatorRunning;
    const prefs = curPrefs();
    const hasKey = Boolean(prefs.apiKey || (isSim && store.simMultiGP?.apiKey));
    const chapterTitle =
      prefs.chapterName || (isSim ? store.simMultiGP?.chapterName || "Bay Area FPV" : "Chapter");

    const keyBarHtml =
      !hasKey || !prefs.verified
        ? `<div class="card" style="padding:12px;margin-bottom:12px;display:flex;flex-direction:column;gap:8px">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap">
              <strong>MultiGP Chapter API Key</strong>
              ${
                isSim
                  ? `<button type="button" class="btn btn-ghost btn-xs" data-mgp-use-sim-key>Use simulated key</button>`
                  : ""
              }
            </div>
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
              <input
                type="text"
                class="input input-sm mono"
                style="flex:1 1 240px"
                data-mgp-key-input
                placeholder="${isSim ? esc(store.simMultiGP?.apiKey || DEFAULT_SIM_MGP_API_KEY) : "Paste Chapter API Key…"}"
                value="${esc(draftApiKey)}"
                autocomplete="off"
              />
              <button type="button" class="btn btn-armed btn-sm" data-mgp-verify-key ${verifyingKey ? "disabled" : ""}>
                ${icons.check(13)}<span>${verifyingKey ? "Verifying…" : "Verify & Load"}</span>
              </button>
            </div>
          </div>`
        : `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px;flex-wrap:wrap">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
              <span class="note">Chapter: <strong>${esc(chapterTitle)}</strong></span>
            </div>
            <button type="button" class="btn btn-ghost btn-xs" data-mgp-refresh ${loadingList ? "disabled" : ""}>
              ${icons.reset(12)}<span>${loadingList ? "Loading…" : "Refresh"}</span>
            </button>
          </div>`;

    const racesColGroupHtml = `<colgroup>
      <col style="width:74px" />
      <col />
      <col style="width:110px" />
      <col style="width:165px" />
      <col style="width:120px" />
    </colgroup>`;

    const listHtml = loadingList
      ? `<div class="note" style="padding:18px 8px">Loading chapter races from MultiGP…</div>`
      : races.length === 0
        ? `<div class="note" style="padding:18px 8px">${
            hasKey
              ? "No races found for this MultiGP chapter."
              : "Verify your Chapter API Key above to browse MultiGP races."
          }</div>`
        : `<div class="table-scroll mgp-modal-table-scroll is-races-download">
            <div class="mgp-modal-table-inner is-races-download">
              <div class="mgp-modal-table-head-wrap">
                <table class="table rc-compact-table mgp-modal-table mgp-modal-head-table">
                  ${racesColGroupHtml}
                  <thead>
                    <tr>
                      <th>ID</th>
                      <th>Race</th>
                      <th>Type</th>
                      <th>Scoring</th>
                      <th>Entries</th>
                    </tr>
                  </thead>
                </table>
              </div>
              <div class="mgp-modal-table-body-wrap">
                <table class="table rc-compact-table mgp-modal-table mgp-modal-body-table">
                  ${racesColGroupHtml}
                  <tbody>
                    ${races
                      .map((r) => {
                        const idStr = String(r.id);
                        const sel = idStr === selectedRaceId;
                        const zippy = r.disableSlotAutoPopulation === 1;
                        return `
                          <tr class="${sel ? "is-selected-row" : ""}" style="cursor:pointer" data-mgp-select-race="${esc(idStr)}">
                            <td class="mono">#${esc(idStr)}</td>
                            <td><strong>${esc(r.name)}</strong></td>
                            <td><span class="badge">${zippy ? "ZippyQ" : "Controlled"}</span></td>
                            <td class="note">${esc(formatMultiGPScoring(r.scoringFormat))}</td>
                            <td class="mono note">${r.pilotCount}p · ${r.cycleCount}r</td>
                          </tr>`;
                      })
                      .join("")}
                  </tbody>
                </table>
              </div>
            </div>
          </div>`;

    let detailHtml = "";
    if (loadingDetail) {
      detailHtml = `<div class="note" style="padding:10px 4px">Loading race schedule &amp; pilot entries…</div>`;
    } else if (selectedDetail) {
      const d = selectedDetail;
      const roundCount = d.schedule?.rounds?.length ?? 0;
      const heatCount = (d.schedule?.rounds ?? []).reduce(
        (acc, r) => acc + (r.heats?.length ?? 0),
        0
      );
      detailHtml = `
        <div class="card" style="padding:12px;display:flex;flex-direction:column;gap:10px">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap">
            <div>
              <strong>#${d.id} · ${esc(d.name)}</strong>
              <div class="note">${d.entries?.length ?? 0} registered pilots · ${roundCount} round${roundCount === 1 ? "" : "s"} (${heatCount} heat${heatCount === 1 ? "" : "s"}) · ${esc(formatMultiGPScoring(d.scoringFormat))}</div>
            </div>
            <span class="badge mono">${d.maxLaps > 0 ? `${d.maxLaps} laps` : "Timed"} · ${d.raceTimeSec || 120}s</span>
          </div>

          <div style="display:flex;flex-direction:column;gap:6px">
            <span class="note" style="font-weight:600">Download mode</span>
            <div class="segmented" role="radiogroup" aria-label="MultiGP download mode" style="width:fit-content;max-width:100%;flex-wrap:wrap">
              <button type="button" class="${importMode === "schedule" ? "is-active" : ""}" data-mgp-import-mode="schedule">
                Schedule &amp; Pilots
              </button>
              <button type="button" class="${importMode === "bracket" ? "is-active" : ""}" data-mgp-import-mode="bracket">
                Custom Brackets
              </button>
            </div>
            <span class="note">${
              importMode === "schedule"
                ? "Downloads MultiGP rounds, heats, VTX channels, and pilots as-is for 1:1 heat slot sync back to MultiGP."
                : "Downloads MultiGP pilots only into your custom brackets and syncs final podium standings back to MultiGP."
            }</span>
          </div>

          ${
            importMode === "bracket"
              ? `<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
                  <label class="note" for="mgp-bkt-tpl-select">Bracket template</label>
                  <select id="mgp-bkt-tpl-select" class="input input-sm" style="width:auto;min-width:220px" data-mgp-bracket-tpl>
                    <option value="double_elimination" ${bracketTemplate === "double_elimination" ? "selected" : ""}>Double Elimination</option>
                    <option value="qualifying_to_double_elim" ${bracketTemplate === "qualifying_to_double_elim" ? "selected" : ""}>Qualifying → Double Elimination</option>
                    <option value="chase_the_ace" ${bracketTemplate === "chase_the_ace" ? "selected" : ""}>Chase the Ace Finals</option>
                    <option value="single_elimination" ${bracketTemplate === "single_elimination" ? "selected" : ""}>Single Elimination</option>
                  </select>
                </div>`
              : ""
          }
        </div>`;
    }

    backdrop.innerHTML = `
      <div class="slaprf-modal card rc-modal-lg" role="document">
        <div class="slaprf-modal-head">
          <div class="slaprf-modal-title-row">
            <span class="slaprf-modal-icon">${icons.download(17)}</span>
            <h3>Download from MultiGP</h3>
          </div>
          <button type="button" class="btn btn-ghost btn-xs" data-mgp-modal-close aria-label="Close">
            ${icons.close(15)}
          </button>
        </div>
        <div class="slaprf-modal-body">
          ${keyBarHtml}
          ${errorMsg ? `<div class="slaprf-modal-warn" style="margin-bottom:10px">${esc(errorMsg)}</div>` : ""}
          ${listHtml}
          ${detailHtml}
        </div>
        <div class="slaprf-modal-foot">
          <button type="button" class="btn btn-ghost" data-mgp-modal-close ${importing ? "disabled" : ""}>Cancel</button>
          <button type="button" class="btn btn-armed" data-mgp-do-import ${!selectedDetail || importing || loadingDetail ? "disabled" : ""}>
            ${icons.download(15)}
            <span>${importing ? "Downloading…" : "Download race"}</span>
          </button>
        </div>
      </div>
    `;
  };

  backdrop.addEventListener("input", (e) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    if (target instanceof HTMLInputElement && target.hasAttribute("data-mgp-key-input")) {
      draftApiKey = target.value;
    }
  });

  backdrop.addEventListener("change", (e) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    if (target instanceof HTMLSelectElement && target.hasAttribute("data-mgp-bracket-tpl")) {
      bracketTemplate = target.value;
    }
  });

  backdrop.addEventListener("click", (e) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    if (target === backdrop && !importing) {
      cleanup();
      return;
    }
    if (target.closest("[data-mgp-modal-close]") && !importing) {
      cleanup();
      return;
    }
    if (target.closest("[data-mgp-use-sim-key]")) {
      draftApiKey = store.simMultiGP?.apiKey || DEFAULT_SIM_MGP_API_KEY;
      sharedMultiGPService.setApiKey(true, draftApiKey);
      verifyingKey = true;
      errorMsg = "";
      render();
      void sharedMultiGPService
        .verifyChapterKey(store, api, draftApiKey)
        .then(() => loadRacesList())
        .catch((err) => {
          errorMsg = err instanceof Error ? err.message : String(err);
        })
        .finally(() => {
          verifyingKey = false;
          render();
        });
      return;
    }
    if (target.closest("[data-mgp-verify-key]")) {
      sharedMultiGPService.setApiKey(store.simulatorRunning, draftApiKey);
      verifyingKey = true;
      errorMsg = "";
      render();
      void sharedMultiGPService
        .verifyChapterKey(store, api, draftApiKey)
        .then(() => loadRacesList())
        .catch((err) => {
          errorMsg = err instanceof Error ? err.message : String(err);
        })
        .finally(() => {
          verifyingKey = false;
          render();
        });
      return;
    }
    if (target.closest("[data-mgp-refresh]")) {
      void loadRacesList();
      return;
    }
    const row = target.closest<HTMLElement>("[data-mgp-select-race]");
    if (row) {
      const id = row.dataset.mgpSelectRace ?? "";
      if (id && id !== selectedRaceId) {
        void selectAndLoadDetail(id);
      }
      return;
    }
    const modeBtn = target.closest<HTMLElement>("[data-mgp-import-mode]");
    if (modeBtn) {
      const m = modeBtn.dataset.mgpImportMode as ImportMode | undefined;
      if (m && m !== importMode) {
        importMode = m;
        render();
      }
      return;
    }
    if (target.closest("[data-mgp-do-import]") && selectedDetail && !importing) {
      importing = true;
      errorMsg = "";
      render();
      void api
        .multiGPImportRace(
          selectedDetail,
          importMode,
          importMode === "bracket" ? bracketTemplate : undefined
        )
        .then((created) => {
          showToast(
            `Downloaded "${created.config?.eventName || selectedDetail?.name || "MultiGP Race"}"`,
            "info"
          );
          cleanup();
          onImported(created);
        })
        .catch((err) => {
          importing = false;
          errorMsg = err instanceof Error ? err.message : String(err);
          render();
        });
    }
  });

  document.body.appendChild(backdrop);
  render();

  const initPrefs = curPrefs();
  if (initPrefs.apiKey || store.simulatorRunning) {
    if (store.simulatorRunning && !initPrefs.verified) {
      void sharedMultiGPService
        .verifyChapterKey(store, api, draftApiKey)
        .then(() => loadRacesList())
        .catch((err) => {
          errorMsg = err instanceof Error ? err.message : String(err);
          render();
        });
    } else {
      void loadRacesList();
    }
  }
}

export interface MultiGPErrorModalOptions {
  title?: string;
  raceName?: string;
  errorMessage: string;
  onRetry?: () => void;
}

export function openMultiGPErrorModal(opts: MultiGPErrorModalOptions): void {
  if (activeMultiGPModalCleanup) {
    activeMultiGPModalCleanup();
  }

  const backdrop = document.createElement("div");
  backdrop.className = "slaprf-modal-backdrop";
  backdrop.setAttribute("role", "dialog");
  backdrop.setAttribute("aria-modal", "true");
  backdrop.setAttribute("data-mgp-error-modal", "true");
  const titleText = opts.title || "MultiGP Upload Failed";
  backdrop.setAttribute("aria-label", titleText);

  const cleanup = (): void => {
    window.removeEventListener("keydown", onKeyDown, true);
    if (backdrop.parentNode) {
      backdrop.parentNode.removeChild(backdrop);
    }
    if (activeMultiGPModalCleanup === cleanup) {
      activeMultiGPModalCleanup = null;
    }
  };
  activeMultiGPModalCleanup = cleanup;

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cleanup();
    }
  };
  window.addEventListener("keydown", onKeyDown, true);

  backdrop.innerHTML = `
    <div class="slaprf-modal card" role="document" style="max-width:480px;width:92vw">
      <div class="slaprf-modal-head">
        <div class="slaprf-modal-title-row">
          <span class="slaprf-modal-icon" style="color:var(--warn)">${icons.alert(18)}</span>
          <h3>${esc(titleText)}</h3>
        </div>
        <button type="button" class="btn btn-ghost btn-xs" data-mgp-err-close aria-label="Close">
          ${icons.close(15)}
        </button>
      </div>
      <div class="slaprf-modal-body" style="display:flex;flex-direction:column;gap:12px">
        <p style="margin:0;font-size:13px;line-height:1.45;color:var(--text)">
          Could not upload ${opts.raceName ? `<strong>${esc(opts.raceName)}</strong>` : "the race results"} to MultiGP. The MultiGP web service may be temporarily unavailable, your network connection may be offline, or the Chapter API key was rejected.
        </p>
        <div class="slaprf-modal-warn mono" style="margin:0;padding:10px 12px;font-size:12px;line-height:1.4;word-break:break-word" data-mgp-error-detail>
          ${esc(opts.errorMessage || "Unknown MultiGP API error")}
        </div>
        <p class="note" style="margin:0;font-size:12px;line-height:1.4">
          All heats, laps, and standings remain safely saved locally in SlapRF. You can continue running or reviewing the race and retry uploading once the connection is restored.
        </p>
      </div>
      <div class="slaprf-modal-foot">
        <button type="button" class="btn btn-ghost" data-mgp-err-close>Close</button>
        ${
          opts.onRetry
            ? `<button type="button" class="btn btn-armed" data-mgp-err-retry>
                 ${icons.upload(14)}
                 <span>Retry Upload</span>
               </button>`
            : ""
        }
      </div>
    </div>
  `;

  backdrop.addEventListener("click", (e) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    if (target === backdrop || target.closest("[data-mgp-err-close]")) {
      cleanup();
      return;
    }
    if (target.closest("[data-mgp-err-retry]") && opts.onRetry) {
      const retryFn = opts.onRetry;
      cleanup();
      retryFn();
    }
  });

  document.body.appendChild(backdrop);
}

export type MultiGPUploadScope = "overall" | "heats";

export function openMultiGPSyncModal(
  store: AppStore,
  api: ApiClient,
  race: RaceTournamentState,
  scope: MultiGPUploadScope = "heats",
  onComplete?: () => void
): void {
  const link = race.mgpLink;
  const raceId = race.raceId ?? "";
  if (!raceId) return;
  const raceTitle = link?.raceName || race.config.eventName || "SlapRF Race";

  if (activeMultiGPModalCleanup) {
    activeMultiGPModalCleanup();
  }

  const backdrop = document.createElement("div");
  backdrop.className = "slaprf-modal-backdrop";
  backdrop.setAttribute("role", "dialog");
  backdrop.setAttribute("aria-modal", "true");
  backdrop.setAttribute("aria-label", "Upload to MultiGP");

  let loadingPlan = true;
  let forceAll = false;
  let viewMode: "table" | "json" = "table";
  let uploading = false;
  let progressLabel = "";
  let errorMsg = "";
  let plan: MultiGPSyncPlan | null = null;

  const standings =
    race.standings && race.standings.length > 0
      ? race.standings
      : (race.qualStandings ?? []);
  const hasCompletedHeats = (race.heats ?? []).some(
    (h) =>
      (h.state === "finished" || h.state === "confirmed") &&
      h.note !== "Auto-advance (bye)"
  );

  const cleanup = (): void => {
    window.removeEventListener("keydown", onKeyDown, true);
    if (backdrop.parentNode) {
      backdrop.parentNode.removeChild(backdrop);
    }
    if (activeMultiGPModalCleanup === cleanup) {
      activeMultiGPModalCleanup = null;
    }
  };
  activeMultiGPModalCleanup = cleanup;

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape" && !uploading) {
      e.preventDefault();
      e.stopPropagation();
      cleanup();
    }
  };
  window.addEventListener("keydown", onKeyDown, true);

  const loadPlan = async (initial = false): Promise<void> => {
    loadingPlan = true;
    errorMsg = "";
    render();
    try {
      let nextPlan = await api.multiGPBuildSyncPlan(raceId, forceAll);
      if (
        initial &&
        scope === "heats" &&
        !forceAll &&
        (nextPlan.operations?.length ?? 0) === 0 &&
        hasCompletedHeats
      ) {
        forceAll = true;
        nextPlan = await api.multiGPBuildSyncPlan(raceId, true);
      }
      plan = nextPlan;
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : String(err);
      plan = null;
    } finally {
      loadingPlan = false;
      render();
    }
  };

  const render = (): void => {
    const ops = plan?.operations ?? [];
    const overall = plan?.overallResults ?? [];
    const canUpload =
      !loadingPlan &&
      !uploading &&
      (scope === "overall" ? overall.length > 0 : ops.length > 0);
    const prefs = sharedMultiGPService.prefsFor(store.simulatorRunning, store);
    const mgpNumber =
      (link && link.raceId > 0 ? link.raceId : 0) ||
      (plan?.mgpRaceId && plan.mgpRaceId > 0 ? plan.mgpRaceId : 0) ||
      (link?.chapterId && link.chapterId > 0 ? link.chapterId : 0) ||
      (prefs.chapterId && prefs.chapterId > 0 ? prefs.chapterId : 0) ||
      (store.simulatorRunning && store.simMultiGP?.chapterId ? store.simMultiGP.chapterId : 0);
    const mgpLabel = mgpNumber > 0 ? `MultiGP #${mgpNumber}` : "MultiGP";

    const overallColGroupHtml = `<colgroup>
      <col style="width:64px" />
      <col />
      <col style="width:116px" />
      <col style="width:116px" />
      <col style="width:148px" />
    </colgroup>`;

    const overallTableHtml =
      overall.length === 0
        ? `<div class="note" style="padding:12px 4px">No overall rankings available to upload yet.</div>`
        : `<div class="table-scroll mgp-modal-table-scroll">
            <div class="mgp-modal-table-inner is-overall">
              <div class="mgp-modal-table-head-wrap">
                <table class="table rc-compact-table mgp-modal-table mgp-modal-head-table">
                  ${overallColGroupHtml}
                  <thead>
                    <tr>
                      <th class="rc-mgp-col-rank">Rank</th>
                      <th>Pilot</th>
                      <th class="rc-mgp-col-metric">MultiGP ID</th>
                      <th class="rc-mgp-col-metric">Best Lap</th>
                      <th class="rc-mgp-col-metric">Best 3 Consecutive</th>
                    </tr>
                  </thead>
                </table>
              </div>
              <div class="mgp-modal-table-body-wrap">
                <table class="table rc-compact-table mgp-modal-table mgp-modal-body-table">
                  ${overallColGroupHtml}
                  <tbody>
                    ${overall
                      .map((entry, idx) => {
                        const st =
                          standings[idx] ??
                          standings.find(
                            (s) =>
                              s.callsign.toLowerCase() ===
                              (entry.userName || "").toLowerCase()
                          );
                        const color = st?.color || "#38bdf8";
                        const bestLap =
                          st && st.bestLapSec > 0
                            ? `${st.bestLapSec.toFixed(2)}s`
                            : "—";
                        const best3 =
                          st && st.bestConsecutive3Sec > 0
                            ? `${st.bestConsecutive3Sec.toFixed(2)}s`
                            : "—";
                        return `
                          <tr>
                            <td class="rc-mgp-col-rank"><strong>${entry.orderNumber}</strong></td>
                            <td>
                              <span style="display:inline-flex;align-items:center;gap:6px">
                                <span class="dot" style="--c:${color}"></span>
                                <strong>${esc(entry.userName || `Pilot ${entry.pilotId}`)}</strong>
                              </span>
                            </td>
                            <td class="rc-mgp-col-metric">${entry.pilotId}</td>
                            <td class="rc-mgp-col-metric">${bestLap}</td>
                            <td class="rc-mgp-col-metric">${best3}</td>
                          </tr>`;
                      })
                      .join("")}
                  </tbody>
                </table>
              </div>
            </div>
          </div>`;

    const heatsColGroupHtml = `<colgroup>
      <col style="width:76px" />
      <col style="width:68px" />
      <col />
      <col style="width:68px" />
      <col style="width:104px" />
      <col style="width:104px" />
      <col style="width:144px" />
    </colgroup>`;

    const heatsTableHtml =
      ops.length === 0
        ? `<div class="note" style="padding:12px 4px">No confirmed heat slot assignments pending upload.${
            !forceAll
              ? " Toggle “Reupload All” to upload all completed heats."
              : ""
          }</div>`
        : `<div class="table-scroll mgp-modal-table-scroll">
            <div class="mgp-modal-table-inner is-heats">
              <div class="mgp-modal-table-head-wrap">
                <table class="table rc-compact-table mgp-modal-table mgp-modal-head-table">
                  ${heatsColGroupHtml}
                  <thead>
                    <tr>
                      <th class="rc-mgp-col-heat">Heat</th>
                      <th class="rc-mgp-col-metric">Slot</th>
                      <th>Pilot</th>
                      <th class="rc-mgp-col-metric">Laps</th>
                      <th class="rc-mgp-col-metric">Total Time</th>
                      <th class="rc-mgp-col-metric">Best Lap</th>
                      <th class="rc-mgp-col-metric">Best 3 Consecutive</th>
                    </tr>
                  </thead>
                </table>
              </div>
              <div class="mgp-modal-table-body-wrap">
                <table class="table rc-compact-table mgp-modal-table mgp-modal-body-table">
                  ${heatsColGroupHtml}
                  <tbody>
                    ${ops
                      .map(
                        (op) => `
                        <tr>
                          <td class="rc-mgp-col-heat"><strong>R${op.cycle}·H${op.heat}</strong></td>
                          <td class="rc-mgp-col-metric">S${op.slot}</td>
                          <td><strong>${esc(op.callsign)}</strong></td>
                          <td class="rc-mgp-col-metric">${op.data.totalLaps}</td>
                          <td class="rc-mgp-col-metric">${op.data.totalTime > 0 ? `${op.data.totalTime.toFixed(2)}s` : "—"}</td>
                          <td class="rc-mgp-col-metric">${op.data.fastestLapTime > 0 ? `${op.data.fastestLapTime.toFixed(2)}s` : "—"}</td>
                          <td class="rc-mgp-col-metric">${op.data.fastest3ConsecutiveLapsTime > 0 ? `${op.data.fastest3ConsecutiveLapsTime.toFixed(2)}s` : "—"}</td>
                        </tr>`
                      )
                      .join("")}
                  </tbody>
                </table>
              </div>
            </div>
          </div>`;

    const jsonPayload =
      scope === "overall"
        ? {
            method: "POST",
            endpoint: `race/captureOverallRaceResult?id=${plan?.mgpRaceId || 0}`,
            data: {
              raceId: plan?.mgpRaceId || 0,
              bracketResults: overall,
            },
          }
        : {
            method: "POST",
            endpoint: "race/assignSlot",
            requests: ops.map((op) => ({
              endpoint: `race/assignSlot?id=${plan?.mgpRaceId || 0}&cycle=${op.cycle}&heat=${op.heat}&slot=${op.slot}`,
              data: {
                ...op.data,
                pilotCallsign: op.callsign,
              },
            })),
          };

    const jsonViewHtml = `<div class="mgp-json-viewer-wrap">
      <textarea
        class="mgp-json-viewer"
        readonly
        spellcheck="false"
        aria-label="MultiGP JSON payload"
        data-mgp-json-viewer
      >${esc(JSON.stringify(jsonPayload, null, 2))}</textarea>
    </div>`;

    const mainContentHtml =
      viewMode === "json"
        ? jsonViewHtml
        : scope === "overall"
          ? overallTableHtml
          : heatsTableHtml;

    backdrop.innerHTML = `
      <div class="slaprf-modal card rc-modal-lg mgp-upload-modal" role="document">
        <div class="slaprf-modal-head">
          <div class="slaprf-modal-title-row">
            <span class="slaprf-modal-icon">${icons.upload(17)}</span>
            <h3>Upload to MultiGP</h3>
          </div>
          <div class="mgp-modal-head-controls">
            <div class="segmented rc-panel-seg mgp-view-mode-seg" role="group" aria-label="Payload view mode">
              <button
                type="button"
                class="${viewMode === "table" ? "is-active" : ""}"
                data-mgp-view-mode="table"
                aria-pressed="${viewMode === "table" ? "true" : "false"}"
              >Table</button>
              <button
                type="button"
                class="${viewMode === "json" ? "is-active" : ""}"
                data-mgp-view-mode="json"
                aria-pressed="${viewMode === "json" ? "true" : "false"}"
              >JSON</button>
            </div>
            <button type="button" class="btn btn-ghost btn-xs" data-mgp-sync-close aria-label="Close">
              ${icons.close(15)}
            </button>
          </div>
        </div>
        <div class="slaprf-modal-body">
          <div class="mgp-modal-meta-bar">
            <div class="mgp-modal-meta-left">
              <strong>${esc(raceTitle)}</strong>
              <span class="mgp-modal-meta-sep">-</span>
              <span class="note">${esc(mgpLabel)}</span>
            </div>
            ${
              scope === "heats"
                ? `<label class="mgp-force-all-toggle">
                    <input type="checkbox" data-mgp-force-all ${forceAll ? "checked" : ""} ${uploading ? "disabled" : ""} />
                    <span>Reupload All</span>
                  </label>`
                : ""
            }
          </div>

          ${errorMsg ? `<div class="slaprf-modal-warn" style="margin-bottom:10px">${esc(errorMsg)}</div>` : ""}
          <div class="mgp-modal-payload-stage">
            ${
              loadingPlan
                ? `<div class="note" style="padding:16px 6px">Preparing MultiGP upload payload…</div>`
                : mainContentHtml
            }
          </div>
          ${
            progressLabel
              ? `<div class="note" style="margin-top:10px">${esc(progressLabel)}</div>`
              : ""
          }
        </div>
        <div class="slaprf-modal-foot">
          <button type="button" class="btn btn-ghost" data-mgp-sync-close ${uploading ? "disabled" : ""}>Cancel</button>
          <button type="button" class="btn btn-armed" data-mgp-do-sync ${canUpload ? "" : "disabled"}>
            ${icons.upload(15)}
            <span>${uploading ? "Uploading…" : "Upload"}</span>
          </button>
        </div>
      </div>
    `;
  };

  backdrop.addEventListener("change", (e) => {
    const target = e.target as HTMLElement | null;
    if (target instanceof HTMLInputElement && target.hasAttribute("data-mgp-force-all")) {
      forceAll = target.checked;
      void loadPlan(false);
    }
  });

  backdrop.addEventListener("click", (e) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    if (target === backdrop && !uploading) {
      cleanup();
      return;
    }
    if (target.closest("[data-mgp-sync-close]") && !uploading) {
      cleanup();
      return;
    }
    const modeBtn = target.closest<HTMLElement>("[data-mgp-view-mode]");
    if (modeBtn) {
      const nextMode = modeBtn.dataset.mgpViewMode === "json" ? "json" : "table";
      if (nextMode !== viewMode) {
        viewMode = nextMode;
        render();
      }
      return;
    }
    if (target.closest("[data-mgp-do-sync]") && plan && !uploading) {
      uploading = true;
      errorMsg = "";
      progressLabel = "Starting MultiGP upload…";
      render();
      const scopedPlan: MultiGPSyncPlan = {
        ...plan,
        operations: scope === "heats" ? (plan.operations ?? []) : [],
        overallResults: scope === "overall" ? (plan.overallResults ?? []) : [],
      };
      void sharedMultiGPService
        .pushSyncPlan(store, api, scopedPlan, (done, total, label) => {
          progressLabel = `Uploading ${done}/${total}: ${label}`;
          render();
        })
        .then((res) => {
          showToast(
            scope === "overall"
              ? `Uploaded overall rankings to MultiGP #${res.mgpRaceId}`
              : `Uploaded ${res.slotsPushed} heat slot${res.slotsPushed === 1 ? "" : "s"} to MultiGP #${res.mgpRaceId}`,
            "info"
          );
          cleanup();
          onComplete?.();
        })
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          cleanup();
          openMultiGPErrorModal({
            title: "MultiGP Upload Failed",
            raceName: raceTitle,
            errorMessage: msg,
            onRetry: () => openMultiGPSyncModal(store, api, race, scope, onComplete),
          });
        });
    }
  });

  document.body.appendChild(backdrop);
  void loadPlan(true);
}
