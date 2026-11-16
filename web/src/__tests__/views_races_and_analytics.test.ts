import { dispatchRacesTopBarCommand, Router, setAnalyticsScope } from "../core/router";
import { TopBar } from "../layout/TopBar";
import { Announcer } from "../services/announcer";
import { LiveView } from "../views/LiveView";
import { focusAnalyticsPilotForScope, PilotView } from "../views/PilotView";
import {
  computeBinPackedControlLayout,
  formatHeatClockDisplay,
  RacesView,
} from "../views/RacesView";
import {
  describe,
  expect,
  flushMicrotasks,
  it,
  makeEventPilot,
  makeGate,
  makeHeat,
  makeLap,
  makeMockApiClient,
  makePilot,
  makePracticeSession,
  makeRaceSetupConfig,
  makeRaceState,
  makeRound,
  makeSeat,
  makeSectorSplit,
  makeStage,
  makeStore,
  mountHtml,
} from "./harness";

function buildTwoStageConfiguredRace(overrides: Parameters<typeof makeRaceState>[0] = {}) {
  const s1 = makeStage(1, {
    id: "stage-1",
    index: 1,
    title: "Qualifying",
    format: "qualifying",
    status: "active",
    prerequisitesMet: true,
  });
  const s2 = makeStage(2, {
    id: "stage-2",
    index: 2,
    title: "Main Bracket",
    format: "double_elimination",
    status: "pending",
    prerequisitesMet: false,
  });
  const r1 = makeRound("q-r1", {
    stageIndex: 1,
    round: 1,
    column: 1,
    bracketLane: "winners",
    stageFormat: "qualifying",
    title: "Qualifying Rd 1",
  });
  const r2 = makeRound("de-r1", {
    stageIndex: 2,
    round: 1,
    column: 1,
    bracketLane: "winners",
    stageFormat: "double_elimination",
    title: "Upper Rd 1",
  });
  const h1 = makeHeat("Q1-H1", {
    id: "Q1-H1",
    shortLabel: "Q1-H1",
    title: "Qualifying Heat 1",
    roundId: "q-r1",
    stageIndex: 1,
    stageFormat: "qualifying",
    state: "finished",
    seats: [
      makeSeat(0, 1, { position: 1, lapsCompleted: 3, totalTimeSec: 36.4, bestConsecutive3Sec: 36.4 }),
      makeSeat(1, 2, { position: 2, lapsCompleted: 3, totalTimeSec: 38.1, bestConsecutive3Sec: 38.1 }),
      makeSeat(2, 3, { position: 3, lapsCompleted: 3, totalTimeSec: 40.2, bestConsecutive3Sec: 40.2 }),
      makeSeat(3, 4, { position: 4, lapsCompleted: 2, totalTimeSec: 29.0 }),
    ],
  });
  const h2 = makeHeat("Q1-H2", {
    id: "Q1-H2",
    shortLabel: "Q1-H2",
    title: "Qualifying Heat 2",
    roundId: "q-r1",
    stageIndex: 1,
    stageFormat: "qualifying",
    state: "staged",
  });
  const h3 = makeHeat("W1-H1", {
    id: "W1-H1",
    shortLabel: "W1-H1",
    title: "Upper Heat 1",
    roundId: "de-r1",
    stageIndex: 2,
    stageFormat: "double_elimination",
    state: "waiting",
  });

  return makeRaceState({
    raceId: "race-brawl",
    lifecycle: "active",
    emergencyStopped: false,
    mode: "race",
    generated: true,
    config: makeRaceSetupConfig({
      eventName: "Friday Night Brawl",
      structure: "qualifying_then_bracket",
      mainFormat: "double_elimination",
    }),
    roster: [1, 2, 3, 4].map((i) => makeEventPilot(i)),
    stages: [s1, s2],
    stageConnections: [
      {
        id: "sc-1-2",
        fromStageId: "stage-1",
        toStageId: "stage-2",
        fromStageIndex: 1,
        toStageIndex: 2,
        mode: "top",
        count: 4,
      },
    ],
    rounds: [r1, r2],
    connections: [],
    activeStageIndex: 1,
    totalStages: 2,
    activeHeatId: "Q1-H1",
    nextReadyHeatId: "Q1-H2",
    heats: [h1, h2, h3],
    ...overrides,
  });
}

