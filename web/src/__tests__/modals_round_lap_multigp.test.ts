import { sharedMultiGPService } from "../services/multigp_service";
import { ensureCanvasSelectGlobalBinding } from "../widgets/CanvasSelect";
import {
  closeActiveLapEditorModal,
  openHeatLapEditorModal,
} from "../widgets/HeatLapEditorModal";
import {
  closeActiveMultiGPModal,
  openMultiGPImportModal,
  openMultiGPSyncModal,
} from "../widgets/MultiGPRaceModals";
import {
  closeActiveRoundModal,
  openRaceSettingsModal,
  openStageSettingsModal,
  openTemplatesModal,
} from "../widgets/RoundModals";
import {
  describe,
  expect,
  flushMicrotasks,
  fn,
  it,
  makeGate,
  makeHeat,
  makeHeatLap,
  makeMockApiClient,
  makePilot,
  makeRaceSetupConfig,
  makeRaceState,
  makeSeat,
  makeStage,
  makeStore,
  spyOn,
} from "./harness";

describe("widgets/RoundModals — Templates, Race Settings & Stage Settings", () => {
  it("switches preview pane in openTemplatesModal, applies preset templates, and triggers Custom callback", () => {
    const race = makeRaceState({ generated: false, heats: [] });
    const onApply = fn<[string, { pilotsPerHeat: number; targetLaps: number; timeLimitSec: number; qualifyingRounds: number }]>();
    const onSelectCustom = fn();

    openTemplatesModal({
      race,
      templates: [
        {
          id: "double_elimination",
          title: "Double Elimination",
          tag: "Classic Bracket",
          desc: "Upper and lower brackets leading to finals.",
        },
        {
          id: "qual_double_elim",
          title: "Qualifying + Double Elim",
          tag: "2-Stage Event",
          desc: "Consecutive-lap seeding into double elimination.",
        },
      ],
      initialParams: {
        pilotsPerHeat: 4,
        targetLaps: 3,
        timeLimitSec: 120,
        qualifyingRounds: 2,
      },
      onApply,
      onSelectCustom,
    });

    const backdrop = document.querySelector<HTMLElement>(".slaprf-modal-backdrop")!;
    expect(backdrop).not.toBeNull();
    expect(backdrop.textContent).toContain("Choose Race Format");

    // Select second preset card -> preview pane updates immediately
    backdrop.querySelector<HTMLButtonElement>("[data-modal-pick-tpl='qual_double_elim']")!.click();
    expect(backdrop.querySelector("[data-tpl-detail-pane]")?.textContent).toContain(
      "2 Stages · Qualifying → Double Elimination"
    );

    // Click Continue -> applies selected preset with sanitized params and closes modal
    backdrop.querySelector<HTMLButtonElement>("[data-tpl-confirm]")!.click();
    expect(onApply.calls).toHaveLength(1);
    expect(onApply.calls[0][0]).toBe("qual_double_elim");
    expect(onApply.calls[0][1].pilotsPerHeat).toBe(4);
    expect(document.querySelector(".slaprf-modal-backdrop")).toBeNull();

    // Re-open and pick "custom" -> calls onSelectCustom instead of onApply
    openTemplatesModal({
      race,
      templates: [
        { id: "double_elimination", title: "Double Elimination", tag: "Bracket", desc: "DE" },
      ],
      initialParams: { pilotsPerHeat: 4, targetLaps: 3, timeLimitSec: 120, qualifyingRounds: 2 },
      onApply,
      onSelectCustom,
    });
    const backdrop2 = document.querySelector<HTMLElement>(".slaprf-modal-backdrop")!;
    backdrop2.querySelector<HTMLButtonElement>("[data-modal-pick-tpl='custom']")!.click();
    backdrop2.querySelector<HTMLButtonElement>("[data-tpl-confirm]")!.click();
    expect(onSelectCustom.calls).toHaveLength(1);
    expect(onApply.calls).toHaveLength(1);
    closeActiveRoundModal();
  });

  it("edits race name, tags, and seat channels (auto-swapping duplicate channels) in openRaceSettingsModal", async () => {
    ensureCanvasSelectGlobalBinding();
    const race = makeRaceState({
      raceId: "race-99",
      tags: ["Outdoor"],
      config: makeRaceSetupConfig({
        eventName: "Spring Opener",
        pilotsPerHeat: 4,
        seatChannels: [1, 3, 5, 8],
        targetLaps: 3,
        timeLimitSec: 120,
      }),
      heats: [
        makeHeat("W1-H1", { state: "confirmed" }),
        makeHeat("W1-H2", { state: "staged" }),
      ],
    });
    const store = makeStore({ raceState: race });
    const { api, calls } = makeMockApiClient(store);
    const onError = fn<[string]>();

    openRaceSettingsModal({
      getRace: () => race,
      getAllTags: () => ["Outdoor", "Finals", "5-inch"],
      api,
      onError,
    });

    const backdrop = document.querySelector<HTMLElement>(".slaprf-modal-backdrop")!;
    expect(backdrop).not.toBeNull();
    // Informational note shows unstarted vs started heat breakdown with neutral (i) icon
    const heatsNote = backdrop.querySelector<HTMLElement>("[data-modal-heats-info]")!;
    expect(heatsNote).not.toBeNull();
    expect(heatsNote.querySelector("svg")).not.toBeNull();
    expect(heatsNote.textContent).toContain("1 unstarted");

    // Type custom tags "Finals, Night" in the tag input (no tag suggestions shown)
    expect(backdrop.querySelector("[data-modal-suggest-tag]")).toBeNull();
    const tagInput = backdrop.querySelector<HTMLInputElement>("[data-tag-box-input]")!;
    tagInput.value = "Finals, Night";

    // Swap Seat 1 channel from R1 -> R3 (already occupied by Seat 2) -> Seat 2 automatically swaps to R1!
    const seat0Trigger = backdrop.querySelector<HTMLButtonElement>("[data-modal-seat-idx='0']")!;
    seat0Trigger.dispatchEvent(
      new CustomEvent("canvas-select-change", {
        bubbles: true,
        detail: { value: "3", label: "R3" },
      })
    );

    // Rename race & adjust default laps
    const nameInput = backdrop.querySelector<HTMLInputElement>("[data-modal-race-name]")!;
    nameInput.value = "Summer Showdown";
    const lapsInput = backdrop.querySelector<HTMLInputElement>("[data-modal-default-laps]")!;
    lapsInput.value = "4";

    backdrop.querySelector<HTMLButtonElement>("[data-modal-save-settings]")!.click();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(onError.calls).toHaveLength(0);
    const renameCall = calls.find(
      (c) => c.method === "eventAction" && (c.args[0] as { action: string }).action === "rename_race"
    );
    expect(renameCall).toBeDefined();
    expect((renameCall!.args[0] as { name: string }).name).toBe("Summer Showdown");

    const tagsCall = calls.find(
      (c) => c.method === "eventAction" && (c.args[0] as { action: string }).action === "set_race_tags"
    );
    expect(tagsCall).toBeDefined();
    expect((tagsCall!.args[0] as { tags: string[] }).tags).toEqual(["Outdoor", "Finals", "Night"]);

    const cfgCall = calls.find((c) => c.method === "configureRace");
    expect(cfgCall).toBeDefined();
    const savedCfg = cfgCall!.args[0] as { seatChannels: number[]; targetLaps: number };
    expect(savedCfg.seatChannels).toEqual([3, 1, 5, 8]); // Seat 1 & Seat 2 cleanly swapped!
    expect(savedCfg.targetLaps).toBe(4);
    expect(document.querySelector(".slaprf-modal-backdrop")).toBeNull();
  });

  it("opens openStageSettingsModal for Qualifying stage and saves stage-level overrides", async () => {
    const race = makeRaceState({
      raceId: "race-stg",
      stages: [
        makeStage(1, {
          id: "stage-1",
          index: 1,
          title: "Qualifying",
          format: "qualifying",
        }),
      ],
    });
    const store = makeStore({ raceState: race });
    const { api, calls } = makeMockApiClient(store);
    const onError = fn<[string]>();

    openStageSettingsModal({
      stageIndex: 1,
      getRace: () => race,
      api,
      onError,
    });

    const backdrop = document.querySelector<HTMLElement>(".slaprf-modal-backdrop")!;
    expect(backdrop).not.toBeNull();
    expect(backdrop.textContent).toContain("Qualifying");

    const saveBtn = backdrop.querySelector<HTMLButtonElement>("button.btn-armed")!;
    expect(saveBtn).not.toBeNull();
    saveBtn.click();
    await flushMicrotasks();

    expect(onError.calls).toHaveLength(0);
    expect(calls.length).toBeGreaterThan(0);
    closeActiveRoundModal();
  });
});

