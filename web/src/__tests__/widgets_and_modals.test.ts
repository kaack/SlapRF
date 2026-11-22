import { icons } from "../core/icons";
import {
  bindBracketDragAndDrop,
  clampZoom,
  createDefaultBracketEditorUiState,
  formatShortSec,
  formatStageLabel,
  formatWirePillLabel,
  getPresentStageIndices,
  heatStateBadge,
  isChaseHeatId,
  isHandoffInRoundId,
  isHandoffOutRoundId,
  isHandoffPortalRound,
  isHeatCompletedOrRunning,
  isHeatUnstarted,
  isPilotsInRoundId,
  isRaceOngoing,
  isRootStage,
  ordinal,
  raceLifecycleBadge,
  renderBracketMarkup,
  roundNeedsDeleteConfirmation,
  STAGE1_HANDOFF_OUT_ID,
  STAGE1_PILOTS_IN_ID,
  STAGE2_HANDOFF_IN_ID,
  stageHandoffInId,
  stageHandoffOutId,
  stagePilotsInId,
} from "../widgets/BracketDiagram";
import {
  CanvasSelectChangeDetail,
  closeCanvasSelectPopover,
  ensureCanvasSelectGlobalBinding,
  renderCanvasSelect,
} from "../widgets/CanvasSelect";
import { openConfirmModal } from "../widgets/ConfirmModal";
import { openConfirmPreemptModal } from "../widgets/ConfirmPreemptModal";
import { DataSourceCard } from "../widgets/DataSourceCard";
import {
  formatStageConnectionLabel,
  renderFormatMarkup,
  suggestNewStageSpawnPosition,
} from "../widgets/FormatDiagram";
import { openHeatLapEditorModal } from "../widgets/HeatLapEditorModal";
import { PilotRssiChart } from "../widgets/PilotRssiChart";
import {
  mountTagPillEditor,
  normalizeTagToken,
  parseTagTokens,
  renderTagPillBoxHtml,
} from "../widgets/TagPillEditor";
import { TimingRulesEditor } from "../widgets/TimingRulesEditor";
import {
  cleanConnectionInvalidReason,
  notifyNewlyInvalidConnections,
  notifyNewlyInvalidStageConnections,
  showToast,
} from "../widgets/Toast";
import {
  dismissWireDropMenu,
  flashSpawnedCanvasNode,
  openWireDropMenu,
} from "../widgets/WireDropMenu";
import {
  describe,
  expect,
  flushMicrotasks,
  fn,
  it,
  makeEventPilot,
  makeFiltered,
  makeGate,
  makeHeat,
  makeMockApiClient,
  makeRaceState,
  makeRound,
  makeSeat,
  makeStage,
  makeStore,
  mountHtml,
} from "./harness";

describe("widgets/ConfirmModal & ConfirmPreemptModal", () => {
  it("renders neutral modal chrome (alertTriangle header + check confirm, never trash) and optional warningHtml", async () => {
    let resolveConfirm!: () => void;
    const onConfirm = fn(
      () =>
        new Promise<void>((resolve) => {
          resolveConfirm = resolve;
        })
    );

    openConfirmModal({
      title: "Delete Stage 2",
      messageHtml: "Remove <strong>Stage 2</strong> and its heats?",
      warningHtml: "All unconfirmed heats in Stage 2 will be discarded.",
      confirmLabel: "Delete Stage",
      danger: true,
      onConfirm,
    });

    const backdrop = document.querySelector<HTMLElement>(".slaprf-modal-backdrop");
    expect(backdrop).not.toBeNull();
    expect(backdrop!.getAttribute("aria-label")).toBe("Delete Stage 2");

    // Header icon uses alertTriangle (not trash), and confirm button uses check icon
    const headIconHtml = backdrop!.querySelector(".slaprf-modal-icon")?.innerHTML ?? "";
    expect(headIconHtml).toContain("m21.73 18-8-14");
    expect(headIconHtml).not.toContain("M3 6h18"); // trash top bar path

    const warnPane = backdrop!.querySelector<HTMLElement>(".slaprf-modal-warn");
    expect(warnPane).not.toBeNull();
    expect(warnPane!.textContent).toContain("All unconfirmed heats in Stage 2");

    const confirmBtn = backdrop!.querySelector<HTMLButtonElement>("[data-modal-confirm]");
    expect(confirmBtn).not.toBeNull();
    expect(confirmBtn!.innerHTML).toContain("M20 6 9 17l-5-5"); // check icon path

    // Clicking confirm disables button until async callback resolves, preventing double-submit
    confirmBtn!.click();
    confirmBtn!.click();
    expect(onConfirm.calls).toHaveLength(1);
    expect(confirmBtn!.disabled).toBe(true);
    expect(document.querySelector(".slaprf-modal-backdrop")).not.toBeNull();

    resolveConfirm();
    await flushMicrotasks();
    expect(document.querySelector(".slaprf-modal-backdrop")).toBeNull();
  });

  it("cancels ConfirmModal on Escape key or backdrop click without invoking onConfirm", () => {
    const onConfirm = fn();
    openConfirmModal({
      title: "Scrap Race",
      messageHtml: "Scrap this race?",
      onConfirm,
    });
    expect(document.querySelector(".slaprf-modal-backdrop")).not.toBeNull();

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.querySelector(".slaprf-modal-backdrop")).toBeNull();
    expect(onConfirm.calls).toHaveLength(0);

    // Re-open and click backdrop directly
    openConfirmModal({
      title: "Scrap Race 2",
      messageHtml: "Scrap again?",
      onConfirm,
    });
    const backdrop = document.querySelector<HTMLElement>(".slaprf-modal-backdrop")!;
    backdrop.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(document.querySelector(".slaprf-modal-backdrop")).toBeNull();
    expect(onConfirm.calls).toHaveLength(0);
  });

  it("supports Enter to confirm and Escape / Cancel to dismiss ConfirmPreemptModal", () => {
    const onConfirm = fn();
    openConfirmPreemptModal({
      title: "Pause Ongoing Race?",
      bodyHtml: "Starting this practice session will pause <strong>Friday Night Brawl</strong>.",
      okLabel: "Pause & Start Practice",
      onConfirm,
    });

    const backdrop = document.querySelector<HTMLElement>(".slaprf-modal-backdrop");
    expect(backdrop).not.toBeNull();
    expect(backdrop!.textContent).toContain("Pause & Start Practice");

    // Escape closes without confirming
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.querySelector(".slaprf-modal-backdrop")).toBeNull();
    expect(onConfirm.calls).toHaveLength(0);

    // Re-open and press Enter -> confirms & closes
    openConfirmPreemptModal({
      title: "Pause Ongoing Race?",
      bodyHtml: "Starting this practice session will pause race.",
      onConfirm,
    });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onConfirm.calls).toHaveLength(1);
    expect(document.querySelector(".slaprf-modal-backdrop")).toBeNull();
  });
});