describe("views/RacesView — Directory, Per-Canvas Lock State & Race Control Hierarchy", () => {
  it("filters Races directory by search query, lifecycle status pills, and tags", () => {
    window.history.replaceState(null, "", "/#/races");
    const rActive = buildTwoStageConfiguredRace({
      raceId: "race-1",
      lifecycle: "active",
      tags: ["Outdoor", "Season 4"],
      config: makeRaceSetupConfig({ eventName: "Summer Nationals" }),
    });
    const rDraft = makeRaceState({
      raceId: "race-2",
      lifecycle: "draft",
      generated: false,
      heats: [],
      tags: ["Indoor"],
      config: makeRaceSetupConfig({ eventName: "Whoop Wednesday" }),
    });
    const rDone = makeRaceState({
      raceId: "race-3",
      lifecycle: "completed",
      isComplete: true,
      tags: [],
      config: makeRaceSetupConfig({ eventName: " Autumn Classic " }),
    });

    const store = makeStore({
      raceState: rActive,
      eventState: {
        initialized: true,
        activeRaceId: "race-1",
        races: [rActive, rDraft, rDone],
      },
    });
    const { api } = makeMockApiClient(store);
    const root = mountHtml(`<div id="races-host"></div>`);
    const view = new RacesView(root.querySelector("#races-host")!, store, api);

    try {
      expect(root.querySelectorAll("tbody tr[data-race-row]")).toHaveLength(3);

      // Filter by status = done (completed)
      root.querySelector<HTMLButtonElement>("[data-race-dir-status='done']")!.click();
      let rows = root.querySelectorAll<HTMLElement>("tbody tr[data-race-row]");
      expect(rows).toHaveLength(1);
      expect(rows[0].dataset.raceRow).toBe("race-3");

      // Reset status to All, filter by tag "Indoor"
      root.querySelector<HTMLButtonElement>("[data-race-dir-status='all']")!.click();
      root.querySelector<HTMLButtonElement>("[data-tag-filter='Indoor']")!.click();
      rows = root.querySelectorAll<HTMLElement>("tbody tr[data-race-row]");
      expect(rows).toHaveLength(1);
      expect(rows[0].dataset.raceRow).toBe("race-2");

      // Clear tag filter and filter via search input
      root.querySelector<HTMLButtonElement>("[data-tag-filter='__all__']")!.click();
      const searchInput = root.querySelector<HTMLInputElement>("[data-race-dir-search]")!;
      searchInput.value = "nationals";
      searchInput.dispatchEvent(new Event("input", { bubbles: true }));
      rows = root.querySelectorAll<HTMLElement>("tbody tr[data-race-row]");
      expect(rows).toHaveLength(1);
      expect(rows[0].dataset.raceRow).toBe("race-1");
    } finally {
      view.destroy();
    }
  });

  it("maintains independent canvas lock states across Control (locked by default), Format, Stage 1, Stage 2, and Review", async () => {
    window.history.replaceState(null, "", "/#/races/friday-night-brawl/control");
    const race = buildTwoStageConfiguredRace();
    const store = makeStore({
      raceState: race,
      eventState: {
        initialized: true,
        activeRaceId: race.raceId!,
        races: [race],
      },
    });
    const { api } = makeMockApiClient(store);
    const root = mountHtml(`<div id="races-host"></div>`);
    const view = new RacesView(root.querySelector("#races-host")!, store, api);
    await flushMicrotasks();

    try {
      // 1. Control canvas defaults to LOCKED, hiding the bottom-right '+' FAB menu
      const lockBtnControl = root.querySelector<HTMLButtonElement>("[data-rc-ui='toggle-lock']")!;
      expect(lockBtnControl).not.toBeNull();
      expect(lockBtnControl.classList.contains("is-active")).toBe(true);
      const fabControl = root.querySelector<HTMLElement>(".rc-fab-menu")!;
      expect(fabControl).not.toBeNull();
      expect(fabControl.hasAttribute("hidden")).toBe(true);

      // 2. Navigate to Format canvas -> defaults to UNLOCKED and shows '+' FAB menu
      dispatchRacesTopBarCommand({ type: "set-tab", tab: "format" });

      const lockBtnFormat = root.querySelector<HTMLButtonElement>("[data-rc-ui='toggle-lock']")!;
      expect(lockBtnFormat.classList.contains("is-active")).toBe(false);
      const fabFormat = root.querySelector<HTMLElement>(".rc-fab-menu")!;
      expect(fabFormat).not.toBeNull();
      expect(fabFormat.hasAttribute("hidden")).toBe(false);

      // Lock Format canvas explicitly -> hides '+' FAB on Format
      lockBtnFormat.click();
      expect(
        root.querySelector<HTMLButtonElement>("[data-rc-ui='toggle-lock']")!.classList.contains("is-active")
      ).toBe(true);
      expect(root.querySelector<HTMLElement>(".rc-fab-menu")!.hasAttribute("hidden")).toBe(true);

      // 3. Switch to Stage 1 editor -> still UNLOCKED despite Format & Control being locked!
      dispatchRacesTopBarCommand({ type: "set-tab", tab: "edit", stage: 1 });
      expect(
        root.querySelector<HTMLButtonElement>("[data-rc-ui='toggle-lock']")!.classList.contains("is-active")
      ).toBe(false);
      expect(root.querySelector<HTMLElement>(".rc-fab-menu")!.hasAttribute("hidden")).toBe(false);

      // Lock Stage 1, then switch to Stage 2 -> Stage 2 has its own independent UNLOCKED state!
      root.querySelector<HTMLButtonElement>("[data-rc-ui='toggle-lock']")!.click();
      expect(
        root.querySelector<HTMLButtonElement>("[data-rc-ui='toggle-lock']")!.classList.contains("is-active")
      ).toBe(true);

      dispatchRacesTopBarCommand({ type: "set-stage", stage: 2 });
      expect(
        root.querySelector<HTMLButtonElement>("[data-rc-ui='toggle-lock']")!.classList.contains("is-active")
      ).toBe(false);

      // 4. Switch to Review -> defaults to LOCKED just like Control!
      dispatchRacesTopBarCommand({ type: "set-tab", tab: "review" });
      expect(
        root.querySelector<HTMLButtonElement>("[data-rc-ui='toggle-lock']")!.classList.contains("is-active")
      ).toBe(true);

      // 5. Switch back to Format -> remembers Format was LOCKED!
      dispatchRacesTopBarCommand({ type: "set-tab", tab: "format" });
      expect(
        root.querySelector<HTMLButtonElement>("[data-rc-ui='toggle-lock']")!.classList.contains("is-active")
      ).toBe(true);
    } finally {
      view.destroy();
    }
  });

  it("renders streamlined Option A Race Control with header lifecycle switch, pinned bottom-left golden-path primary button, voice-gated announce play button, and Format stage menu overrides", async () => {
    window.history.replaceState(null, "", "/#/races/friday-night-brawl/control");
    const baseRace = buildTwoStageConfiguredRace();
    // Q1-H1 confirmed (1/2 in Stage 1) and Q1-H2 finished (in Review)
    const race = buildTwoStageConfiguredRace({
      activeHeatId: "Q1-H2",
      nextReadyHeatId: "",
      heats: baseRace.heats.map((h) => {
        if (h.id === "Q1-H1") return { ...h, state: "confirmed" };
        if (h.id === "Q1-H2") return { ...h, order: 2, state: "finished" };
        return h;
      }),
    });
    const store = makeStore({
      simulatorRunning: true,
      raceState: race,
      eventState: {
        initialized: true,
        activeRaceId: race.raceId!,
        races: [race],
      },
    });
    const announcer = new Announcer(store);
    Object.defineProperty(announcer, "supported", { value: true, configurable: true });
    announcer.update({ enabled: true });

    const { api, calls } = makeMockApiClient(store);
    const root = mountHtml(`<div id="races-host"></div>`);
    const view = new RacesView(root.querySelector("#races-host")!, store, api, announcer);
    await flushMicrotasks();
    calls.length = 0;

    try {
      const cockpit = () => root.querySelector<HTMLElement>("[data-canvas-panel='cockpit']")!;
      expect(cockpit()).not.toBeNull();

      // Header holds heat shortLabel badge + Close Stage button + 3-way Race Lifecycle switch (no .race-state-pill, no Sim speed)
      const headerEl = cockpit().querySelector<HTMLElement>(".rc-panel-header")!;
      expect(headerEl.querySelectorAll(".race-state-pill")).toHaveLength(0);
      expect(headerEl.textContent).toContain("Q1-H2");
      expect(headerEl.querySelector("[data-race-act='close-stage-modal']")).not.toBeNull();
      expect(headerEl.querySelector(".rc-lifecycle-seg")).not.toBeNull();
      // Megaphone lap-callouts toggle sits inside .race-clock-row right before [data-race-clock], defaulting ON for qualifiers
      const clockRow = cockpit().querySelector<HTMLElement>(".race-clock-row")!;
      expect(clockRow).not.toBeNull();
      const lapCalloutsBtn = clockRow.querySelector<HTMLButtonElement>("[data-toggle-race-lap-callouts]")!;
      expect(lapCalloutsBtn).not.toBeNull();
      expect(lapCalloutsBtn.nextElementSibling?.hasAttribute("data-race-clock")).toBe(true);
      expect(lapCalloutsBtn.getAttribute("aria-pressed")).toBe("true");
      expect(cockpit().querySelector("[data-sim-speed]")).toBeNull();
      expect(cockpit().querySelector("[data-stage-ctrl]")).toBeNull();

      // While race is Active and heat Q1-H2 is "finished" (Review), inner pill shows "Review"
      // and bottom-left primary slot FIRST button is "Confirm Heat", with "Re-run Heat" second
      const innerPillActive = cockpit().querySelector<HTMLElement>(".race-cockpit-title-row .race-state-pill")!;
      expect(innerPillActive.textContent?.trim()).toBe("Review");
      expect(innerPillActive.classList.contains("is-review")).toBe(true);

      const transportBtns = Array.from(
        cockpit().querySelectorAll<HTMLButtonElement>(".race-transport-bar > button")
      );
      expect(transportBtns[0]?.classList.contains("race-btn-primary-slot")).toBe(true);
      expect(transportBtns[0]?.getAttribute("data-ctrl")).toBe("confirm");
      expect(transportBtns[0]?.textContent?.trim()).toBe("Confirm Heat");
      expect(transportBtns[1]?.getAttribute("data-ctrl")).toBe("reset");
      expect(transportBtns[1]?.textContent?.trim()).toBe("Re-run Heat");

      // Announcer Play button is visible when master announcer is enabled, and disappears when disabled
      expect(cockpit().querySelector("[data-announce-speak]")).not.toBeNull();
      announcer.update({ enabled: false });
      expect(cockpit().querySelector("[data-announce-speak]")).toBeNull();
      announcer.update({ enabled: true });
      expect(cockpit().querySelector("[data-announce-speak]")).not.toBeNull();

      // Flight Line penalty header uses the larger 19px hammer SVG
      const heatlinePanel = root.querySelector<HTMLElement>("[data-canvas-panel='heatline']");
      expect(heatlinePanel).not.toBeNull();
      const penHeadSvg = heatlinePanel!.querySelector("th.col-pen svg");
      expect(penHeadSvg?.getAttribute("width")).toBe("19");

      // Active segment in header is pressed; clicking "Paused" dispatches pause_race via eventAction
      const liveHeaderEl = cockpit().querySelector<HTMLElement>(".rc-panel-header")!;
      const activeBtn = liveHeaderEl.querySelector<HTMLButtonElement>(
        ".is-active[data-race-act='lifecycle-direct']"
      )!;
      expect(activeBtn).not.toBeNull();
      expect(activeBtn.textContent?.trim()).toBe("Active");

      liveHeaderEl.querySelector<HTMLButtonElement>("[data-lifecycle-act='pause_race']")!.click();
      await flushMicrotasks();
      expect(calls.some((c) => c.method === "eventAction")).toBe(true);

      // Simulate Emergency Stop state arriving from backend -> inner pill shows "Stopped", Emergency segment is active, Re-run Heat is hidden
      const emergencyRace = {
        ...race,
        lifecycle: "paused" as const,
        emergencyStopped: true,
        heats: race.heats.map((h) => (h.id === "Q1-H2" ? { ...h, state: "aborted" as const } : h)),
      };
      store.hydrate({
        ...storeSnapshotFrom(store),
        raceState: emergencyRace,
        eventState: { initialized: true, activeRaceId: emergencyRace.raceId!, races: [emergencyRace] },
      });

      expect(cockpit().querySelectorAll(".rc-panel-header .race-state-pill")).toHaveLength(0);
      const stoppedPill = cockpit().querySelector<HTMLElement>(".race-cockpit-title-row .race-state-pill")!;
      expect(stoppedPill.textContent?.trim()).toBe("Stopped");
      expect(stoppedPill.classList.contains("is-stopped")).toBe(true);
      expect(
        cockpit()
          .querySelector<HTMLElement>("[data-lifecycle-act='emergency_stop']")!
          .classList.contains("is-active")
      ).toBe(true);
      expect(cockpit().querySelector("[data-ctrl='reset']")).toBeNull();

      // Transition from Emergency -> Paused (non-emergency) -> "Stopped" clears immediately, and heat controls remain enabled so starting/re-running auto-activates or prompts preemption
      const pausedCleanRace = {
        ...race,
        lifecycle: "paused" as const,
        emergencyStopped: false,
      };
      store.hydrate({
        ...storeSnapshotFrom(store),
        raceState: pausedCleanRace,
        eventState: { initialized: true, activeRaceId: pausedCleanRace.raceId!, races: [pausedCleanRace] },
      });

      const pillAfterClear = cockpit().querySelector<HTMLElement>(".race-cockpit-title-row .race-state-pill")!;
      expect(pillAfterClear.textContent?.trim()).not.toBe("Stopped");
      expect(
        cockpit()
          .querySelector<HTMLElement>("[data-lifecycle-act='pause_race']")!
          .classList.contains("is-active")
      ).toBe(true);
      expect(cockpit().querySelector("[data-ctrl='reset']")).not.toBeNull();

      // Verify ready heat on a Paused race still enables "Start Heat" (auto-activating or prompting preemption)
      const pausedReadyRace = {
        ...pausedCleanRace,
        heats: race.heats.map((h) => (h.id === "Q1-H2" ? { ...h, state: "ready" as const } : h)),
      };
      store.hydrate({
        ...storeSnapshotFrom(store),
        raceState: pausedReadyRace,
        eventState: { initialized: true, activeRaceId: pausedReadyRace.raceId!, races: [pausedReadyRace] },
      });
      const pausedStartBtn = cockpit().querySelector<HTMLButtonElement>("[data-ctrl='start']")!;
      expect(pausedStartBtn).not.toBeNull();
      expect(pausedStartBtn.disabled).toBe(false);

      // Verify ready heat places "Start Heat" FIRST on bottom-left before "Stage Channels", and staged heat shows "Staged" pill
      const readyRace = {
        ...race,
        lifecycle: "active" as const,
        emergencyStopped: false,
        heats: race.heats.map((h) => (h.id === "Q1-H2" ? { ...h, state: "ready" as const } : h)),
      };
      store.hydrate({
        ...storeSnapshotFrom(store),
        raceState: readyRace,
        eventState: { initialized: true, activeRaceId: readyRace.raceId!, races: [readyRace] },
      });
      const readyBtns = Array.from(
        cockpit().querySelectorAll<HTMLButtonElement>(".race-transport-bar > button")
      );
      expect(readyBtns[0]?.getAttribute("data-ctrl")).toBe("start");
      expect(readyBtns[0]?.textContent?.trim()).toBe("Start Heat");
      expect(readyBtns[1]?.getAttribute("data-ctrl")).toBe("select");
      expect(readyBtns[1]?.textContent?.trim()).toBe("Stage Channels");

      const stagedRace = {
        ...readyRace,
        heats: readyRace.heats.map((h) => (h.id === "Q1-H2" ? { ...h, state: "staged" as const } : h)),
      };
      store.hydrate({
        ...storeSnapshotFrom(store),
        raceState: stagedRace,
        eventState: { initialized: true, activeRaceId: stagedRace.raceId!, races: [stagedRace] },
      });
      const stagedPill = cockpit().querySelector<HTMLElement>(".race-cockpit-title-row .race-state-pill")!;
      expect(stagedPill.textContent?.trim()).toBe("Staged");
      expect(stagedPill.classList.contains("is-staged")).toBe(true);

      // Clicking the jump-to-editor arrow button focuses the heat in the Stage editor tab
      const jumpBtn = cockpit().querySelector<HTMLButtonElement>("[data-race-act='focus-heat-graph']")!;
      expect(jumpBtn).not.toBeNull();
      jumpBtn.click();
      await flushMicrotasks();
      expect(window.location.hash).toBe("#/races/friday-night-brawl/format/stage-1");

      // Switch to Format overview and open Stage 1's hamburger menu -> Complete Early & Seed is available there
      dispatchRacesTopBarCommand({ type: "set-tab", tab: "format" });
      await flushMicrotasks();
      const stage1MenuBtn = root.querySelector<HTMLButtonElement>(
        "[data-stage-index='1'] [data-fmt-ui='toggle-stage-menu']"
      )!;
      expect(stage1MenuBtn).not.toBeNull();
      stage1MenuBtn.click();
      const completeEarlyMenuBtn = root.querySelector<HTMLButtonElement>(
        "[data-stage-index='1'] .bkt-node-menu [data-stage-ctrl='complete_stage_early']"
      );
      expect(completeEarlyMenuBtn).not.toBeNull();
    } finally {
      view.destroy();
      announcer.update({ enabled: false });
    }
  });

  it("keeps Flight Line rows stationary while marshal menu is open, preserves valid laps on single-lap scratch, and blocks queueing in-flight Open Qualifier pilots", async () => {
    window.history.replaceState(null, "", "/#/races/friday-night-brawl/control");
    const laps4 = [
      { crossingId: 10, lapNumber: 0, splitTimeSec: 0.9, cumulativeSec: 0.9, invalidated: false, manual: false },
      { crossingId: 11, lapNumber: 1, splitTimeSec: 11.2, cumulativeSec: 12.1, invalidated: false, manual: false },
      { crossingId: 12, lapNumber: 2, splitTimeSec: 11.4, cumulativeSec: 23.5, invalidated: false, manual: false },
      { crossingId: 13, lapNumber: 3, splitTimeSec: 11.1, cumulativeSec: 34.6, invalidated: false, manual: false },
    ];
    const baseRace = buildTwoStageConfiguredRace({
      activeHeatId: "Q1-H1",
      heats: [
        makeHeat("Q1-H1", {
          id: "Q1-H1",
          shortLabel: "Q1-H1",
          title: "Round 1 Heat 1",
          roundId: "q-r1",
          stageIndex: 1,
          stageFormat: "single_elimination",
          targetLaps: 3,
          state: "finished",
          seats: [
            makeSeat(0, 1, { callsign: "ALPHA", status: "finished", position: 1, lapsCompleted: 3, totalTimeSec: 34.6, laps: laps4 }),
            makeSeat(1, 2, { callsign: "BRAVO", status: "finished", position: 2, lapsCompleted: 3, totalTimeSec: 36.2, laps: laps4 }),
            makeSeat(2, 3, { callsign: "CHARLIE", status: "dnf", statusOverridden: false, position: 3, lapsCompleted: 1, totalTimeSec: 12.1 }),
            makeSeat(3, 4, { callsign: "DELTA", status: "dns", statusOverridden: true, position: 0, lapsCompleted: 0 }),
          ],
        }),
      ],
    });

    const store = makeStore({
      raceState: baseRace,
      eventState: { initialized: true, activeRaceId: baseRace.raceId!, races: [baseRace] },
    });
    const announcer = new Announcer(store);
    const { api } = makeMockApiClient(store);
    const root = mountHtml(`<div id="races-host"></div>`);
    const view = new RacesView(root.querySelector("#races-host")!, store, api, announcer);
    await flushMicrotasks();

    try {
      const getRowCallsigns = () =>
        Array.from(root.querySelectorAll<HTMLElement>("[data-canvas-panel='heatline'] tr.race-seat-row .race-pilot-name strong")).map(
          (el) => el.textContent?.trim()
        );

      expect(getRowCallsigns()).toEqual(["ALPHA", "BRAVO", "CHARLIE", "DELTA"]);

      // 1. Open ALPHA's ☰ marshal menu, then toggle ALPHA across DNS (unranked) and DNF (pos 3) and DQ (unranked):
      // ALPHA's row MUST remain frozen in row index 0 the entire time the menu stays open!
      root.querySelector<HTMLButtonElement>("[data-marshal-menu-toggle='Q1-H1:1']")!.click();
      expect(root.querySelector(".rc-pill-swapper-popover")).not.toBeNull();

      const dnsRace = {
        ...baseRace,
        heats: baseRace.heats.map((h) => ({
          ...h,
          seats: h.seats.map((s) =>
            s.pilotSlotIndex === 1
              ? { ...s, status: "dns" as const, statusOverridden: true, position: 0, lapsCompleted: 0 }
              : s.pilotSlotIndex === 2
                ? { ...s, position: 1 }
                : s.pilotSlotIndex === 3
                  ? { ...s, position: 2 }
                  : s
          ),
        })),
      };
      store.hydrate({
        ...storeSnapshotFrom(store),
        raceState: dnsRace,
        eventState: { initialized: true, activeRaceId: dnsRace.raceId!, races: [dnsRace] },
      });
      expect(getRowCallsigns()).toEqual(["ALPHA", "BRAVO", "CHARLIE", "DELTA"]);
      expect(root.querySelector(".rc-pill-swapper-popover")).not.toBeNull();

      // Closing the menu keeps rows stationary (updating Pos badges in place without jumping rows!),
      // and clicking the header Sort button (`[data-sort-heat-rows]`) in `<th class="col-drag">` sorts by Pos!
      root.querySelector<HTMLButtonElement>("[data-marshal-menu-toggle='Q1-H1:1']")!.click();
      expect(root.querySelector(".rc-pill-swapper-popover")).toBeNull();
      expect(getRowCallsigns()).toEqual(["ALPHA", "BRAVO", "CHARLIE", "DELTA"]);

      const sortBtn = root.querySelector<HTMLButtonElement>(
        "[data-canvas-panel='heatline'] th.col-drag [data-sort-heat-rows='Q1-H1']"
      )!;
      expect(sortBtn).not.toBeNull();
      expect(sortBtn.closest("th")?.nextElementSibling?.textContent?.trim()).toBe("Pos");
      sortBtn.click();
      expect(getRowCallsigns()).toEqual(["BRAVO", "CHARLIE", "ALPHA", "DELTA"]);

      // 2. Single-lap scratch on ALPHA (status === "dnf", statusOverridden === false, 2/3 laps):
      // Renders "Incomplete" (NOT "Crashed Out") and keeps non-scratched lap chips enabled & valid!
      const singleScratchLaps = laps4.map((l) => (l.crossingId === 12 ? { ...l, invalidated: true, lapNumber: -1 } : l));
      const scratchRace = {
        ...baseRace,
        heats: baseRace.heats.map((h) => ({
          ...h,
          seats: h.seats.map((s) =>
            s.pilotSlotIndex === 1
              ? {
                  ...s,
                  status: "dnf" as const,
                  statusOverridden: false,
                  position: 2,
                  lapsCompleted: 2,
                  laps: singleScratchLaps,
                }
              : s.pilotSlotIndex === 2
                ? { ...s, position: 1 }
                : s
          ),
        })),
      };
      store.hydrate({
        ...storeSnapshotFrom(store),
        raceState: scratchRace,
        eventState: { initialized: true, activeRaceId: scratchRace.raceId!, races: [scratchRace] },
      });

      const alphaRow = Array.from(root.querySelectorAll<HTMLElement>("[data-canvas-panel='heatline'] tr.race-seat-row")).find(
        (tr) => tr.querySelector(".race-pilot-name strong")?.textContent?.trim() === "ALPHA"
      )!;
      expect(alphaRow.className).toContain("status-incomplete");
      expect(alphaRow.classList.contains("status-dnf")).toBe(false);
      expect(alphaRow.querySelector(".race-td-status")?.textContent?.trim()).toBe("Incomplete");
      const alphaChips = Array.from(alphaRow.querySelectorAll<HTMLButtonElement>(".race-lap-chip"));
      expect(alphaChips.filter((c) => c.classList.contains("is-invalid"))).toHaveLength(1);
      expect(alphaChips.filter((c) => c.disabled)).toHaveLength(0);

      // 3. Open Qualifier Flight Queue: pilots actively flying in a running heat show "Flying · OQ-1" and cannot be queued again
      const oqStage = makeStage(1, {
        id: "stage-1",
        index: 1,
        title: "Open Qualifier",
        format: "open_qualifier",
        status: "active",
      });
      const oqRace = makeRaceState({
        raceId: "race-oq",
        lifecycle: "active",
        generated: true,
        config: makeRaceSetupConfig({ eventName: "OQ Session", mainFormat: "open_qualifier" }),
        roster: [1, 2, 3].map((i) => makeEventPilot(i, { callsign: `PILOT${i}` })),
        stages: [oqStage],
        activeStageIndex: 1,
        totalStages: 1,
        activeHeatId: "OQ-1",
        heats: [
          makeHeat("OQ-1", {
            id: "OQ-1",
            shortLabel: "OQ-1",
            title: "Open Qualifier Heat 1",
            stageIndex: 1,
            stageFormat: "open_qualifier",
            state: "running",
            seats: [
              makeSeat(0, 1, { callsign: "PILOT1", status: "racing" }),
              makeSeat(1, 2, { callsign: "PILOT2", status: "racing" }),
            ],
          }),
        ],
      });
      store.hydrate({
        ...storeSnapshotFrom(store),
        raceState: oqRace,
        eventState: { initialized: true, activeRaceId: "race-oq", races: [oqRace] },
      });
      window.history.replaceState(null, "", "/#/races/oq-session/control");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
      await flushMicrotasks();

      const queuePanel = root.querySelector<HTMLElement>("[data-canvas-panel='flightline']")!;
      expect(queuePanel).not.toBeNull();
      expect(queuePanel.textContent).toContain("Flying · OQ-1");
      // Only PILOT3 (not flying) has an enqueue button, and Queue All Ready shows (1)
      const enqueueBtns = queuePanel.querySelectorAll("[data-oq-act='enqueue']");
      expect(enqueueBtns).toHaveLength(1);
      expect(enqueueBtns[0]?.getAttribute("data-pilot-slot")).toBe("3");
      expect(queuePanel.querySelector("[data-oq-act='enqueue_all']")?.textContent).toContain("(1)");
    } finally {
      view.destroy();
    }
  });
});