describe("widgets/HeatLapEditorModal — RSSI Trace, Crossing Pins & Marshal Actions", () => {
  it("renders RSSI SVG trace & crossing rows, switches pilots/gates, dispatches marshal actions, and exits addMode on first Escape", async () => {
    const heat = makeHeat("Q1-H1", {
      state: "finished",
      seats: [
        makeSeat(0, 1, {
          callsign: "Maverick",
          enterRssiDbm: -56,
          exitRssiDbm: -66,
          holeshotSec: 1.4,
          lapsCompleted: 2,
          laps: [
            makeHeatLap(101, 1, 12.4, { raceElapsedSec: 13.8 }),
            makeHeatLap(102, 2, 11.9, { raceElapsedSec: 25.7 }),
          ],
          rssiTrace: [
            { t: 0, r: -88 },
            { t: 1400, r: -44 },
            { t: 7000, r: -89 },
            { t: 13800, r: -42 },
            { t: 25700, r: -45 },
          ],
        }),
        makeSeat(1, 2, {
          callsign: "Iceman",
          enterRssiDbm: 950, // LapRF puck peak height (>100 -> LapRF Y-axis mode!)
          lapsCompleted: 1,
          laps: [makeHeatLap(201, 1, 13.1, { raceElapsedSec: 14.5 })],
          rssiTrace: [
            { t: 0, r: 420 },
            { t: 14500, r: 1650 },
          ],
        }),
      ],
    });
    const race = makeRaceState({
      raceId: "race-lap-ed",
      lifecycle: "active",
      activeHeatId: "Q1-H1",
      heats: [heat],
    });
    const store = makeStore({
      pilots: [makePilot(1, { callsign: "Maverick" }), makePilot(2, { callsign: "Iceman" })],
      gates: [makeGate(1, { name: "Start/Finish" }), makeGate(2, { name: "Split 1" })],
      raceState: race,
      eventState: { initialized: true, activeRaceId: "race-lap-ed", races: [race] },
    });
    const { api, calls } = makeMockApiClient(store);

    openHeatLapEditorModal(store, api, "Q1-H1", 1, "race-lap-ed");

    const backdrop = document.querySelector<HTMLElement>(".slaprf-modal-backdrop")!;
    expect(backdrop).not.toBeNull();
    expect(backdrop.querySelector("[data-lap-ed-svg]")).not.toBeNull();
    expect(backdrop.textContent).toContain("Maverick");

    // Toggle lap validity on crossing 102 and append synthetic lap at end -> staged in draft, then Save dispatches raceMarshal
    const toggleBtn = backdrop.querySelector<HTMLButtonElement>("[data-lap-ed-toggle='102']")!;
    expect(toggleBtn).not.toBeNull();
    toggleBtn.click();
    backdrop.querySelector<HTMLButtonElement>("[data-lap-ed-add-end]")!.click();
    backdrop.querySelector<HTMLButtonElement>("[data-lap-ed-save]")!.click();
    await flushMicrotasks();
    await flushMicrotasks();
    expect(
      calls.some(
        (c) =>
          c.method === "raceMarshal" &&
          (c.args[0] as { action: string; crossingId: number }).action === "toggle_lap" &&
          (c.args[0] as { crossingId: number }).crossingId === 102
      )
    ).toBe(true);
    expect(
      calls.some(
        (c) =>
          c.method === "raceMarshal" &&
          (c.args[0] as { action: string }).action === "add_crossing"
      )
    ).toBe(true);

    // Open Pilot 2 (Iceman, LapRF >100 trace) -> renders cleanly without errors
    openHeatLapEditorModal(store, api, "Q1-H1", 2, "race-lap-ed");
    const backdrop2 = document.querySelector<HTMLElement>(".slaprf-modal-backdrop")!;
    expect(backdrop2.querySelector("[data-lap-ed-svg]")).not.toBeNull();

    // Enter Add Crossing mode -> first Escape exits addMode without closing modal; second Escape closes modal!
    backdrop2.querySelector<HTMLButtonElement>("[data-lap-ed-add-mode]")!.click();
    expect(backdrop2.textContent).toContain("Click Graph to Drop");

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.querySelector(".slaprf-modal-backdrop")).not.toBeNull();
    expect(backdrop2.textContent).toContain("Add Crossing");

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.querySelector(".slaprf-modal-backdrop")).toBeNull();
    closeActiveLapEditorModal();
  });
});