describe("widgets/TagPillEditor", () => {
  it("normalizes leading '#', collapses whitespace, caps length at 32 chars, and deduplicates case-insensitively", () => {
    expect(normalizeTagToken("  ###Season   Finale  ")).toBe("Season Finale");
    expect(normalizeTagToken("a".repeat(50))).toHaveLength(32);
    expect(parseTagTokens(" #Outdoor , outdoor, 5-inch ,  #Whoop , 5-INCH ")).toEqual([
      "Outdoor",
      "5-inch",
      "Whoop",
    ]);
  });

  it("handles comma/Enter creation, two-step Backspace deletion, × removal, and Escape cancel", () => {
    const onChange = fn<[string[]]>();
    const onCommit = fn<[string[]]>();
    const onCancel = fn();

    const root = mountHtml(
      renderTagPillBoxHtml({
        boxId: "race-tags",
        tags: ["Season 4"],
        placeholder: "Add tags…",
      })
    );
    const boxEl = root.querySelector<HTMLElement>("[data-tag-box='race-tags']")!;
    const handle = mountTagPillEditor(boxEl, {
      initialTags: ["Season 4"],
      onChange,
      onCommit,
      onCancel,
    });

    const input = boxEl.querySelector<HTMLInputElement>("[data-tag-box-input]")!;
    expect(handle.getTags()).toEqual(["Season 4"]);

    // Type a tag followed by comma -> creates pill immediately
    input.value = "#Finals,";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(handle.getTags()).toEqual(["Season 4", "Finals"]);
    expect(input.value).toBe("");

    // ArrowLeft selects last pill (.is-selected), then Backspace deletes it
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    expect(handle.getTags()).toEqual(["Season 4", "Finals"]);
    expect(boxEl.querySelector("[data-tag-pill-idx='1']")?.classList.contains("is-selected")).toBe(true);

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }));
    expect(handle.getTags()).toEqual(["Season 4"]);

    // Direct Backspace on empty input pops last pill immediately
    expect(handle.addTag("Temp")).toBe(true);
    expect(handle.getTags()).toEqual(["Season 4", "Temp"]);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }));
    expect(handle.getTags()).toEqual(["Season 4"]);

    // Add via programmatic handle + remove first pill via × button
    expect(handle.addTag("Night Race")).toBe(true);
    expect(handle.addTag("night race")).toBe(false); // case-insensitive dup rejected
    boxEl.querySelector<HTMLButtonElement>("[data-tag-pill-remove='0']")!.click();
    expect(handle.getTags()).toEqual(["Night Race"]);

    // Pending text flushed & committed on Enter when input is empty or non-empty
    input.value = "Championship";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(handle.getTags()).toEqual(["Night Race", "Championship"]);
    expect(input.value).toBe("");

    // Pressing Enter again on empty input commits the tag list
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onCommit.calls).toHaveLength(1);
    expect(onCommit.calls[0][0]).toEqual(["Night Race", "Championship"]);
  });
});

describe("widgets/CanvasSelect & WireDropMenu", () => {
  it("opens CanvasSelect popover with search filter (>10 options) and emits canvas-select-change", () => {
    ensureCanvasSelectGlobalBinding();
    const options = Array.from({ length: 12 }, (_, idx) => ({
      value: `opt-${idx + 1}`,
      label: `Channel Option ${idx + 1}`,
      group: idx < 6 ? "RaceBand" : "IMD6",
    }));

    const root = mountHtml(
      renderCanvasSelect({
        value: "opt-2",
        label: "R2",
        options,
        mono: true,
      })
    );

    const trigger = root.querySelector<HTMLButtonElement>("[data-cselect-trigger]")!;
    let selectedVal = "";
    root.addEventListener("canvas-select-change", (e) => {
      selectedVal = (e as CustomEvent<CanvasSelectChangeDetail>).detail.value;
    });

    trigger.click();
    const pop = document.querySelector<HTMLElement>("[data-cselect-popover]");
    expect(pop).not.toBeNull();

    // Search box is rendered when >10 options
    const searchInput = pop!.querySelector<HTMLInputElement>("[data-cselect-search]")!;
    expect(searchInput).not.toBeNull();
    searchInput.value = "Option 11";
    searchInput.dispatchEvent(new Event("input", { bubbles: true }));

    const visibleItems = pop!.querySelectorAll<HTMLButtonElement>("[data-cselect-option]");
    expect(visibleItems).toHaveLength(1);
    expect(visibleItems[0].dataset.cselectOption).toBe("opt-11");

    visibleItems[0].click();
    expect(selectedVal).toBe("opt-11");
    expect(document.querySelector("[data-cselect-popover]")).toBeNull();
    closeCanvasSelectPopover();
  });

  it("attaches contextual SVG tether in WireDropMenu, invokes onSelect, and cleans up on Escape", () => {
    const root = mountHtml(`
      <div data-rc-viewport style="position:relative;width:800px;height:500px">
        <svg class="bkt-wires"></svg>
        <button type="button" id="out-port"></button>
      </div>
    `);
    const viewport = root.querySelector<HTMLElement>("[data-rc-viewport]")!;
    const svg = root.querySelector<SVGSVGElement>("svg.bkt-wires")!;
    const outPort = root.querySelector<HTMLElement>("#out-port")!;
    const onSelect = fn<[string]>();

    openWireDropMenu({
      viewport,
      svg,
      outPort,
      clientX: 300,
      clientY: 220,
      tetherPathD: "M 100 100 C 180 100, 220 220, 300 220",
      options: [
        { id: "winners_round", label: "Upper Round", iconHtml: icons.plus(14) },
        { id: "finals", label: "Grand Finals", iconHtml: icons.trophy(14), disabled: true },
      ],
      onSelect,
    });

    expect(outPort.classList.contains("is-active")).toBe(true);
    expect(svg.querySelector("path.is-context-tether")).not.toBeNull();
    const menu = viewport.querySelector<HTMLElement>("[data-wire-drop-menu]");
    expect(menu).not.toBeNull();

    // Clicking disabled option does nothing
    menu!.querySelector<HTMLButtonElement>("[data-wire-drop-opt='finals']")!.click();
    expect(onSelect.calls).toHaveLength(0);
    expect(viewport.querySelector("[data-wire-drop-menu]")).not.toBeNull();

    // Clicking enabled option selects and removes tether + active class
    menu!.querySelector<HTMLButtonElement>("[data-wire-drop-opt='winners_round']")!.click();
    expect(onSelect.calls).toEqual([["winners_round"]]);
    expect(viewport.querySelector("[data-wire-drop-menu]")).toBeNull();
    expect(svg.querySelector("path.is-context-tether")).toBeNull();
    expect(outPort.classList.contains("is-active")).toBe(false);

    // Flash helper adds .rc-just-added
    flashSpawnedCanvasNode(outPort);
    expect(outPort.classList.contains("rc-just-added")).toBe(true);
    dismissWireDropMenu();
  });
});