describe("views/LiveView, PilotView & TopBar Integration", () => {
  it("prompts to pause an ongoing race when starting a Practice session in LiveView, then dispatches practiceAction on confirm", async () => {
    window.history.replaceState(null, "", "/#/live");
    const activeRace = buildTwoStageConfiguredRace({
      raceId: "race-live",
      lifecycle: "active",
      emergencyStopped: false,
    });
    const session = makePracticeSession("prac-1", {
      name: "Morning Warmup",
      active: false,
      tags: ["5-inch"],
    });
    const store = makeStore({
      raceState: activeRace,
      eventState: {
        initialized: true,
        activeRaceId: "race-live",
        races: [activeRace],
      },
      practiceState: {
        initialized: true,
        activeSessionId: "",
        selectedSessionId: "prac-1",
        sessions: [session],
      },
    });
    const { api, calls } = makeMockApiClient(store);
    const root = mountHtml(`<div id="live-host"></div>`);
    const view = new LiveView(root.querySelector("#live-host")!, store, api);

    try {
      expect(root.textContent).toContain("Morning Warmup");
      const startBtn = root.querySelector<HTMLButtonElement>("[data-practice-act='start-session']")!;
      expect(startBtn).not.toBeNull();

      // Clicking Start while a race is ongoing opens ConfirmPreemptModal instead of immediately starting
      startBtn.click();
      const modal = document.querySelector<HTMLElement>(".slaprf-modal-backdrop");
      expect(modal).not.toBeNull();
      expect(modal!.textContent).toContain("Friday Night Brawl");
      expect(calls.filter((c) => c.method === "practiceAction")).toHaveLength(0);

      // Confirming preempt modal invokes practiceAction
      modal!.querySelector<HTMLButtonElement>("[data-preempt-ok]")!.click();
      await flushMicrotasks();
      expect(calls.some((c) => c.method === "practiceAction")).toBe(true);
    } finally {
      view.destroy();
    }
  });

  it("mounts PilotView scoped analytics and renders personal best, consistency, lap comparison, and section splits", () => {
    const laps = [
      makeLap(1, 1, 1, 12.8, {
        isBestLap: false,
        sectors: [
          makeSectorSplit(0, 1, 2, 4.3),
          makeSectorSplit(1, 2, 3, 4.4),
          makeSectorSplit(2, 3, 1, 4.1),
        ],
      }),
      makeLap(2, 1, 2, 12.1, {
        isBestLap: true,
        sectors: [
          makeSectorSplit(0, 1, 2, 4.0, { badge: "BEST" }),
          makeSectorSplit(1, 2, 3, 4.1, { badge: "BEST" }),
          makeSectorSplit(2, 3, 1, 4.0, { badge: "BEST" }),
        ],
      }),
      makeLap(3, 1, 3, 12.4, {
        isBestLap: false,
        sectors: [
          makeSectorSplit(0, 1, 2, 4.1),
          makeSectorSplit(1, 2, 3, 4.3, { deltaToBestSec: 0.2 }),
          makeSectorSplit(2, 3, 1, 4.0),
        ],
      }),
    ];
    const session = makePracticeSession("prac-analytics", {
      name: "Track Day",
      active: true,
      laps,
    });
    const store = makeStore({
      pilots: [makePilot(1, { callsign: "Vortex" }), makePilot(2, { callsign: "Blaze" })],
      gates: [makeGate(1), makeGate(2), makeGate(3)],
      laps,
      practiceState: {
        initialized: true,
        activeSessionId: "prac-analytics",
        selectedSessionId: "prac-analytics",
        sessions: [session],
      },
    });

    setAnalyticsScope({ kind: "practice", id: "prac-analytics" });
    focusAnalyticsPilotForScope("practice", "prac-analytics", 1);
    window.history.replaceState(null, "", "/#/pilot/practices/track-day");

    const root = mountHtml(`<div id="pilot-host"></div>`);
    const view = new PilotView(root.querySelector("#pilot-host")!, store);

    try {
      expect(root.textContent).toContain("Vortex");
      expect(root.textContent).toContain("12.10");
      expect(root.querySelector("[data-slot='compare']")?.innerHTML.length).toBeGreaterThan(20);
      expect(root.querySelector("[data-slot='section-stats']")?.innerHTML.length).toBeGreaterThan(20);
    } finally {
      view.destroy();
    }
  });

  it("mounts TopBar with Router + Announcer and updates breadcrumbs on route navigation", () => {
    window.history.replaceState(null, "", "/#/races");
    const store = makeStore();
    const { api } = makeMockApiClient(store);
    const router = new Router();
    const announcer = new Announcer(store);
    const root = mountHtml(`<header id="topbar-host" style="width:1280px"></header>`);
    const topbar = new TopBar(root.querySelector("#topbar-host")!, store, api, router, announcer);

    try {
      expect(root.textContent).toContain("Race");

      router.navigateSection("pilots");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
      expect(window.location.hash).toContain("#/pilots");
      expect(root.textContent).toContain("Pilots");
    } finally {
      topbar.destroy();
      router.clearListeners();
      announcer.update({ enabled: false });
    }
  });

  it("supports clickable all-laps modal with neon-green consecutive-3, hammer penalty cycling, 4-way status dropdown, Re-run Heat modal, Close Stage modal, and Open Qualifier fair rotation + Away queue", async () => {
    window.localStorage.setItem(
      "slaprf.races.controlLayout.v2",
      JSON.stringify({
        controlPanels: {
          cockpit: { x: 0, y: 0, visible: true, collapsed: false, zIndex: 950, userMoved: false },
          heatline: { x: 0, y: 214, visible: true, collapsed: false, zIndex: 960, userMoved: false },
        },
      })
    );
    window.history.replaceState(null, "", "/#/races/oq-friday/control");

    const sevenLaps = [
      { crossingId: 101, lapNumber: 0, splitTimeSec: 1.4, timestampUs: 1_400_000 },
      { crossingId: 102, lapNumber: 1, splitTimeSec: 13.5, timestampUs: 14_900_000 },
      { crossingId: 103, lapNumber: 2, splitTimeSec: 11.2, timestampUs: 26_100_000 },
      { crossingId: 104, lapNumber: 3, splitTimeSec: 11.1, timestampUs: 37_200_000 },
      { crossingId: 105, lapNumber: 4, splitTimeSec: 11.3, timestampUs: 48_500_000 },
      { crossingId: 106, lapNumber: 5, splitTimeSec: 12.8, timestampUs: 61_300_000 },
      { crossingId: 107, lapNumber: 6, splitTimeSec: 12.9, timestampUs: 74_200_000 },
    ];

    const oqRace = buildTwoStageConfiguredRace({
      raceId: "oq-1",
      lifecycle: "active",
      activeStageIndex: 1,
      activeHeatId: "OQ-H2",
      config: {
        ...buildTwoStageConfiguredRace().config,
        eventName: "OQ Friday",
        format: "open_qualifier",
        qualifyingMetric: "consecutive_3",
      },
      stages: [
        {
          id: "stg-oq",
          index: 1,
          title: "Open Qualifier",
          format: "open_qualifier",
          status: "active",
          order: 1,
          prerequisitesMet: true,
          settings: { qualifyingMetric: "consecutive_3", maxPacksPerPilot: 0 },
        },
        {
          id: "stg-finals",
          index: 2,
          title: "Top 4 Finals",
          format: "single_elimination",
          status: "pending",
          order: 2,
          prerequisitesMet: false,
        },
      ],
      stageConnections: [
        {
          id: "sc-1-2",
          fromStageId: "stg-oq",
          toStageId: "stg-finals",
          fromStageIndex: 1,
          toStageIndex: 2,
          rule: "top_n",
          count: 4,
        },
      ],
      roster: [
        { slotIndex: 1, callsign: "Alpha", color: "#38bdf8", seed: 1, checkedIn: true, attendance: "active" },
        { slotIndex: 2, callsign: "Bravo", color: "#f472b6", seed: 2, checkedIn: true, attendance: "active" },
        { slotIndex: 3, callsign: "Charlie", color: "#fbbf24", seed: 3, checkedIn: true, attendance: "away" },
      ],
      heats: [
        {
          id: "OQ-H1",
          stageIndex: 1,
          stageFormat: "open_qualifier",
          roundNumber: 1,
          heatNumber: 1,
          order: 1,
          title: "OQ Heat 1",
          shortLabel: "OQ-H1",
          state: "confirmed",
          startMode: "staggered",
          targetLaps: 0,
          timeLimitSec: 120,
          elapsedSec: 120,
          expectedWinners: 0,
          seats: [
            {
              seatIndex: 0,
              pilotSlotIndex: 1,
              callsign: "Alpha",
              color: "#38bdf8",
              channel: 1,
              frequencyMhz: 5658,
              status: "finished",
              position: 1,
              lapsCompleted: 6,
              totalTimeSec: 74.2,
              bestLapSec: 11.1,
              penaltySec: 0,
              laps: sevenLaps,
            },
          ],
        },
        {
          id: "OQ-H2",
          stageIndex: 1,
          stageFormat: "open_qualifier",
          roundNumber: 1,
          heatNumber: 2,
          order: 2,
          title: "OQ Heat 2",
          shortLabel: "OQ-H2",
          state: "finished",
          startMode: "staggered",
          targetLaps: 0,
          timeLimitSec: 120,
          elapsedSec: 90,
          expectedWinners: 0,
          seats: [
            {
              seatIndex: 0,
              pilotSlotIndex: 1,
              callsign: "Alpha",
              color: "#38bdf8",
              channel: 1,
              frequencyMhz: 5658,
              status: "finished",
              position: 1,
              lapsCompleted: 6,
              totalTimeSec: 74.2,
              bestLapSec: 11.1,
              penaltySec: 0,
              laps: sevenLaps,
            },
          ],
        },
      ],
    });

    const store = makeStore({
      simulatorRunning: true,
      raceState: oqRace,
      eventState: {
        initialized: true,
        activeRaceId: "oq-1",
        races: [oqRace],
      },
    });
    const announcer = new Announcer(store);
    announcer.update({ enabled: true, qualifierLapCallouts: true });
    const { api, calls } = makeMockApiClient(store);
    const root = mountHtml(`<div id="races-oq-host"></div>`);
    const view = new RacesView(root.querySelector("#races-oq-host")!, store, api, announcer);
    await flushMicrotasks();
    calls.length = 0;

    try {
      // 1. Inflated stored z-indices (950/960) are normalized back into compact range (< 50)
      const cockpitPanel = root.querySelector<HTMLElement>("[data-canvas-panel='cockpit']")!;
      expect(Number(cockpitPanel.style.zIndex)).toBeLessThan(50);

      // 2. Open Qualifier Flight Queue has All | Queued | Flying | Away filter bar (no "X active" badge),
      //    rotates Bravo (0 heats flown) ABOVE Alpha (just flew OQ-H1 & OQ-H2),
      //    and places Charlie (marked Away) in the bottom Away section with a "Ready" button
      const fqPanel = root.querySelector<HTMLElement>("[data-canvas-panel='flightline']")!;
      expect(fqPanel.querySelector(".rc-panel-header")?.textContent).not.toContain("active");
      const fqFilterBtns = Array.from(
        fqPanel.querySelectorAll<HTMLButtonElement>("[data-oq-queue-filter]")
      );
      expect(fqFilterBtns.map((b) => b.textContent?.trim())).toEqual([
        "All",
        "Queued",
        "Flying",
        "Away",
      ]);

      const oqBox = root.querySelector<HTMLElement>("[data-open-qual-flightline='1']")!;
      expect(oqBox).not.toBeNull();
      const oqRows = Array.from(oqBox.querySelectorAll<HTMLElement>("[data-oq-pilot-slot]"));
      expect(oqRows.map((r) => Number(r.dataset.oqPilotSlot))).toEqual([2, 1, 3]);
      expect(oqRows[0].querySelector("[data-att-status='away']")).not.toBeNull();
      expect(oqRows[2].dataset.oqAwayRow).toBe("1");
      expect(oqRows[2].querySelector("[data-att-status='active']")?.textContent?.trim()).toBe("Ready");

      // Filtering Flight Queue by "Away" hides active rows and shows Charlie
      fqPanel.querySelector<HTMLButtonElement>("[data-oq-queue-filter='away']")!.click();
      const oqRowsAfterAway = Array.from(
        root.querySelectorAll<HTMLElement>("[data-open-qual-flightline='1'] [data-oq-pilot-slot]")
      );
      expect(oqRowsAfterAway.filter((r) => !r.hidden).map((r) => Number(r.dataset.oqPilotSlot))).toEqual([3]);
      root.querySelector<HTMLButtonElement>("[data-oq-queue-filter='all']")!.click();

      // 3. Flight Line drops trailing Controls column in favor of thin leading drag-handle column,
      //    hammer penalty cell cycles penalty on click, and Status column opens 4-way pill-swapper dropdown
      const heatline = root.querySelector<HTMLElement>("[data-canvas-panel='heatline']")!;
      expect(heatline.querySelector(".race-marshal-more-btn")).toBeNull();
      expect(heatline.querySelector(".race-edit-laps-btn")).toBeNull();
      expect(heatline.querySelector("th.race-th-marshal")).toBeNull();
      expect(heatline.querySelector("td.race-td-controls")).toBeNull();
      expect(heatline.querySelector("td.col-drag [data-seat-drag-handle]")).not.toBeNull();

      const penBtn = heatline.querySelector<HTMLButtonElement>("td.col-pen .race-pen-hammer-btn")!;
      expect(penBtn).not.toBeNull();
      penBtn.click();
      await flushMicrotasks();
      expect(calls.some((c) => c.method === "raceMarshal" && (c.args[0] as { penaltySec?: number }).penaltySec === 5)).toBe(true);

      const statusTrigger = heatline.querySelector<HTMLButtonElement>("td.race-td-status .race-status-trigger")!;
      expect(statusTrigger).not.toBeNull();
      expect(statusTrigger.classList.contains("race-state-pill")).toBe(true);
      statusTrigger.click();
      const statusItems = Array.from(
        root.querySelectorAll<HTMLButtonElement>(".is-status-popover .rc-pill-swapper-option")
      );
      expect(statusItems.map((el) => el.getAttribute("data-marshal"))).toEqual([
        "set_dns",
        "set_dnf",
        "set_dq",
      ]);
      expect(statusItems[1].textContent?.trim()).toBe("Crashed Out");
      statusItems[1].click(); // Crashed Out
      await flushMicrotasks();
      expect(calls.some((c) => c.method === "raceMarshal" && (c.args[0] as { action?: string }).action === "set_dnf")).toBe(true);

      // 4. Clicking the NASCAR checkered flag button in Lap Timings opens the RSSI & Lap Timings Editor directly
      //    with Best 3-Lap (33.60s), neon-green .is-best-consec pins on L2, L3, L4 (11.2 + 11.1 + 11.3 = 33.60s),
      //    and neon-green .is-best-consec-time on their split times in the bottom table
      const flagBtn = root.querySelector<HTMLButtonElement>(".race-lap-flag-btn[data-open-lap-editor='1']")!;
      expect(flagBtn).not.toBeNull();
      flagBtn.click();
      const lapEdModal = document.querySelector<HTMLElement>(".lap-editor-modal")!;
      expect(lapEdModal).not.toBeNull();
      expect(lapEdModal.querySelector(".lap-ed-metrics-strip")?.textContent).toContain("33.60s");
      const consecPinIds = Array.from(
        lapEdModal.querySelectorAll<SVGGElement>("g.lap-ed-pin.is-best-consec")
      ).map((g) => Number(g.getAttribute("data-crossing-pin")));
      expect(consecPinIds).toEqual([103, 104, 105]);
      const consecSplitTexts = Array.from(
        lapEdModal.querySelectorAll<HTMLElement>(".lap-ed-table .is-best-consec-time")
      ).map((el) => el.textContent?.trim());
      expect(consecSplitTexts).toEqual(["11.20s", "11.10s", "11.30s"]);
      // Clicking Cross Out inside the RSSI editor toggles the crossing
      lapEdModal.querySelector<HTMLButtonElement>("[data-lap-ed-toggle='103']")!.click();
      await flushMicrotasks();
      expect(calls.some((c) => c.method === "raceMarshal" && (c.args[0] as { crossingId?: number }).crossingId === 103)).toBe(true);
      lapEdModal.querySelector<HTMLButtonElement>("[data-lap-ed-close]")!.click();
      expect(document.querySelector(".lap-editor-modal")).toBeNull();

      // 5. Clicking Re-run Heat opens a proper ConfirmModal (no inline confirm span inside cockpit)
      const rerunBtn = root.querySelector<HTMLButtonElement>("[data-ctrl='reset']")!;
      rerunBtn.click();
      expect(root.querySelector(".race-inline-confirm")).toBeNull();
      const rerunModal = document.querySelector<HTMLElement>(".slaprf-modal-backdrop")!;
      expect(rerunModal).not.toBeNull();
      expect(rerunModal.textContent).toContain("Re-run OQ-H2?");
      rerunModal.querySelector<HTMLButtonElement>("[data-modal-cancel]")!.click();

      // 6. Clicking Close Stage opens context-dependent Open Qualifier Close Stage modal explaining Stage 2 seeding
      const closeStageBtn = root.querySelector<HTMLButtonElement>("[data-race-act='close-stage-modal']")!;
      expect(closeStageBtn.disabled).toBe(false);
      closeStageBtn.click();
      const closeModal = document.querySelector<HTMLElement>(".slaprf-modal-backdrop")!;
      expect(closeModal).not.toBeNull();
      expect(closeModal.textContent).toContain("Close Open Qualifier");
      expect(closeModal.textContent).toContain("Stage 2: Top 4 Finals");
      closeModal.querySelector<HTMLButtonElement>("[data-modal-confirm]")!.click();
      await flushMicrotasks();
      expect(calls.some((c) => c.method === "stageControl" && c.args[0] === "complete_stage_early")).toBe(true);
    } finally {
      view.destroy();
      announcer.update({ enabled: false });
      document.querySelectorAll(".slaprf-modal-backdrop").forEach((el) => el.remove());
    }
  });

  it("covers countdown clock, 2-col bin-packing, All signal pill, schedule subtitle removal, and Review status dropdown + grayed-out confirmed rows", async () => {
    // 1. Countdown clock when timeLimitSec > 0, count-up when unlimited
    expect(formatHeatClockDisplay({ elapsedSec: 30.0, timeLimitSec: 120 })).toBe("01:30.0");
    expect(formatHeatClockDisplay({ elapsedSec: 125.0, timeLimitSec: 120 })).toBe("00:00.0");
    expect(formatHeatClockDisplay({ elapsedSec: 42.5, timeLimitSec: 0 })).toBe("00:42.5");

    // 2. 2-column bin-packing order for Open Qualifier (2w, 2w, 1w|1w, 2w, 2w)
    const packedOq = computeBinPackedControlLayout([
      { id: "cockpit", span: 2, visible: true, userMoved: false, x: 0, y: 0, width: 1180, height: 260 },
      { id: "heatline", span: 2, visible: true, userMoved: false, x: 0, y: 0, width: 1180, height: 348 },
      { id: "flightline", span: 1, visible: true, userMoved: false, x: 0, y: 0, width: 578, height: 360 },
      { id: "schedule", span: 1, visible: true, userMoved: false, x: 0, y: 0, width: 578, height: 360 },
      { id: "pilots", span: 1, visible: false, userMoved: false, x: 0, y: 0, width: 400, height: 360 },
      { id: "standings", span: 2, visible: true, userMoved: false, x: 0, y: 0, width: 1180, height: 360 },
      { id: "signals", span: 2, visible: true, userMoved: false, x: 0, y: 0, width: 1180, height: 420 },
    ]);
    expect(packedOq.cockpit).toEqual({ x: 64, y: 72 });
    expect(packedOq.heatline).toEqual({ x: 64, y: 354 });
    expect(packedOq.flightline).toEqual({ x: 64, y: 724 });
    expect(packedOq.schedule).toEqual({ x: 666, y: 724 });
    expect(packedOq.standings).toEqual({ x: 64, y: 1106 });
    expect(packedOq.signals).toEqual({ x: 64, y: 1488 });

    // 3. Control & Review UI verification
    const hConfirmed = makeHeat("Q1-1", {
      order: 1,
      shortLabel: "Q1-1",
      title: "Qualifying Round 1 · Heat 1",
      state: "confirmed",
      canUnlock: true,
      timeLimitSec: 120,
      elapsedSec: 45,
      executedAtMs: 1700000000000,
      seats: [
        makeSeat(1, 1, { callsign: "Alpha", channel: 1, status: "finished", position: 1 }),
        makeSeat(2, 2, { callsign: "Bravo", channel: 3, status: "finished", position: 2 }),
      ],
    });
    const hRunning = makeHeat("Q1-2", {
      order: 2,
      shortLabel: "Q1-2",
      title: "Qualifying Round 1 · Heat 2",
      state: "running",
      timeLimitSec: 120,
      elapsedSec: 25,
      seats: [
        makeSeat(1, 1, { callsign: "Alpha", channel: 1, status: "racing" }),
        makeSeat(2, 2, { callsign: "Bravo", channel: 3, status: "racing" }),
      ],
    });
    const race = makeRaceState({
      raceId: "batch12-race",
      generated: true,
      mode: "race",
      lifecycle: "active",
      activeStageIndex: 1,
      activeHeatId: "Q1-2",
      config: makeRaceSetupConfig({ eventName: "Batch 12 Cup" }),
      stages: [makeStage(1, { format: "qualifying", status: "active" })],
      heats: [hConfirmed, hRunning],
    });

    const store = makeStore({
      pilots: [makePilot(1, { callsign: "Alpha" }), makePilot(2, { callsign: "Bravo" })],
      gates: [makeGate(1)],
      raceState: race,
      eventState: {
        initialized: true,
        activeRaceId: "batch12-race",
        races: [race],
      },
    });
    const { api, calls } = makeMockApiClient(store);
    const announcer = new Announcer(store);
    window.history.replaceState(null, "", "/#/races/batch-12-cup/control");

    const root = mountHtml(`<div id="batch12-host" style="width:1440px;height:900px"></div>`);
    const view = new RacesView(root.querySelector("#batch12-host")!, store, api, announcer);
    await flushMicrotasks();
    calls.length = 0;

    try {
      // Countdown clock displays 01:35.0 (120 - 25) instead of 00:25.0
      const clockText = root.querySelector<HTMLElement>("[data-race-clock]")?.textContent ?? "";
      expect(clockText).toBe("01:35.0");

      // Signal panel selects a single pilot at a time (no "All" pill)
      const allSigPill = root.querySelector<HTMLButtonElement>('[data-race-sig-pilot="all"]');
      expect(allSigPill).toBeNull();
      const firstSigPill = root.querySelector<HTMLButtonElement>('[data-race-sig-pilot="1"]');
      expect(firstSigPill).not.toBeNull();
      expect(firstSigPill!.classList.contains("is-active")).toBe(true);

      // Schedule panel does NOT render .rc-sched-sub under Q1-1
      const schedPanel = root.querySelector<HTMLElement>('[data-canvas-panel="schedule"]');
      expect(schedPanel).not.toBeNull();
      expect(schedPanel!.querySelector(".rc-sched-sub")).toBeNull();

      // While Q1-2 is running, pilot Status pill is "Racing", and overriding to DNS then reopening offers "Racing" (set_racing)
      const liveStatusTrigger = root.querySelector<HTMLButtonElement>(
        '[data-canvas-panel="heatline"] td.race-td-status .race-status-trigger'
      )!;
      expect(liveStatusTrigger.textContent?.trim()).toBe("Racing");
      liveStatusTrigger.click();
      const liveStatusOpts = Array.from(
        root.querySelectorAll<HTMLButtonElement>(".is-status-popover .rc-pill-swapper-option")
      );
      expect(liveStatusOpts.map((el) => el.getAttribute("data-marshal"))).toEqual([
        "set_dns",
        "set_dnf",
        "set_dq",
      ]);
      liveStatusTrigger.click();

      // Switch to Review tab -> Confirmed heat table has .is-confirmed-locked, Executed Heats has a plain Status pill (no dropdown), and Heat Review has a sideways Review | Confirmed toggle
      root.querySelector<HTMLElement>('[data-race-tab="review"]')!.click();
      await flushMicrotasks();

      const reviewHeatPanel = root.querySelector<HTMLElement>('[data-canvas-panel="review_heat"]')!;
      expect(reviewHeatPanel.querySelector(".race-heat-table.is-confirmed-locked")).not.toBeNull();
      expect(reviewHeatPanel.querySelector('[data-ctrl="confirm"]')).toBeNull();

      const execTable = root.querySelector<HTMLElement>(".rc-executed-heats-table")!;
      expect(execTable).not.toBeNull();
      expect(execTable.querySelectorAll("thead th").length).toBe(4);
      expect(execTable.querySelector("[data-toggle-review-status-menu]")).toBeNull();
      expect(execTable.querySelector("button.race-state-pill")).toBeNull();
      const plainStatusPill = execTable.querySelector<HTMLElement>("span.race-state-pill");
      expect(plainStatusPill?.textContent).toContain("Confirmed");

      // Toggle sideways switcher in Heat Review from "Confirmed" -> "Review" -> calls raceControl("unlock", "Q1-1")
      const statusToggle = reviewHeatPanel.querySelector<HTMLElement>("[data-review-status-toggle]")!;
      expect(statusToggle).not.toBeNull();
      const confirmSegBtn = statusToggle.querySelector<HTMLButtonElement>('[data-set-review-status="confirm"]')!;
      const reviewSegBtn = statusToggle.querySelector<HTMLButtonElement>('[data-set-review-status="unlock"]')!;
      expect(confirmSegBtn.classList.contains("is-active")).toBe(true);
      expect(reviewSegBtn.classList.contains("is-active")).toBe(false);

      reviewSegBtn.click();
      await flushMicrotasks();
      expect(calls.some((c) => c.method === "raceControl" && c.args[0] === "unlock" && c.args[1] === "Q1-1")).toBe(true);
    } finally {
      view.destroy();
      announcer.update({ enabled: false });
    }
  });

  it("displays a normal 5s -> 0s countdown to the race controller and shows Beeped @ Xs once the randomized horn fires", async () => {
    const countdownHeat = makeHeat("Q1-1", {
      order: 1,
      state: "countdown",
      countdownDurationSec: 5,
      countdownRemainingSec: 3.8,
      timeLimitSec: 120,
      targetLaps: 3,
    });
    const race = makeRaceState({
      raceId: "cd-race",
      mode: "race",
      lifecycle: "active",
      activeHeatId: "Q1-1",
      heats: [countdownHeat],
    });
    race.config.eventName = "Countdown Cup";
    race.config.countdownSec = 5;

    const store = makeStore({
      pilots: [makePilot(1, { callsign: "Alpha" }), makePilot(2, { callsign: "Bravo" })],
      gates: [makeGate(1)],
      raceState: race,
      eventState: {
        initialized: true,
        activeRaceId: "cd-race",
        races: [race],
      },
    });
    const { api } = makeMockApiClient(store);
    const announcer = new Announcer(store);
    window.history.replaceState(null, "", "/#/races/countdown-cup/control");

    const root = mountHtml(`<div id="cd-race-host" style="width:1440px;height:900px"></div>`);
    const view = new RacesView(root.querySelector("#cd-race-host")!, store, api, announcer);
    await flushMicrotasks();

    try {
      const clockText = root.querySelector<HTMLElement>("[data-race-clock]")?.textContent ?? "";
      expect(/^00:03\.[78]$/.test(clockText)).toBe(true);
      expect(root.querySelector<HTMLElement>("[data-race-clock-sub]")?.textContent).toContain(
        "Countdown 5s → 0s · Random horn"
      );
      expect(root.querySelector("[data-race-beep-pill]")).toBeNull();

      // Verify arming pause state holds clock at 00:05.0 ("Arming quads…") before countdown begins
      const armingHeat = {
        ...countdownHeat,
        countdownRemainingSec: 5,
        countdownArmRemainingSec: 3.5,
      };
      store.ingestRace({ ...race, heats: [armingHeat] });
      await flushMicrotasks();
      expect(root.querySelector<HTMLElement>("[data-race-clock]")?.textContent).toBe("00:05.0");
      expect(root.querySelector<HTMLElement>("[data-race-clock-sub]")?.textContent).toBe(
        "Arming quads…"
      );

      // Simulate start horn firing early at 1.4s remaining on the 5s -> 0s countdown:
      // Zero "Beeped @" pill is shown — race controller simply observes the clock directly.
      const runningHeat = {
        ...countdownHeat,
        state: "running" as const,
        countdownRemainingSec: 0,
        countdownArmRemainingSec: 0,
        countdownBeeped: true,
        countdownBeepAtSec: 1.4,
        elapsedSec: 0.2,
      };
      const runningRace = { ...race, heats: [runningHeat] };
      store.ingestRace(runningRace);
      await flushMicrotasks();

      expect(root.querySelector("[data-race-beep-pill]")).toBeNull();

      // Verify loud-horn button is disabled when Announcer is OFF, and speaks "Lap announcements off" / "Lap announcements on" when ON
      const spokenTexts: string[] = [];
      const origSpeak = window.speechSynthesis?.speak?.bind(window.speechSynthesis);
      if (window.speechSynthesis) {
        window.speechSynthesis.speak = ((utt: SpeechSynthesisUtterance) => {
          spokenTexts.push(utt.text);
        }) as typeof window.speechSynthesis.speak;
      }
      try {
        const getHornBtn = () => root.querySelector<HTMLButtonElement>("[data-toggle-race-lap-callouts]")!;
        announcer.update({ enabled: false });
        await flushMicrotasks();
        expect(getHornBtn().disabled).toBe(true);

        const stageFmt = getHornBtn().dataset.toggleRaceLapCallouts || "";
        announcer.update({
          enabled: true,
          qualifierLapCallouts: true,
          raceLapCallouts: true,
        });
        await flushMicrotasks();
        expect(getHornBtn().disabled).toBe(false);
        expect(announcer.isLapCalloutsActiveForStage(stageFmt)).toBe(true);

        getHornBtn().click();
        expect(announcer.isLapCalloutsActiveForStage(stageFmt)).toBe(false);
        const queuedOrSpokenOff =
          spokenTexts.some((t) => t === "Lap announcements off") ||
          ((announcer as unknown as { queue: Array<{ text: string }> }).queue ?? []).some(
            (q) => q.text === "Lap announcements off"
          );
        expect(queuedOrSpokenOff).toBe(true);

        getHornBtn().click();
        expect(announcer.isLapCalloutsActiveForStage(stageFmt)).toBe(true);
        const queuedOrSpokenOn =
          spokenTexts.some((t) => t === "Lap announcements on") ||
          ((announcer as unknown as { queue: Array<{ text: string }> }).queue ?? []).some(
            (q) => q.text === "Lap announcements on"
          );
        expect(queuedOrSpokenOn).toBe(true);
      } finally {
        if (window.speechSynthesis && origSpeak) {
          window.speechSynthesis.speak = origSpeak;
        }
      }
    } finally {
      view.destroy();
      announcer.update({ enabled: false });
    }
  });

  it("keeps Review & Flight Line rows stationary when laps/positions change and re-sorts via the header arrow before Pos", async () => {
    const hDone = makeHeat("Q1-1", {
      order: 1,
      shortLabel: "Q1-1",
      state: "finished",
      executedAtMs: 1700000000000,
      targetLaps: 2,
      seats: [
        makeSeat(1, 1, {
          callsign: "Alpha",
          channel: 1,
          status: "finished",
          position: 1,
          lapsCompleted: 2,
          lapTimesMs: [10000, 10200],
        }),
        makeSeat(2, 2, {
          callsign: "Bravo",
          channel: 3,
          status: "finished",
          position: 2,
          lapsCompleted: 2,
          lapTimesMs: [11000, 11200],
        }),
      ],
    });
    const race = makeRaceState({
      raceId: "sort-race",
      generated: true,
      mode: "race",
      lifecycle: "active",
      activeStageIndex: 1,
      activeHeatId: "Q1-1",
      config: makeRaceSetupConfig({ eventName: "Sort Cup" }),
      stages: [makeStage(1, { format: "qualifying", status: "active" })],
      heats: [hDone],
    });

    const store = makeStore({
      pilots: [makePilot(1, { callsign: "Alpha" }), makePilot(2, { callsign: "Bravo" })],
      gates: [makeGate(1)],
      raceState: race,
      eventState: {
        initialized: true,
        activeRaceId: "sort-race",
        races: [race],
      },
    });
    const { api } = makeMockApiClient(store);
    const announcer = new Announcer(store);
    window.history.replaceState(null, "", "/#/races/sort-cup/review");

    const root = mountHtml(`<div id="sort-race-host" style="width:1440px;height:900px"></div>`);
    const view = new RacesView(root.querySelector("#sort-race-host")!, store, api, announcer);
    await flushMicrotasks();

    try {
      const getReviewRowCallsigns = () =>
        Array.from(
          root.querySelectorAll<HTMLElement>('[data-canvas-panel="review_heat"] tbody tr[data-seat-index]')
        ).map((tr) => tr.querySelector(".race-pilot-name strong")?.textContent?.trim() ?? "");
      const getReviewRowPositions = () =>
        Array.from(
          root.querySelectorAll<HTMLElement>('[data-canvas-panel="review_heat"] tbody tr[data-seat-index] td.col-pos')
        ).map((td) => td.textContent?.trim() ?? "");

      expect(getReviewRowCallsigns()).toEqual(["Alpha", "Bravo"]);
      expect(getReviewRowPositions()).toEqual(["1", "2"]);

      // Simulate crossing out a lap on Alpha so Bravo becomes Pos 1 and Alpha becomes Pos 2:
      // Rows must stay stationary (Alpha still top row, Bravo second row) while Pos updates in place!
      const hAfterCrossOut = {
        ...hDone,
        seats: [
          {
            ...hDone.seats[0],
            position: 2,
            lapsCompleted: 1,
            lapTimesMs: [10000],
            invalidatedLaps: [{ lapIndex: 2, lapTimeMs: 10200 }],
          },
          {
            ...hDone.seats[1],
            position: 1,
          },
        ],
      };
      store.ingestRace({ ...race, heats: [hAfterCrossOut] });
      await flushMicrotasks();

      expect(getReviewRowCallsigns()).toEqual(["Alpha", "Bravo"]);
      expect(getReviewRowPositions()).toEqual(["2", "1"]);

      // Clicking the sort arrow in the first header column (before Pos) re-sorts rows by Pos (1, 2)
      const sortBtn = root.querySelector<HTMLButtonElement>(
        '[data-canvas-panel="review_heat"] thead th.col-drag [data-sort-heat-rows="Q1-1"][data-sort-table-scope="review"]'
      )!;
      expect(sortBtn).not.toBeNull();
      sortBtn.click();
      await flushMicrotasks();

      expect(getReviewRowCallsigns()).toEqual(["Bravo", "Alpha"]);
      expect(getReviewRowPositions()).toEqual(["1", "2"]);
    } finally {
      view.destroy();
      announcer.update({ enabled: false });
    }
  });

  it("dispatches reopen_race from Race Control header when tournament is completed and unlocks controls", async () => {
    window.localStorage.setItem(
      "slaprf.races.controlLayout.v2",
      JSON.stringify({
        controlPanels: {
          cockpit: { x: 0, y: 0, visible: true, collapsed: false, zIndex: 950, userMoved: false },
          heatline: { x: 0, y: 214, visible: true, collapsed: false, zIndex: 960, userMoved: false },
        },
      })
    );
    window.history.replaceState(null, "", "/#/races/friday-night/control");

    const gfRound = makeRound("gf-r1", {
      stageIndex: 2,
      round: 1,
      column: 1,
      bracketLane: "finals",
      stageFormat: "single_elimination",
      title: "Grand Final",
    });
    const gfHeat = makeHeat("GF-1", {
      id: "GF-1",
      roundId: "gf-r1",
      stageIndex: 2,
      stageFormat: "single_elimination",
      bracketLane: "finals",
      order: 1,
      title: "Grand Final",
      shortLabel: "GF-1",
      state: "confirmed",
      canUnlock: true,
      targetLaps: 3,
      seats: [
        makeSeat(0, 1, {
          callsign: "Alpha",
          channel: 1,
          status: "finished",
          position: 1,
          lapsCompleted: 3,
        }),
      ],
    });
    const completedRace = buildTwoStageConfiguredRace({
      raceId: "race-done-1",
      generated: true,
      mode: "race",
      lifecycle: "completed",
      isComplete: true,
      activeStageIndex: 2,
      activeHeatId: "GF-1",
      config: makeRaceSetupConfig({ eventName: "Friday Night" }),
      stages: [
        makeStage(1, { id: "stage-1", index: 1, title: "Qualifying", format: "qualifying", status: "completed", prerequisitesMet: true }),
        makeStage(2, { id: "stage-2", index: 2, title: "Finals", format: "single_elimination", status: "completed", prerequisitesMet: true }),
      ],
      rounds: [gfRound],
      heats: [gfHeat],
    });
    const store = makeStore({
      practiceState: { initialized: true, activeSessionId: "", selectedSessionId: "", sessions: [] },
      raceState: completedRace,
      eventState: {
        initialized: true,
        activeRaceId: "race-done-1",
        races: [completedRace],
      },
    });
    const { api } = makeMockApiClient(store);
    const origEventAction = api.eventAction.bind(api);
    let reopenPayload: Record<string, unknown> | null = null;
    api.eventAction = async (payload) => {
      if (payload.action !== "race_lifecycle" || payload.lifecycleAction !== "reopen_race") {
        return origEventAction(payload);
      }
      reopenPayload = payload as unknown as Record<string, unknown>;
      const reopened = {
        ...completedRace,
        lifecycle: "active" as const,
        isComplete: false,
        stages: [
          completedRace.stages[0],
          { ...completedRace.stages[1], status: "active" as const },
        ],
        heats: [
          {
            ...completedRace.heats[0],
            state: "finished" as const,
            canUnlock: false,
          },
        ],
      };
      store.hydrate({
        ...storeSnapshotFrom(store),
        raceState: reopened,
        eventState: {
          initialized: true,
          activeRaceId: "race-done-1",
          races: [reopened],
        },
      });
    };
    const announcer = new Announcer(store);
    announcer.update({ enabled: false });

    const root = mountHtml(`<div id="races-reopen-host" style="width:1440px;height:900px"></div>`);
    const view = new RacesView(root.querySelector("#races-reopen-host")!, store, api, announcer);
    await flushMicrotasks();

    try {
      const reopenBtn = root.querySelector<HTMLButtonElement>(
        '[data-canvas-panel="cockpit"] [data-race-act="lifecycle-direct"][data-lifecycle-act="reopen_race"]'
      );
      expect(reopenBtn).not.toBeNull();
      reopenBtn!.click();
      await flushMicrotasks();

      expect(reopenPayload?.["action"]).toBe("race_lifecycle");
      expect(reopenPayload?.["raceId"]).toBe("race-done-1");
      expect(reopenPayload?.["lifecycleAction"]).toBe("reopen_race");
      expect(
        root.querySelector('[data-canvas-panel="cockpit"] [data-ctrl="confirm"][data-heat-id="GF-1"]')
      ).not.toBeNull();
      expect(
        root.querySelector('[data-canvas-panel="cockpit"] [data-ctrl="reset"][data-heat-id="GF-1"]')
      ).not.toBeNull();
    } finally {
      view.destroy();
    }
  });

  it("renders Race Control status notice box above bottom bar when progression is blocked or paused, and keeps confirmed strip accurate", async () => {
    window.history.replaceState(null, "", "/#/races/oq-notice-test/control");
    const makeOqRace = (overrides?: Partial<ReturnType<typeof buildTwoStageConfiguredRace>>) =>
      buildTwoStageConfiguredRace({
        raceId: "oq-notice-1",
        lifecycle: "active",
        activeStageIndex: 1,
        activeHeatId: "OQ-H1",
        nextReadyHeatId: "",
        config: {
          ...buildTwoStageConfiguredRace().config,
          eventName: "OQ Notice Test",
        },
        stages: [
          {
            id: "stg-oq",
            index: 1,
            title: "Open Qualifier",
            format: "open_qualifier",
            status: "active",
            order: 1,
            prerequisitesMet: true,
          },
        ],
        stageConnections: [],
        roster: [
          { slotIndex: 1, callsign: "Alpha", color: "#38bdf8", seed: 1, checkedIn: true, attendance: "active" },
          { slotIndex: 2, callsign: "Bravo", color: "#f472b6", seed: 2, checkedIn: true, attendance: "active" },
        ],
        heats: [
          {
            id: "OQ-H1",
            stageIndex: 1,
            stageFormat: "open_qualifier",
            roundNumber: 1,
            heatNumber: 1,
            order: 1,
            title: "OQ Heat 1",
            shortLabel: "OQ-H1",
            state: "confirmed",
            startMode: "staggered",
            targetLaps: 0,
            timeLimitSec: 120,
            elapsedSec: 120,
            expectedWinners: 0,
            seats: [
              {
                seatIndex: 0,
                pilotSlotIndex: 1,
                callsign: "Alpha",
                color: "#38bdf8",
                channel: 1,
                frequencyMhz: 5658,
                status: "finished",
                position: 1,
                lapsCompleted: 5,
                totalTimeSec: 60.0,
                bestLapSec: 11.5,
                penaltySec: 0,
                laps: [],
              },
            ],
          },
        ],
        ...overrides,
      });

    const initialRace = makeOqRace();
    const store = makeStore({
      simulatorRunning: true,
      raceState: initialRace,
      eventState: {
        initialized: true,
        activeRaceId: "oq-notice-1",
        races: [initialRace],
      },
    });
    const announcer = new Announcer(store);
    announcer.update({ enabled: false });
    const { api } = makeMockApiClient(store);
    const root = mountHtml(`<div id="races-oq-notice-host" style="width:1440px;height:900px"></div>`);
    const view = new RacesView(root.querySelector("#races-oq-notice-host")!, store, api, announcer);
    await flushMicrotasks();

    const hydrateRace = (nextRace: ReturnType<typeof makeOqRace>) => {
      store.hydrate({
        ...storeSnapshotFrom(store),
        raceState: nextRace,
        eventState: {
          initialized: true,
          activeRaceId: "oq-notice-1",
          races: [nextRace],
        },
      });
    };

    try {
      const cockpit = () => root.querySelector<HTMLElement>('[data-canvas-panel="cockpit"]')!;

      // 1. Open Qualifier confirmed with no queued heats:
      //    - Notice box appears directly above .race-cockpit-bottom with info icon + "Please queue up more pilots..."
      //    - Right-hand controller strip does NOT claim "click Next Heat"
      const noticeOqEmpty = cockpit().querySelector<HTMLElement>("[data-race-cockpit-notice]");
      expect(noticeOqEmpty).not.toBeNull();
      expect(noticeOqEmpty!.nextElementSibling?.classList.contains("race-cockpit-bottom")).toBe(true);
      expect(noticeOqEmpty!.querySelector(".race-cockpit-notice-icon svg")).not.toBeNull();
      expect(noticeOqEmpty!.textContent).toContain("Please queue up more pilots");
      const rightStripOqEmpty = cockpit().querySelector<HTMLElement>("[data-race-controller-strip]")!;
      expect(rightStripOqEmpty.textContent).toContain("waiting for pilots to be queued");
      expect(rightStripOqEmpty.textContent).not.toContain("Next Heat");

      // 2. When a next heat IS queued (OQ-H2 staged), notice box disappears and Next Heat + accurate strip appear
      hydrateRace(
        makeOqRace({
          nextReadyHeatId: "OQ-H2",
          heats: [
            ...initialRace.heats,
            {
              ...initialRace.heats[0],
              id: "OQ-H2",
              heatNumber: 2,
              order: 2,
              title: "OQ Heat 2",
              shortLabel: "OQ-H2",
              state: "staged",
            },
          ],
        })
      );
      const placeholderNotice = cockpit().querySelector<HTMLElement>("[data-race-cockpit-notice]");
      expect(placeholderNotice).not.toBeNull();
      expect(placeholderNotice!.classList.contains("is-placeholder")).toBe(true);
      const nextHeatBtn = cockpit().querySelector<HTMLButtonElement>("[data-load-next-ready='1']");
      expect(nextHeatBtn).not.toBeNull();
      expect(nextHeatBtn!.disabled).toBe(false);
      // Complete Qualifier button lives in Race Control transport bar (not in Flight Queue)
      const completeInCockpit = cockpit().querySelector<HTMLButtonElement>("[data-oq-act='complete_qualifier']");
      const completeInFlightQueue = root.querySelector("[data-open-qual-flightline] [data-oq-act='complete_qualifier']");
      expect(completeInCockpit).not.toBeNull();
      expect(completeInFlightQueue).toBeNull();
      expect(cockpit().querySelector("[data-race-controller-strip]")?.textContent).toContain("Next Heat");

      // 3. When race is paused, notice box tells director to mark the race as Active
      hydrateRace(
        makeOqRace({
          lifecycle: "paused",
          statusReason: "Race paused",
          activeHeatId: "OQ-H2",
          heats: [
            initialRace.heats[0],
            {
              ...initialRace.heats[0],
              id: "OQ-H2",
              heatNumber: 2,
              order: 2,
              title: "OQ Heat 2",
              shortLabel: "OQ-H2",
              state: "staged",
            },
          ],
        })
      );
      const pausedNotice = cockpit().querySelector<HTMLElement>("[data-race-cockpit-notice]");
      expect(pausedNotice).not.toBeNull();
      expect(pausedNotice!.textContent).toContain("mark the race as Active above to continue running heats");

      // 4. When stage is closed early in a multi-stage race (Stage 2 disconnected), notice box says stage is closed + Reopen Stage button appears
      hydrateRace(
        makeOqRace({
          lifecycle: "active",
          stages: [
            {
              id: "stg-oq",
              index: 1,
              title: "Open Qualifier",
              format: "open_qualifier",
              status: "completed",
              completedEarly: true,
              order: 1,
              prerequisitesMet: true,
            },
            {
              id: "stg-s2",
              index: 2,
              title: "Finals",
              format: "single_elimination",
              status: "pending",
              dangling: true,
              order: 2,
              prerequisitesMet: false,
            },
          ],
        })
      );
      const closedStageNotice = cockpit().querySelector<HTMLElement>("[data-race-cockpit-notice]");
      expect(closedStageNotice).not.toBeNull();
      expect(closedStageNotice!.textContent).toContain("This stage is closed");
      expect(closedStageNotice!.textContent).toContain("Reopen Stage");
      expect(cockpit().querySelector("[data-stage-ctrl='reopen_stage_early']")).not.toBeNull();
    } finally {
      view.destroy();
    }
  });
});

function storeSnapshotFrom(store: ReturnType<typeof makeStore>) {
  return {
    serverTimestampUs: store.serverTimestampUs,
    timingHardwareMode: store.timingHardwareMode,
    pilots: store.pilots,
    gates: store.nodes,
    timers: store.timers,
    laps: store.laps,
    crossings: store.crossings,
    filtered: store.filtered,
    summaries: store.summaries,
    rules: store.rules,
    simulatorRunning: store.simulatorRunning,
    raceArmed: store.raceArmed,
    liveTimeStatus: store.liveTimeStatus,
    raceState: store.raceState,
    eventState: store.eventState,
    practiceState: store.practiceState,
  };
}