describe("widgets/MultiGPRaceModals — Download & Results Sync Flows", () => {
  it("loads MultiGP races, hides Simulated MultiGP badge, offers Schedule & Pilots / Custom Brackets, and downloads via api.multiGPImportRace", async () => {
    const store = makeStore({
      simulatorRunning: true,
      simMultiGP: {
        chapterName: "Bay Area FPV",
        apiKey: "SIM-KEY-77",
        races: [],
      },
    });
    const { api, calls } = makeMockApiClient(store);
    const createdRace = makeRaceState({
      raceId: "race-imported",
      config: makeRaceSetupConfig({ eventName: "ZippyQ Qualifier" }),
    });

    spyOn(sharedMultiGPService, "verifyChapterKey").mockImplementation(async () => "Bay Area FPV");
    spyOn(sharedMultiGPService, "listRaces").mockImplementation(async () => [
      {
        id: "501",
        name: "ZippyQ Qualifier",
        chapterName: "Bay Area FPV",
        startDate: "2026-11-14",
        status: "Active",
        pilotCount: 8,
        roundCount: 1,
      },
    ]);
    spyOn(sharedMultiGPService, "viewRace").mockImplementation(async () => ({
      id: "501",
      name: "ZippyQ Qualifier",
      chapterName: "Bay Area FPV",
      disableSlotAutoPopulation: 1, // ZippyQ!
      scoringFormat: 0,
      raceType: 0,
      entries: [{ pilotId: "11", userName: "Maverick", firstName: "Pete", lastName: "M" }],
      rounds: [],
    }));
    spyOn(api, "multiGPImportRace").mockImplementation(async (...args: unknown[]) => {
      calls.push({ method: "multiGPImportRace", args });
      return createdRace;
    });

    const onImported = fn<[typeof createdRace]>();
    openMultiGPImportModal(store, api, onImported);

    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();

    const backdrop = document.querySelector<HTMLElement>(".slaprf-modal-backdrop")!;
    expect(backdrop).not.toBeNull();
    expect(backdrop.querySelector("h3")?.textContent).toBe("Download from MultiGP");
    expect(backdrop.textContent).not.toContain("Simulated MultiGP");
    expect(backdrop.textContent).not.toContain("SlapRF Bracket");
    expect(backdrop.textContent).toContain("Custom Brackets");

    const importBtn = backdrop.querySelector<HTMLButtonElement>("[data-mgp-do-import]")!;
    expect(importBtn.disabled).toBe(false);
    importBtn.click();
    await flushMicrotasks();

    const importCall = calls.find((c) => c.method === "multiGPImportRace");
    expect(importCall).toBeDefined();
    expect(importCall!.args[1]).toBe("schedule");
    expect(onImported.calls).toHaveLength(1);
    expect(document.querySelector(".slaprf-modal-backdrop")).toBeNull();
  });

  it("opens openMultiGPSyncModal for a linked race, builds sync plan via api.multiGPBuildSyncPlan, and closes on Escape", async () => {
    const linkedRace = makeRaceState({
      raceId: "race-mgp-sync",
      mgpLink: {
        raceId: 501,
        raceName: "Bay Area Championship",
        chapterName: "Bay Area FPV",
        scoringFormat: 0,
        importMode: "schedule",
      },
    });
    const store = makeStore({ simulatorRunning: true, raceState: linkedRace });
    const { api, calls } = makeMockApiClient(store);

    openMultiGPSyncModal(store, api, linkedRace);
    await flushMicrotasks();

    const backdrop = document.querySelector<HTMLElement>(".slaprf-modal-backdrop")!;
    expect(backdrop).not.toBeNull();
    expect(backdrop.querySelector("h3")?.textContent).toBe("Completed Heats");
    expect(backdrop.querySelector(".mgp-modal-meta-left")?.textContent?.replace(/\s+/g, " ").trim()).toBe(
      "Bay Area Championship - MultiGP #501"
    );
    expect(backdrop.textContent).not.toContain("Simulated MultiGP");
    expect(backdrop.textContent).not.toContain("race/assignSlot");
    expect(calls.some((c) => c.method === "multiGPBuildSyncPlan")).toBe(true);

    // Toggle to JSON view and verify read-only prettified JSON textarea
    const jsonBtn = backdrop.querySelector<HTMLButtonElement>('[data-mgp-view-mode="json"]')!;
    expect(jsonBtn).not.toBeNull();
    jsonBtn.click();
    const jsonViewer = backdrop.querySelector<HTMLTextAreaElement>("[data-mgp-json-viewer]")!;
    expect(jsonViewer).not.toBeNull();
    expect(jsonViewer.readOnly).toBe(true);
    expect(jsonViewer.value).toContain('"endpoint": "race/assignSlot"');

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.querySelector(".slaprf-modal-backdrop")).toBeNull();
    closeActiveMultiGPModal();
  });
});