describe("widgets/Toast & TimingRulesEditor", () => {
  it("strips WASM/HTTP transport error prefixes, deduplicates identical toasts, and notifies newly invalid wires", () => {
    expect(
      cleanConnectionInvalidReason(
        "Error: WASM POST /v1/race/sessions/current/bracket:edit failed (400): Started round: cycle detected in stage graph"
      )
    ).toBe("Cycle detected in stage graph");
    expect(cleanConnectionInvalidReason("HTTP 422: duplicate connection")).toBe(
      "Duplicate connection"
    );

    showToast("WASM POST /v1/test failed (400): seats full", "error", { title: "Invalid Link" });
    showToast("WASM POST /v1/test failed (400): seats full", "error", { title: "Invalid Link" });

    const toasts = document.querySelectorAll<HTMLElement>(".slaprf-toast");
    expect(toasts).toHaveLength(1);
    expect(toasts[0].classList.contains("is-pulsing")).toBe(true);
    expect(toasts[0].querySelector(".slaprf-toast-msg")?.textContent).toBe("Seats full");

    // Newly invalid round & stage connections surface toasts only when newly broken or reason changes
    const prevRoundConns = [
      { id: "c1", stageIndex: 1, fromRoundId: "r1", toRoundId: "r2", mode: "top" as const, count: 2, invalid: true, invalidReason: "old reason" },
    ];
    const nextRace = makeRaceState({
      connections: [
        { id: "c1", stageIndex: 1, fromRoundId: "r1", toRoundId: "r2", mode: "top", count: 2, invalid: true, invalidReason: "old reason" },
        { id: "c2", stageIndex: 1, fromRoundId: "r2", toRoundId: "r3", mode: "top", count: 2, invalid: true, invalidReason: "target seats exceeded" },
      ],
      stageConnections: [
        { id: "sc1", fromStageId: "stage-1", toStageId: "stage-2", fromStageIndex: 1, toStageIndex: 2, mode: "top", count: 4, invalid: true, invalidReason: "stage capacity exceeded" },
      ],
    });

    notifyNewlyInvalidConnections(prevRoundConns, nextRace);
    notifyNewlyInvalidStageConnections([], nextRace);
    const messages = Array.from(document.querySelectorAll(".slaprf-toast-msg")).map(
      (el) => el.textContent
    );
    expect(messages).toContain("Target seats exceeded");
    expect(messages).toContain("Stage capacity exceeded");
  });

  it("renders TimingRulesEditor without session filter counters or override sub-notes and saves global + per-gate overrides", async () => {
    const store = makeStore({
      gates: [
        makeGate(1, { name: "Start/Finish", ruleOverrides: { minLapSec: 4.5 } }),
        makeGate(2, { name: "Split Tunnel" }),
      ],
      filtered: [
        makeFiltered(1_000_000, 1, 1, "MIN_LAP"),
        makeFiltered(2_000_000, 1, 2, "MIN_LAP"),
        makeFiltered(3_000_000, 2, 1, "SPIKE"),
      ],
    });
    const { api, calls } = makeMockApiClient(store);
    const root = mountHtml(`<div id="rules-host"></div>`);
    const editor = new TimingRulesEditor(root.querySelector("#rules-host")!, store, api);

    try {
      expect(root.querySelector(".rules-scope-label")).toBeNull();
      expect(root.querySelector(".rules-scope")?.textContent ?? "").not.toContain("Applies to");
      expect(root.querySelector("[data-scope='all'] .channel-custom-icon")).toBeNull();

      // Session detection counters and override sub-notes are omitted so row height never jumps
      expect(root.querySelector("[data-count='MIN_LAP']")).toBeNull();
      expect(root.querySelector(".rule-override-note")).toBeNull();
      expect(root.textContent).not.toContain("this session");
      expect(root.textContent).not.toContain("Overridden at");

      // Concise 1-line Beep on crossing description for All timers
      expect(root.textContent).toContain(
        "Plays an instant high-priority synthetic tone when a crossing is detected for all timers."
      );

      // Editing global minLapSec triggers api.updateRules
      const minLapInput = root.querySelector<HTMLInputElement>("input[name='minLapSec']")!;
      minLapInput.value = "6.5";
      minLapInput.dispatchEvent(new Event("change", { bubbles: true }));
      await flushMicrotasks();

      const updateCall = calls.find((c) => c.method === "updateRules");
      expect(updateCall).toBeDefined();
      expect((updateCall!.args[0] as { minLapSec: number }).minLapSec).toBe(6.5);
      store.applyRules({ ...store.rules, minLapSec: 6.5 });
      expect(root.querySelector("[data-scope='all'] .channel-custom-icon")).not.toBeNull();

      // Switch scope to Gate 2 ("Split Tunnel") -> concise 1-line Beep on crossing description for individual timer
      root.querySelector<HTMLButtonElement>("[data-scope='2']")!.click();
      expect(root.querySelector("[data-count='SPIKE']")).toBeNull();
      expect(root.textContent).toContain(
        "Plays an instant high-priority synthetic tone when a crossing is detected at this timer."
      );

      // Toggle override on minCrossingSec for Gate 2 -> calls setGateRules(2, { minCrossingSec: 0.12 })
      root.querySelector<HTMLButtonElement>("[data-override-toggle='minCrossingSec']")!.click();
      await flushMicrotasks();
      const gateRuleCall = calls.find((c) => c.method === "setGateRules");
      expect(gateRuleCall).toBeDefined();
      expect(gateRuleCall!.args).toEqual([2, { minCrossingSec: 0.12 }]);
    } finally {
      editor.destroy();
    }
  });

  it("shows right-aligned X dismiss button only on disconnected timers in TimingRulesEditor and calls deleteTimer", async () => {
    const store = makeStore({
      timingHardwareMode: "rotorhazard",
      gates: [
        makeGate(1, { name: "R1", assignedTimerId: 1, online: true, firmwareVersion: "RotorHazard" }),
        makeGate(2, { name: "R2", assignedTimerId: 2, online: false, firmwareVersion: "RotorHazard" }),
      ],
      timers: [
        {
          timerId: 1,
          timerLabel: "R1",
          color: "#38bdf8",
          isHub: false,
          batteryMv: 0,
          batteryPct: 0,
          firmwareVersion: "RotorHazard",
          online: true,
        },
        {
          timerId: 2,
          timerLabel: "R2",
          color: "#f472b6",
          isHub: false,
          batteryMv: 0,
          batteryPct: 0,
          firmwareVersion: "RotorHazard",
          online: false,
        },
      ],
    });
    const { api, calls } = makeMockApiClient(store);
    const root = mountHtml(`<div id="rules-dismiss-host"></div>`);
    const editor = new TimingRulesEditor(root.querySelector("#rules-dismiss-host")!, store, api);

    try {
      // Connected timer #1 must NOT show a dismiss X button
      expect(root.querySelector("[data-dismiss-gate='1']")).toBeNull();
      // Disconnected timer #2 MUST show a right-aligned dismiss X button
      const dismissBtn = root.querySelector<HTMLElement>("[data-dismiss-gate='2']")!;
      expect(dismissBtn).not.toBeNull();
      dismissBtn.click();
      await flushMicrotasks();
      const delCall = calls.find((c) => c.method === "deleteTimer");
      expect(delCall).toBeDefined();
      expect(delCall!.args[0]).toBe(2);
    } finally {
      editor.destroy();
    }
  });

  it("opens Signals fine-tuning drawer per timer with 3-tier scope toggle, minLapSec, maxLapSec, minCrossingSec, and beepOnCross", async () => {
    const store = makeStore({
      gates: [
        makeGate(1, { name: "H1", role: "START_FINISH", ruleOverrides: { minLapSec: 8 } }),
        makeGate(2, { name: "T3", role: "SECTOR_GATE" }),
      ],
    });
    const { api, calls } = makeMockApiClient(store);
    const root = mountHtml(`<div style="width: 640px; height: 420px;"></div>`);
    const chart = new PilotRssiChart(root.firstElementChild as HTMLElement, store, api, {
      contextMode: "practice",
    });

    try {
      const drawerEl = root.querySelector<HTMLElement>('[data-slot="tune-drawer"]')!;
      // On All timers, Signals does not show Calibrate or Fine-tune buttons or the Fine-tune drawer
      // (global Fine-tune lives on Track).
      expect(drawerEl.hidden).toBe(true);
      expect(drawerEl.classList.contains("is-mobile-closed")).toBe(true);
      expect(root.querySelector('[data-calib-gate="all"]')).toBeNull();
      expect(root.querySelector('[data-tune-gate="all"]')).toBeNull();

      // Select timer 1 ("H1") -> Fine-tune box immediately opens for H1 on desktop; clicking inline row Fine-tune button opens it for mobile too
      root.querySelector<HTMLButtonElement>('[data-gate-chip="1"]')!.click();
      expect(drawerEl.hidden).toBe(false);
      expect(drawerEl.textContent).toContain("H1 · Fine-tune");
      // Before enough pass data is recorded, the Calibrate button is hidden (spacer preserves column alignment)
      expect(
        root.querySelector('[data-gate-chip="1"] .channel-right-cols [data-calib-gate="1"]')
      ).toBeNull();
      expect(
        root.querySelector('[data-gate-chip="1"] .channel-right-cols .channel-mobile-action-spacer')
      ).not.toBeNull();

      // Ingest 2 clear passes (>= 100 samples) at H1 -> Calibrate button appears, and spins + disables when clicked
      for (let i = 0; i < 140; i++) {
        const tsUs = (i + 1) * 50_000;
        const isPass = (i >= 30 && i <= 34) || (i >= 95 && i <= 99);
        const rssiVal = isPass ? -42 : -88;
        store.ingestTelemetry({
          timerId: 1,
          seqNum: i & 0xff,
          timestampUs: tsUs,
          rssi: [rssiVal],
        });
      }
      store.ingestCrossing({
        eventId: 1,
        timestampUs: 1_750_000,
        slotIndex: 1,
        callsign: "Alpha",
        gateId: 1,
        peakRssiDbm: -42,
        estimatedSpeedMph: 45,
        startedLap: true,
      });
      const inlineCalib1 = root.querySelector<HTMLElement>(
        '[data-gate-chip="1"] .channel-right-cols [data-calib-gate="1"]'
      )!;
      expect(inlineCalib1).not.toBeNull();
      expect(inlineCalib1.getAttribute("data-calib-mode")).toBe("auto");
      inlineCalib1.click();
      const spinningCalib1 = root.querySelector<HTMLElement>(
        '[data-gate-chip="1"] .channel-right-cols [data-calib-gate="1"]'
      )!;
      expect(spinningCalib1.classList.contains("is-calibrating")).toBe(true);
      expect(spinningCalib1.getAttribute("aria-disabled")).toBe("true");
      expect(spinningCalib1.getAttribute("data-calib-busy")).toBe("1");

      const inlineTune1 = root.querySelector<HTMLElement>(
        '[data-gate-chip="1"] .channel-right-cols .channel-mobile-action-btn.is-tune[data-tune-gate="1"]'
      )!;
      expect(inlineTune1).not.toBeNull();
      inlineTune1.click();
      expect(drawerEl.classList.contains("is-mobile-closed")).toBe(false);
      expect(drawerEl.textContent).toContain("H1 · Fine-tune");

      // Only the 3 clean numeric rules + Beep on crossing exist (no retroactive toggle or legacy rules)
      expect(drawerEl.querySelector('[data-tune-act="toggle-retro"]')).toBeNull();
      expect(drawerEl.querySelector('[data-tune-input="gateCooldownSec"]')).toBeNull();
      expect(drawerEl.querySelector('[data-tune-input="minSectionSec"]')).toBeNull();
      expect(drawerEl.querySelector('[data-tune-input="echoWindowSec"]')).toBeNull();
      expect(drawerEl.querySelector(".scope-tune-card-source")).toBeNull();
      expect(drawerEl.querySelector('[data-tune-act="test-beep"]')).toBeNull();
      expect(drawerEl.querySelector('[data-tune-act="reset-beep"]')).toBeNull();

      // Default scope is "Only <Pilot>", inheriting minLapSec = 8 from H1 all-pilots
      const minLapInput = drawerEl.querySelector<HTMLInputElement>('[data-tune-input="minLapSec"]')!;
      expect(minLapInput.value).toBe("8");
      const maxLapInput = drawerEl.querySelector<HTMLInputElement>('[data-tune-input="maxLapSec"]')!;
      expect(maxLapInput.value).toBe("120");
      const minCrossingInput = drawerEl.querySelector<HTMLInputElement>('[data-tune-input="minCrossingSec"]')!;
      expect(minCrossingInput.value).toBe("0.12");

      // Focusing a numeric input keeps the drawer stationary and replaces the old value on the first typed digit
      minLapInput.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      expect(drawerEl.classList.contains("is-keyboard-open")).toBe(false);
      expect(minLapInput.dataset.originalValue).toBe("8");
      expect(minLapInput.dataset.replaceOnNextInput).toBe("1");
      minLapInput.dispatchEvent(
        new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: "9" })
      );
      expect(minLapInput.value).toBe("");
      expect(minLapInput.dataset.replaceOnNextInput).toBeUndefined();
      minLapInput.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      expect(minLapInput.value).toBe("8");

      // On desktop (>860px), the Signals Fine-tune box uses the Track-style .rules rows with inline pencil/reset buttons
      const minLapOverrideToggle = drawerEl.querySelector<HTMLButtonElement>('[data-tune-override-toggle="minLapSec"]');
      if (minLapOverrideToggle) {
        minLapOverrideToggle.click();
        await flushMicrotasks();
        minLapInput.value = "8.5";
        minLapInput.dispatchEvent(new Event("change", { bubbles: true }));
      } else {
        drawerEl.querySelector<HTMLButtonElement>('[data-tune-step="1"][data-tune-key="minLapSec"]')!.click();
      }
      await flushMicrotasks();
      const pilotCall1 = calls.filter((c) => c.method === "setPilotGateRules").pop();
      expect(pilotCall1).toBeDefined();
      expect(pilotCall1!.args).toEqual([1, 1, { minLapSec: 8.5 }]);

      // Switch scope to "All pilots" -> minLapSec is overridden at H1
      drawerEl.querySelector<HTMLButtonElement>('[data-tune-scope="gate"]')!.click();
      const minLapCard = drawerEl.querySelector<HTMLElement>('[data-tune-card="minLapSec"]')!;
      expect(minLapCard.classList.contains("is-overridden")).toBe(true);
      const crossOverrideToggle = drawerEl.querySelector<HTMLButtonElement>('[data-tune-override-toggle="minCrossingSec"]');
      if (crossOverrideToggle) {
        crossOverrideToggle.click();
        await flushMicrotasks();
      }
      const crossInputGate = drawerEl.querySelector<HTMLInputElement>('[data-tune-input="minCrossingSec"]')!;
      crossInputGate.value = "0.18";
      crossInputGate.dispatchEvent(new Event("change", { bubbles: true }));
      await flushMicrotasks();
      const gateCall = calls.filter((c) => c.method === "setGateRules").pop();
      expect(gateCall).toBeDefined();
      expect(gateCall!.args).toEqual([1, { minLapSec: 8, minCrossingSec: 0.18 }]);

      // Toggle "Beep on crossing" ON in All pilots scope -> calls setGateRules with beepOnCross: true
      const beepBtn = drawerEl.querySelector<HTMLButtonElement>('[data-tune-act="toggle-beep"]')!;
      expect(beepBtn.textContent?.trim()).toBe("");
      beepBtn.click();
      await flushMicrotasks();
      const beepGateCall = calls.filter((c) => c.method === "setGateRules").pop();
      expect(beepGateCall).toBeDefined();
      expect(beepGateCall!.args).toEqual([1, { minLapSec: 8, beepOnCross: true }]);
    } finally {
      chart.destroy();
    }

    // Verify Race mode renders the same clean drawer
    const raceRoot = mountHtml(`<div style="width: 640px; height: 420px;"></div>`);
    const raceChart = new PilotRssiChart(raceRoot.firstElementChild as HTMLElement, store, api, {
      contextMode: "race",
    });
    try {
      raceRoot.querySelector<HTMLButtonElement>('[data-gate-chip="2"]')!.click();
      raceRoot.querySelector<HTMLButtonElement>('.scope-calib-tune-btn[data-tune-gate="2"]')!.click();
      const raceDrawer = raceRoot.querySelector<HTMLElement>('[data-slot="tune-drawer"]')!;
      expect(raceDrawer.hidden).toBe(false);
      expect(raceDrawer.querySelector('[data-tune-input="minCrossingSec"]')).not.toBeNull();
      expect(raceDrawer.querySelector('[data-tune-act="toggle-beep"]')).not.toBeNull();
    } finally {
      raceChart.destroy();
    }
  });
});

describe("widgets/BracketDiagram & FormatDiagram", () => {
  it("computes status badges, emergency-stop ongoing guard, portal IDs, and connection pill labels accurately", () => {
    expect(heatStateBadge("finished")).toEqual({ label: "Review", cls: "is-review" });
    expect(heatStateBadge("paused")).toEqual({ label: "Paused", cls: "is-paused" });
    expect(heatStateBadge("aborted")).toEqual({ label: "Stopped", cls: "is-stopped" });
    expect(heatStateBadge("running", false)).toEqual({ label: "Racing", cls: "is-live" });
    expect(heatStateBadge("running", true)).toEqual({ label: "Overtime", cls: "is-warn" });

    expect(raceLifecycleBadge("draft")).toEqual({ label: "Setup", cls: "is-ready" });
    expect(raceLifecycleBadge("active")).toEqual({ label: "Active", cls: "is-live" });
    expect(raceLifecycleBadge("paused")).toEqual({ label: "Paused", cls: "is-paused" });

    // Emergency-stopped race is NOT considered ongoing for preemption prompts
    const activeRace = makeRaceState({ lifecycle: "active", emergencyStopped: false });
    expect(isRaceOngoing(activeRace)).toBe(true);
    expect(isRaceOngoing({ ...activeRace, emergencyStopped: true })).toBe(false);

    expect(ordinal(1)).toBe("1st");
    expect(ordinal(2)).toBe("2nd");
    expect(ordinal(3)).toBe("3rd");
    expect(ordinal(11)).toBe("11th");
    expect(ordinal(22)).toBe("22nd");
    expect(clampZoom(0.05)).toBe(0.22);
    expect(clampZoom(4.5)).toBe(2);
    expect(formatShortSec(0)).toBe("—");
    expect(formatShortSec(12.345)).toBe("12.35s");
    expect(formatStageLabel("points_mains")).toBe("Points / A-B-C Mains");
    expect(isChaseHeatId("S2-CTA-3")).toBe(true);
    expect(isHeatUnstarted("staged")).toBe(true);
    expect(isHeatCompletedOrRunning({ state: "confirmed", note: "Auto-advance (bye)" })).toBe(false);
    expect(isHeatCompletedOrRunning({ state: "confirmed" })).toBe(true);

    expect(isHandoffOutRoundId(STAGE1_HANDOFF_OUT_ID)).toBe(true);
    expect(isHandoffOutRoundId(stageHandoffOutId(3))).toBe(true);
    expect(isHandoffInRoundId(STAGE2_HANDOFF_IN_ID)).toBe(true);
    expect(isHandoffInRoundId(stageHandoffInId(3))).toBe(true);
    expect(isPilotsInRoundId(STAGE1_PILOTS_IN_ID)).toBe(true);
    expect(isPilotsInRoundId(stagePilotsInId(2))).toBe(true);
    expect(isHandoffPortalRound("stage2-seeds-in")).toBe(true);

    expect(
      formatWirePillLabel({
        id: "w1",
        stageIndex: 1,
        fromRoundId: STAGE1_PILOTS_IN_ID,
        toRoundId: "r-1",
        mode: "pilots_in",
        count: 0,
        distribution: "snake",
      })
    ).toBe("Pilots Roster · Snake");

    expect(
      formatStageConnectionLabel(
        {
          id: "sc-1",
          fromStageId: "stage-1",
          toStageId: "stage-2",
          fromStageIndex: 1,
          toStageIndex: 2,
          mode: "seed_range",
          count: 4,
          seedStart: 5,
          seedEnd: 8,
        },
        16
      )
    ).toContain("5");
  });

  it("places channel-change indicator (.bkt-ch-delta) AFTER .bkt-name so pilot colored dots stay aligned", () => {
    const race = makeRaceState({
      lifecycle: "active",
      rounds: [makeRound("r-1", { stageIndex: 1, title: "Round 1" })],
      heats: [
        makeHeat("W1-H1", {
          roundId: "r-1",
          stageIndex: 1,
          seats: [
            makeSeat(0, 1, { callsign: "Maverick", channelChanged: true }),
            makeSeat(1, 2, { callsign: "Iceman", channelChanged: false }),
          ],
        }),
      ],
    });
    const ui = createDefaultBracketEditorUiState(() => {});
    const root = mountHtml(
      `<div data-rc-viewport>${renderBracketMarkup(race, {
        activeHeatId: "W1-H1",
        stageFilter: 1,
        editable: true,
        canvas: true,
        editorUi: ui,
      })}</div>`
    );

    const seats = root.querySelectorAll<HTMLElement>(".bkt-card .bkt-seat");
    expect(seats.length).toBeGreaterThanOrEqual(2);

    const changedSeat = seats[0];
    const seatChildren = Array.from(changedSeat.children);
    const dotIdx = seatChildren.findIndex((el) => el.classList.contains("dot"));
    const nameWrapIdx = seatChildren.findIndex((el) => el.classList.contains("bkt-name-wrap"));
    expect(dotIdx).toBeGreaterThanOrEqual(0);
    expect(nameWrapIdx).toBe(dotIdx + 1);
    // Ensure no channel-change badge appears before .dot
    expect(
      seatChildren
        .slice(0, dotIdx + 1)
        .some((el) => el.classList.contains("bkt-ch-delta") || el.classList.contains("bkt-ch-warn"))
    ).toBe(false);

    const nameWrap = changedSeat.querySelector<HTMLElement>(".bkt-name-wrap")!;
    expect(nameWrap).not.toBeNull();
    const children = Array.from(nameWrap.children);
    expect(children[0]?.classList.contains("bkt-name")).toBe(true);
    expect(children[1]?.classList.contains("bkt-ch-delta")).toBe(true);
    expect(children[1]?.querySelector("svg")).not.toBeNull();
  });

  it("exposes Simulation speed (1x / 5x / 20x) inside DataSourceCard when simulation is active", () => {
    const store = makeStore({ simulatorRunning: true });
    const { api, calls } = makeMockApiClient(store);
    const root = mountHtml(`<div id="ds-host"></div>`);
    const card = new DataSourceCard(root.querySelector("#ds-host")!, store, api);

    try {
      const speedBtns = root.querySelectorAll<HTMLButtonElement>("[data-sim-speed]");
      expect(speedBtns).toHaveLength(3);
      root.querySelector<HTMLButtonElement>("[data-sim-speed='20']")!.click();
      expect(calls.some((c) => c.method === "setSimSpeed" && c.args[0] === 20)).toBe(true);
    } finally {
      card.destroy();
    }
  });

  it("locks panels and nodes in place while still allowing canvas panning and wheel zoom when locked", () => {
    const race = makeRaceState({
      lifecycle: "draft",
      rounds: [makeRound("r-1", { stageIndex: 1 })],
      heats: [makeHeat("W1-H1", { roundId: "r-1", stageIndex: 1 })],
    });
    const store = makeStore({ raceState: race });
    const { api } = makeMockApiClient(store);
    const ui = createDefaultBracketEditorUiState(() => {});
    const onContextAdd = fn<[number, number, number, number, boolean]>();
    const onPanelMoved = fn<[string, number, number]>();
    ui.onBoardContextAddMenu = onContextAdd;
    ui.onPanelMoved = onPanelMoved;
    ui.nodesLocked = true;
    ui.panX = 0;
    ui.panY = 0;
    ui.zoom = 1;

    const root = mountHtml(
      `<div class="races-canvas tool-pan is-nodes-locked" data-rc-viewport style="width:900px;height:600px">
        <div data-rc-world>
          <section class="rc-canvas-panel" data-canvas-panel="cockpit" data-pos-x="40" data-pos-y="50">
            <header class="rc-panel-header" data-panel-drag-handle>Race Control</header>
          </section>
          ${renderBracketMarkup(race, {
            activeHeatId: "W1-H1",
            stageFilter: 1,
            editable: true,
            canvas: true,
            editorUi: ui,
          })}
        </div>
      </div>`
    );
    const unbind = bindBracketDragAndDrop(root, api, () => race, ui);

    try {
      const viewport = root.querySelector<HTMLElement>("[data-rc-viewport]")!;
      const panelHandle = root.querySelector<HTMLElement>("[data-panel-drag-handle]")!;

      // 1. While locked: dragging a panel header does NOT move the panel
      panelHandle.dispatchEvent(
        new PointerEvent("pointerdown", { button: 0, pointerId: 1, clientX: 80, clientY: 60, bubbles: true, cancelable: true })
      );
      window.dispatchEvent(
        new PointerEvent("pointermove", { pointerId: 1, clientX: 160, clientY: 120, bubbles: true })
      );
      window.dispatchEvent(
        new PointerEvent("pointerup", { pointerId: 1, clientX: 160, clientY: 120, bubbles: true })
      );
      expect(onPanelMoved.calls).toHaveLength(0);

      // 2. While locked: dragging empty canvas background DOES pan the canvas!
      viewport.dispatchEvent(
        new PointerEvent("pointerdown", { button: 0, pointerId: 2, clientX: 400, clientY: 350, bubbles: true, cancelable: true })
      );
      window.dispatchEvent(
        new PointerEvent("pointermove", { pointerId: 2, clientX: 465, clientY: 395, bubbles: true })
      );
      window.dispatchEvent(
        new PointerEvent("pointerup", { pointerId: 2, clientX: 465, clientY: 395, bubbles: true })
      );
      expect(ui.panX).toBe(65);
      expect(ui.panY).toBe(45);

      // 3. While locked: wheel zoom works, while right-click context add menu stays suppressed
      viewport.dispatchEvent(
        new WheelEvent("wheel", { deltaY: -120, clientX: 250, clientY: 200, bubbles: true, cancelable: true })
      );
      expect(ui.zoom).toBeGreaterThan(1);

      viewport.dispatchEvent(
        new MouseEvent("contextmenu", { clientX: 300, clientY: 220, bubbles: true, cancelable: true })
      );
      expect(onContextAdd.calls).toHaveLength(0);

      // 4. Unlock panels/nodes -> panel dragging and right-click context add menu now work
      ui.nodesLocked = false;
      panelHandle.dispatchEvent(
        new PointerEvent("pointerdown", { button: 0, pointerId: 3, clientX: 80, clientY: 60, bubbles: true, cancelable: true })
      );
      window.dispatchEvent(
        new PointerEvent("pointermove", { pointerId: 3, clientX: 140, clientY: 110, bubbles: true })
      );
      window.dispatchEvent(
        new PointerEvent("pointerup", { pointerId: 3, clientX: 140, clientY: 110, bubbles: true })
      );
      expect(onPanelMoved.calls).toHaveLength(1);
      expect(onPanelMoved.calls[0]?.[0]).toBe("cockpit");

      viewport.dispatchEvent(
        new MouseEvent("contextmenu", { clientX: 300, clientY: 220, bubbles: true, cancelable: true })
      );
      expect(onContextAdd.calls).toHaveLength(1);
    } finally {
      unbind();
    }
  });

  it("renders multi-stage FormatDiagram cards, root-stage detection, and spawn coordinate suggestions", () => {
    const race = makeRaceState({
      lifecycle: "draft",
      roster: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => makeEventPilot(i)),
      stages: [
        makeStage(1, { id: "stage-1", title: "Qualifier", format: "qualifying", status: "active" }),
        makeStage(2, { id: "stage-2", title: "Championship Finals", format: "double_elimination", status: "pending" }),
      ],
      stageConnections: [
        {
          id: "sc-1",
          fromStageId: "stage-1",
          toStageId: "stage-2",
          fromStageIndex: 1,
          toStageIndex: 2,
          mode: "top",
          count: 8,
        },
      ],
    });
    expect(isRootStage(race, 1)).toBe(true);
    expect(isRootStage(race, 2)).toBe(false);
    expect(getPresentStageIndices(race)).toEqual([1, 2]);

    const ui = createDefaultBracketEditorUiState(() => {});
    const spawn = suggestNewStageSpawnPosition(race, ui);
    expect(spawn.x).toBeGreaterThan(500);

    const html = renderFormatMarkup(race, { editable: true, editorUi: ui });
    const root = mountHtml(html);
    const stageCards = root.querySelectorAll("[data-stage-node]");
    expect(stageCards).toHaveLength(2);
    expect(root.textContent).toContain("Qualifier");
    expect(root.textContent).toContain("Championship Finals");
  });

  it("preserves .lap-ed-table-wrap scrollTop across crossing edits and avoids rebuilding table DOM on live RSSI ticks", () => {
    const startToneUs = 1_000_000;
    const baseCrossings = Array.from({ length: 12 }, (_, idx) => ({
      crossingId: 100 + idx,
      timestampUs: startToneUs + (idx + 1) * 8_000_000,
      peakRssiDbm: -46 - idx,
      invalidated: false,
      manual: idx === 11,
    }));
    const buildRace = (opts: { invThird?: boolean; traceSamples?: number }) => {
      const crossings = baseCrossings.map((c, idx) =>
        idx === 2 && opts.invThird ? { ...c, invalidated: true } : c
      );
      const rssiTrace = Array.from({ length: opts.traceSamples ?? 4 }, (_, i) => ({
        t: i * 1000,
        r: -65 + (i % 5),
      }));
      const heat = makeHeat("Q1-H1", {
        id: "Q1-H1",
        title: "Qualifying Heat 1",
        state: "running",
        targetLaps: 6,
        startMode: "heads_up",
        startToneUs,
        elapsedSec: (opts.traceSamples ?? 4) * 1.0,
        seats: [
          makeSeat(0, 1, {
            callsign: "ALPHA",
            lapsCompleted: opts.invThird ? 6 : 7,
            totalTimeSec: 56.0,
            bestLapSec: 8.0,
            holeshotSec: 8.0,
            crossings,
            rssiTrace,
          }),
          makeSeat(1, 2, {
            callsign: "BRAVO",
            lapsCompleted: 2,
            totalTimeSec: 18.5,
            bestLapSec: 8.5,
            holeshotSec: 1.5,
            crossings: baseCrossings.slice(0, 3),
          }),
        ],
      });
      return makeRaceState({
        raceId: "race-scroll",
        lifecycle: "active",
        generated: true,
        activeHeatId: "Q1-H1",
        heats: [heat],
      });
    };

    const r0 = buildRace({ invThird: false, traceSamples: 4 });
    const store = makeStore({
      nodes: [makeGate(1, { role: "START_FINISH" })],
      raceState: r0,
      eventState: { initialized: true, activeRaceId: "race-scroll", races: [r0] },
    });
    const { api } = makeMockApiClient(store);

    openHeatLapEditorModal(store, api, "Q1-H1", 1, "race-scroll");
    try {
      const backdrop = document.querySelector<HTMLElement>(".slaprf-modal-backdrop")!;
      expect(backdrop).not.toBeNull();
      const firstTableWrap = backdrop.querySelector<HTMLElement>(".lap-ed-table-wrap")!;
      expect(firstTableWrap).not.toBeNull();
      firstTableWrap.scrollTop = 94;
      const targetScroll = firstTableWrap.scrollTop;
      expect(targetScroll).toBeGreaterThan(40);

      // 1. Live RSSI sample arrives (without crossing/table changes):
      // table DOM node is NOT replaced at all and scrollTop stays at targetScroll!
      const rTrace = buildRace({ invThird: false, traceSamples: 9 });
      store.hydrate({
        serverTimestampUs: store.serverTimestampUs + 200_000,
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
        laprfEmulatorStatus: store.laprfEmulator,
        raceState: rTrace,
        eventState: { initialized: true, activeRaceId: "race-scroll", races: [rTrace] },
        practiceState: store.practiceState,
      });
      const afterTraceWrap = backdrop.querySelector<HTMLElement>(".lap-ed-table-wrap")!;
      expect(afterTraceWrap).toBe(firstTableWrap);
      expect(afterTraceWrap.scrollTop).toBe(targetScroll);

      // 2. Crossing edit arrives (tableSig changes -> full modal re-render):
      // scrollTop is preserved at targetScroll!
      const rEdited = buildRace({ invThird: true, traceSamples: 9 });
      store.hydrate({
        serverTimestampUs: store.serverTimestampUs + 400_000,
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
        laprfEmulatorStatus: store.laprfEmulator,
        raceState: rEdited,
        eventState: { initialized: true, activeRaceId: "race-scroll", races: [rEdited] },
        practiceState: store.practiceState,
      });
      const afterEditWrap = backdrop.querySelector<HTMLElement>(".lap-ed-table-wrap")!;
      expect(afterEditWrap.scrollTop).toBe(targetScroll);
      expect(afterEditWrap.querySelectorAll("tr.is-invalid-row")).toHaveLength(1);

      // 3. Re-opening for another pilot resets scrollTop to 0 cleanly
      openHeatLapEditorModal(store, api, "Q1-H1", 2, "race-scroll");
      const switchedBackdrop = document.querySelector<HTMLElement>(".slaprf-modal-backdrop")!;
      const switchedWrap = switchedBackdrop.querySelector<HTMLElement>(".lap-ed-table-wrap")!;
      expect(switchedWrap.scrollTop).toBe(0);
    } finally {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    }
  });

  it("renders delete button on ZippyQ and Open Qualifier round nodes and skips confirmation when unconnected and empty", () => {
    const race = makeRaceState({
      lifecycle: "draft",
      generated: true,
      activeStageIndex: 1,
      roster: [1, 2, 3, 4].map((i) => makeEventPilot(i)),
      stages: [
        makeStage(1, { id: "stage-1", title: "ZippyQ Qualifier", format: "open_qualifier", status: "active" }),
      ],
      rounds: [
        {
          id: "stage1-open-qual",
          stageIndex: 1,
          round: 1,
          column: 1,
          bracketLane: "open_qual",
          title: "ZippyQ Round 1",
          stageFormat: "open_qualifier",
          startMode: "staggered",
          targetLaps: 0,
          timeLimitSec: 120,
          seedSource: "all_active_pilots",
        },
        {
          id: "rnd-zippy-2",
          stageIndex: 1,
          round: 2,
          column: 2,
          bracketLane: "qualifying",
          title: "ZippyQ Round 2",
          stageFormat: "open_qualifier",
          startMode: "staggered",
          targetLaps: 0,
          timeLimitSec: 120,
          seedSource: "empty",
        },
      ],
      heats: [],
      connections: [],
    });

    const ui = createDefaultBracketEditorUiState(() => {});
    const html = renderBracketMarkup(race, {
      editable: true,
      canvas: true,
      stageFilter: 1,
      editorUi: ui,
    });
    const root = mountHtml(html);

    const zq1Btn = root.querySelector<HTMLButtonElement>(
      "[data-round-node='stage1-open-qual'] .bkt-node-delete-btn[data-bkt-action='delete_round']"
    );
    const zq2Btn = root.querySelector<HTMLButtonElement>(
      "[data-round-node='rnd-zippy-2'] .bkt-node-delete-btn[data-bkt-action='delete_round']"
    );
    expect(zq1Btn).not.toBeNull();
    expect(zq2Btn).not.toBeNull();
    expect(zq1Btn!.disabled).toBe(false);
    expect(zq2Btn!.disabled).toBe(false);

    // Quick-glance max heats pills render on a single row: ∞, 2, 3, More
    const pills = Array.from(
      root.querySelectorAll<HTMLButtonElement>("[data-round-node='stage1-open-qual'] .races-preset-pills button")
    ).map((b) => b.textContent?.trim());
    expect(pills).toEqual(["∞", "2", "3", "More"]);

    // Unconnected empty ZippyQ rounds delete immediately; adding a connection prompts confirmation
    expect(roundNeedsDeleteConfirmation(race, "rnd-zippy-2")).toBe(false);
    expect(roundNeedsDeleteConfirmation(race, "stage1-open-qual")).toBe(false);
    race.connections = [
      {
        id: "conn-zq1-zq2",
        stageIndex: 1,
        fromRoundId: "stage1-open-qual",
        toRoundId: "rnd-zippy-2",
        mode: "all_pilots",
        count: 0,
      },
    ];
    expect(roundNeedsDeleteConfirmation(race, "stage1-open-qual")).toBe(true);

    // Deleting all rounds leaves a clean empty custom stage canvas without .rc-empty-floater
    const emptyCustomRace = makeRaceState({
      lifecycle: "draft",
      generated: true,
      activeStageIndex: 1,
      roster: [1, 2, 3, 4].map((i) => makeEventPilot(i)),
      stages: [
        makeStage(1, { id: "stage-1", title: "Custom Stage 1", format: "custom", customized: true, status: "active" }),
      ],
      rounds: [],
      heats: [],
      connections: [],
    });
    const emptyCanvasRoot = mountHtml(
      renderBracketMarkup(emptyCustomRace, {
        editable: true,
        canvas: true,
        stageFilter: 1,
        editorUi: ui,
      })
    );
    expect(emptyCanvasRoot.querySelector(".rc-empty-floater")).toBeNull();
    expect(emptyCanvasRoot.querySelector("[data-round-node='stage1-pilots-in']")).not.toBeNull();

    const emptyFormatRoot = mountHtml(renderFormatMarkup(emptyCustomRace, { editable: true, editorUi: ui }));
    expect(emptyFormatRoot.textContent).toContain("Custom Stage 1");
    expect(emptyFormatRoot.textContent).toContain("Empty custom stage");
  });
});
