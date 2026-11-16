import {
  clamp,
  esc,
  fmtAgo,
  fmtClock,
  fmtDelta,
  fmtRaceClock,
  fmtTime,
} from "../core/format";
import { closeCustomSelect, installCustomSelects } from "../core/custom_select";
import { icons } from "../core/icons";
import {
  BAND_BOSCAM_A,
  BAND_BOSCAM_B,
  BAND_BOSCAM_E,
  BAND_FATSHARK,
  BAND_IMD6,
  BAND_RACEBAND,
  decodeBandChannel,
  encodeBandChannel,
  formatBandChannelShort,
  formatBandChannelWithFreq,
  formatSeatVoiceChannel,
  lookupBandChannelByFreqMHz,
  renderMultiBandSelectOptionsHtml,
  VTX_BANDS,
} from "../core/vtx_channels";
import {
  buildAnalyticsHash,
  buildPracticeHash,
  buildRacesHash,
  buildSectionHash,
  consumePendingPracticeTab,
  consumePendingRacesStage,
  consumePendingRacesTab,
  dispatchPracticeTopBarCommand,
  dispatchRacesTopBarCommand,
  getAnalyticsScope,
  getPracticeTopBarContext,
  getRacesTopBarContext,
  getRememberedRouteHash,
  isSidebarCollapsed,
  onAnalyticsScopeChange,
  onPracticeTopBarCommand,
  onPracticeTopBarContextChange,
  onRacesRouteTargetChange,
  onRacesTopBarCommand,
  onRacesTopBarContextChange,
  onSidebarCollapsedChange,
  parseHashState,
  pushAppHash,
  replaceAppHash,
  requestPracticeTab,
  requestRacesTab,
  Router,
  setAnalyticsScope,
  setPracticeTopBarContext,
  setRacesTopBarContext,
  setSidebarCollapsed,
  slugifyPracticeName,
  slugifyRaceName,
  toggleSidebarCollapsed,
} from "../core/router";
import { installTableScrollIndicators } from "../core/table_scroll";
import { describe, expect, it, mountHtml } from "./harness";

describe("core/format", () => {
  it("escapes HTML special characters without altering safe unicode or alphanumeric text", () => {
    expect(esc(`FPV <Pilot> & "Friends" '26`)).toBe(
      "FPV &lt;Pilot&gt; &amp; &quot;Friends&quot; &#39;26"
    );
    expect(esc("Vanover · T1 → T2")).toBe("Vanover · T1 → T2");
    expect(esc("")).toBe("");
  });

  it("formats lap and split times with configurable precision and em-dash fallbacks", () => {
    expect(fmtTime(13.4824)).toBe("13.482");
    expect(fmtTime(13.4824, 2)).toBe("13.48");
    expect(fmtTime(0)).toBe("—");
    expect(fmtTime(-1.5)).toBe("—");
    expect(fmtTime(Number.NaN)).toBe("—");
    expect(fmtTime(Number.POSITIVE_INFINITY)).toBe("—");
  });

  it("formats signed deltas with ±0.000 deadband and typographic minus sign", () => {
    expect(fmtDelta(0)).toBe("±0.000");
    expect(fmtDelta(0.0004)).toBe("±0.000");
    expect(fmtDelta(-0.00049)).toBe("±0.000");
    expect(fmtDelta(0.2314)).toBe("+0.231");
    expect(fmtDelta(-0.1042)).toBe("−0.104");
    expect(fmtDelta(-1.25, 2)).toBe("−1.25");
    expect(fmtDelta(Number.NaN)).toBe("—");
    expect(fmtDelta(Number.POSITIVE_INFINITY)).toBe("—");
  });

  it("formats microsecond engine clocks, race clocks, clamps, and relative timestamps", () => {
    expect(fmtClock(0)).toBe("00:00.000");
    expect(fmtClock(252_385_999)).toBe("04:12.385");
    expect(fmtClock(3_661_005_000)).toBe("61:01.005");

    expect(fmtRaceClock(-5)).toBe("00:00.0");
    expect(fmtRaceClock(72.44)).toBe("01:12.4");
    expect(fmtRaceClock(5.06)).toBe("00:05.1");

    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-3, 0, 10)).toBe(0);
    expect(clamp(99, 0, 10)).toBe(10);

    expect(fmtAgo(Number.POSITIVE_INFINITY)).toBe("not flown yet");
    expect(fmtAgo(Number.NaN)).toBe("not flown yet");
    expect(fmtAgo(12.4)).toBe("12s ago");
    expect(fmtAgo(245)).toBe("4m ago");
    expect(fmtAgo(7250)).toBe("2h ago");
  });
});

describe("core/icons", () => {
  it("renders valid, sized inline SVG icons including updated hammer and arrowRight glyphs", () => {
    const hammer19 = icons.hammer(19);
    expect(hammer19).toContain("<svg");
    expect(hammer19).toContain('width="19"');
    expect(hammer19).toContain('height="19"');

    const arrow = icons.arrowRight(13);
    expect(arrow).toContain("<svg");
    expect(arrow).toContain('width="13"');

    const info = icons.info(13);
    expect(info).toContain("<circle");
  });
});

describe("core/router — URL slugs & hash parsing", () => {
  it("slugifies race and practice names deterministically and guards reserved nav words", () => {
    expect(slugifyRaceName("Friday Night Brawl #4")).toBe("friday-night-brawl-4");
    expect(slugifyRaceName("  Fast & Loose!!  ")).toBe("fast-and-loose");
    expect(slugifyRaceName("")).toBe("race");
    expect(slugifyRaceName("   ")).toBe("race");

    // Reserved sub-route tokens must be suffixed so they never collide with `#/races/control`, `#/races/stage-2`, etc.
    expect(slugifyRaceName("Control")).toBe("control-race");
    expect(slugifyRaceName("Format")).toBe("format-race");
    expect(slugifyRaceName("Review")).toBe("review-race");
    expect(slugifyRaceName("Stage 2")).toBe("stage-2-race");

    expect(slugifyPracticeName("Warmup Pack #1")).toBe("warmup-pack-1");
    expect(slugifyPracticeName("")).toBe("practice");
    expect(slugifyPracticeName("Session")).toBe("session-practice");
    expect(slugifyPracticeName("Directory")).toBe("directory-practice");
  });

  it("parses legacy, raceless, and race-scoped hierarchical hashes accurately", () => {
    expect(parseHashState("")).toBeNull();
    expect(parseHashState("#")).toBeNull();
    expect(parseHashState("#/")).toBeNull();
    expect(parseHashState("#/unknown-route")).toBeNull();

    // Legacy top-level aliases
    expect(parseHashState("#/events")).toEqual({ route: "races", races: { tab: "directory" } });
    expect(parseHashState("#/race-setup")).toEqual({ route: "races", races: { tab: "format" } });
    expect(parseHashState("#/race-control")).toEqual({ route: "races", races: { tab: "control" } });

    // Raceless workspace paths
    expect(parseHashState("#/races")).toEqual({ route: "races", races: { tab: "directory" } });
    expect(parseHashState("#/races/format")).toEqual({ route: "races", races: { tab: "format" } });
    expect(parseHashState("#/races/control")).toEqual({ route: "races", races: { tab: "control" } });
    expect(parseHashState("#/races/review")).toEqual({ route: "races", races: { tab: "review" } });
    expect(parseHashState("#/races/edit")).toEqual({
      route: "races",
      races: { tab: "edit", stage: 1 },
    });
    expect(parseHashState("#/races/stage/3")).toEqual({
      route: "races",
      races: { tab: "edit", stage: 3 },
    });
    expect(parseHashState("#/races/format/stage-2")).toEqual({
      route: "races",
      races: { tab: "edit", stage: 2 },
    });

    // Race-scoped paths (including URL-encoded slugs & out-of-range stage clamping)
    expect(parseHashState("#/races/friday-brawl")).toEqual({
      route: "races",
      races: { tab: "format", raceKey: "friday-brawl" },
    });
    expect(parseHashState("#/races/friday-brawl/control")).toEqual({
      route: "races",
      races: { tab: "control", raceKey: "friday-brawl" },
    });
    expect(parseHashState("#/races/friday-brawl/review")).toEqual({
      route: "races",
      races: { tab: "review", raceKey: "friday-brawl" },
    });
    expect(parseHashState("#/races/friday-brawl/format/stage-2")).toEqual({
      route: "races",
      races: { tab: "edit", raceKey: "friday-brawl", stage: 2 },
    });
    expect(parseHashState("#/races/friday%20brawl/stage/4")).toEqual({
      route: "races",
      races: { tab: "edit", raceKey: "friday brawl", stage: 4 },
    });
    expect(parseHashState("#/races/friday-brawl/format/stage-99")).toEqual({
      route: "races",
      races: { tab: "edit", raceKey: "friday-brawl", stage: 1 },
    });
  });

  it("parses practice, analytics scope, and section-anchor hashes and round-trips builders", () => {
    expect(parseHashState("#/live")).toEqual({ route: "live", live: { tab: "directory" } });
    expect(parseHashState("#/live/session")).toEqual({ route: "live", live: { tab: "session" } });
    expect(parseHashState("#/live/session/warmup-1")).toEqual({
      route: "live",
      live: { tab: "session", sessionId: "warmup-1" },
    });
    expect(parseHashState("#/live/pack-3")).toEqual({
      route: "live",
      live: { tab: "session", sessionId: "pack-3" },
    });

    expect(parseHashState("#/pilot")).toEqual({
      route: "pilot",
      analytics: null,
    });
    expect(parseHashState("#/pilot/race/friday-brawl/consistency")).toEqual({
      route: "pilot",
      analytics: { kind: "race", id: "friday-brawl" },
      sectionAnchor: "consistency",
    });
    expect(parseHashState("#/analytics/practice/sess-2#laps")).toEqual({
      route: "pilot",
      analytics: { kind: "practice", id: "sess-2" },
      sectionAnchor: "laps",
    });
    expect(parseHashState("#/setup/rules")).toEqual({
      route: "setup",
      sectionAnchor: "rules",
    });

    // Builder round-trips
    const raceEditHash = buildRacesHash("edit", "club-champs", 2);
    expect(raceEditHash).toBe("#/races/club-champs/format/stage-2");
    expect(parseHashState(raceEditHash)).toEqual({
      route: "races",
      races: { tab: "edit", raceKey: "club-champs", stage: 2 },
    });

    const pracHash = buildPracticeHash("session", "morning-pack");
    expect(pracHash).toBe("#/live/morning-pack");
    expect(parseHashState(pracHash)).toEqual({
      route: "live",
      live: { tab: "session", sessionId: "morning-pack" },
    });

    const analyticsHash = buildAnalyticsHash({ kind: "race", id: "r-9" }, "overview");
    expect(analyticsHash).toBe("#/pilot/race/r-9/overview");
    expect(parseHashState(analyticsHash)).toEqual({
      route: "pilot",
      analytics: { kind: "race", id: "r-9" },
      sectionAnchor: "overview",
    });

    setAnalyticsScope({ kind: "practice", id: "p-1" });
    expect(buildSectionHash("pilot", "splits")).toBe("#/pilot/practice/p-1/splits");
    expect(buildSectionHash("setup", "announcer")).toBe("#/setup/announcer");
  });

  it("deduplicates TopBar context updates, persists analytics scope & sidebar state, and remembers route hashes", () => {
    let raceCtxFires = 0;
    const unsubRaceCtx = onRacesTopBarContextChange(() => {
      raceCtxFires++;
    });
    setRacesTopBarContext({
      tab: "control",
      raceId: "r-1",
      raceName: "Night Race",
      activeStage: 1,
      totalStages: 2,
      stageTitle: "Qualifying",
    });
    const firstCount = raceCtxFires;
    expect(firstCount).toBe(1);
    // Identical payload must be a no-op
    setRacesTopBarContext({
      tab: "control",
      raceId: "r-1",
      raceName: "Night Race",
      activeStage: 1,
      totalStages: 2,
      stageTitle: "Qualifying",
    });
    expect(raceCtxFires).toBe(1);
    expect(getRacesTopBarContext().raceName).toBe("Night Race");
    unsubRaceCtx();

    let pracCtxFires = 0;
    const unsubPracCtx = onPracticeTopBarContextChange(() => {
      pracCtxFires++;
    });
    setPracticeTopBarContext({
      tab: "session",
      sessionId: "s-1",
      sessionName: "Pack 1",
      active: true,
    });
    setPracticeTopBarContext({
      tab: "session",
      sessionId: "s-1",
      sessionName: "Pack 1",
      active: true,
    });
    expect(pracCtxFires).toBe(1);
    expect(getPracticeTopBarContext().active).toBe(true);
    unsubPracCtx();

    // Commands & pending tabs
    const receivedRacesCmds: string[] = [];
    const unsubRCmd = onRacesTopBarCommand((cmd) => receivedRacesCmds.push(cmd.type));
    dispatchRacesTopBarCommand({ type: "set-stage", stage: 2 });
    expect(receivedRacesCmds).toEqual(["set-stage"]);
    unsubRCmd();

    const receivedPracCmds: string[] = [];
    const unsubPCmd = onPracticeTopBarCommand((cmd) => receivedPracCmds.push(cmd.tab));
    dispatchPracticeTopBarCommand({ type: "set-tab", tab: "directory" });
    expect(receivedPracCmds).toEqual(["directory"]);
    unsubPCmd();

    requestRacesTab("review");
    expect(consumePendingRacesTab()).toBe("review");
    expect(consumePendingRacesTab()).toBeNull();
    requestPracticeTab("session");
    expect(consumePendingPracticeTab()).toBe("session");
    expect(consumePendingPracticeTab()).toBeNull();

    // Analytics scope persistence & subscription
    const scopesSeen: Array<string> = [];
    const unsubScope = onAnalyticsScopeChange((s) =>
      scopesSeen.push(s ? `${s.kind}:${s.id}` : "null")
    );
    setAnalyticsScope(null);
    setAnalyticsScope({ kind: "race", id: "brawl-1" });
    expect(getAnalyticsScope()).toEqual({ kind: "race", id: "brawl-1" });
    expect(window.localStorage.getItem("slaprf.ui.analyticsScope.v1")).toContain("brawl-1");
    unsubScope();
    expect(scopesSeen[scopesSeen.length - 1]).toBe("race:brawl-1");

    // Sidebar collapse toggle & persistence
    setSidebarCollapsed(false);
    let sidebarChanges = 0;
    const unsubSidebar = onSidebarCollapsedChange(() => sidebarChanges++);
    toggleSidebarCollapsed();
    expect(isSidebarCollapsed()).toBe(true);
    expect(window.localStorage.getItem("slaprf.ui.sidebarCollapsed.v1")).toBe("1");
    toggleSidebarCollapsed();
    expect(isSidebarCollapsed()).toBe(false);
    expect(sidebarChanges).toBe(2);
    unsubSidebar();

    // Router + pushAppHash / replaceAppHash + navigateSection sub-hash restoration
    const router = new Router();
    const routeEvents: string[] = [];
    const unsubRouter = router.subscribe((r) => routeEvents.push(r));
    const subTargets: string[] = [];
    const unsubSub = onRacesRouteTargetChange((t) => subTargets.push(`${t.tab}:${t.raceKey ?? ""}`));

    pushAppHash("#/races/brawl-1/control");
    expect(router.route).toBe("races");
    expect(getRememberedRouteHash("races")).toBe("#/races/brawl-1/control");

    replaceAppHash("#/setup/timers");
    expect(router.route).toBe("setup");
    expect(routeEvents).toContain("setup");

    // Switching back to "races" via navigateSection restores remembered sub-hash `#/races/brawl-1/control`
    router.navigateSection("races");
    expect(router.route).toBe("races");
    expect(location.hash).toBe("#/races/brawl-1/control");
    expect(subTargets[subTargets.length - 1]).toBe("control:brawl-1");

    // Consuming stage side-effect from pushAppHash
    pushAppHash("#/races/brawl-1/format/stage-3");
    expect(consumePendingRacesStage()).toBe(3);

    unsubSub();
    unsubRouter();
    router.clearListeners();
  });
});

describe("core/custom_select & core/table_scroll", () => {
  it("upgrades select.input into custom accessible trigger + listbox popover and syncs changes", async () => {
    const root = mountHtml(`
      <div>
        <select class="input mono" aria-label="Pick Channel">
          <option value="1">R1 5658</option>
          <option value="3" selected>R3 5732</option>
          <option value="8">R8 5917</option>
        </select>
      </div>
    `);
    installCustomSelects();

    const selectEl = root.querySelector<HTMLSelectElement>("select.input")!;
    const trigger = root.querySelector<HTMLButtonElement>(".custom-select-trigger")!;
    expect(trigger).toBeDefined();
    expect(trigger.textContent).toContain("R3 5732");
    expect(trigger.classList.contains("mono")).toBe(true);

    // Click trigger to open custom popover
    trigger.click();
    const pop = document.querySelector<HTMLElement>(".custom-select-popover")!;
    expect(pop).toBeDefined();
    const opts = pop.querySelectorAll<HTMLButtonElement>(".custom-select-option");
    expect(opts).toHaveLength(3);

    let changeFired = 0;
    selectEl.addEventListener("change", () => changeFired++);
    opts[2].click(); // Select R8 5917

    expect(selectEl.value).toBe("8");
    expect(changeFired).toBe(1);
    expect(trigger.textContent).toContain("R8 5917");
    expect(document.querySelector(".custom-select-popover")).toBeNull();
  });

  it("toggles open/closed deterministically when clicking trigger text, inside <label>, or across parent DOM re-renders", () => {
    closeCustomSelect();
    const renderPilotFormHtml = (selectedVal: string) => `
      <form data-pilot="1">
        <label class="field">
          <span>Default channel</span>
          <select class="input" name="channel">
            ${renderMultiBandSelectOptionsHtml({
              selectedEncoded: Number(selectedVal),
              includeUnassigned: true,
              unassignedLabel: "No default",
            })}
          </select>
        </label>
      </form>
    `;

    const root = mountHtml(renderPilotFormHtml("1"));
    installCustomSelects();

    const trigger = root.querySelector<HTMLButtonElement>(".custom-select-trigger")!;
    const labelSpan = trigger.querySelector<HTMLElement>(".custom-select-trigger-label")!;
    expect(trigger).toBeDefined();
    expect(labelSpan.textContent).toContain("R1 · 5658 MHz");

    // 1. Clicking directly on the text span opens the popover
    labelSpan.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    labelSpan.click();
    expect(document.querySelector(".custom-select-popover")).not.toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    // 2. Clicking directly on the text span AGAIN (inside a wrapping <label>) closes cleanly without flashing/reopening!
    labelSpan.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    labelSpan.click();
    expect(document.querySelector(".custom-select-popover")).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    // 3. Re-open, then simulate parent re-rendering `innerHTML` with a brand new `<select>` + `installCustomSelects()`
    trigger.click();
    expect(document.querySelector(".custom-select-popover")).not.toBeNull();

    root.innerHTML = renderPilotFormHtml("1");
    installCustomSelects();

    const newTrigger = root.querySelector<HTMLButtonElement>(".custom-select-trigger")!;
    const newLabelSpan = newTrigger.querySelector<HTMLElement>(".custom-select-trigger-label")!;

    // Clicking the newly re-rendered trigger text STILL recognizes the open popover via identity key and closes it!
    newLabelSpan.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    newLabelSpan.click();
    expect(document.querySelector(".custom-select-popover")).toBeNull();

    // 4. Re-open, re-render parent DOM, then pick "F4 · 5800 MHz" from the open popover -> updates the LIVE replacement <select>!
    newTrigger.click();
    const pop = document.querySelector<HTMLElement>(".custom-select-popover")!;
    expect(pop).not.toBeNull();

    root.innerHTML = renderPilotFormHtml("1");
    installCustomSelects();
    const liveSelect = root.querySelector<HTMLSelectElement>("select.input")!;
    let liveChanges = 0;
    liveSelect.addEventListener("change", () => liveChanges++);

    const f4Btn = pop.querySelector<HTMLButtonElement>('[data-opt-value="24"]')!;
    expect(f4Btn).not.toBeNull();
    f4Btn.click();

    expect(liveSelect.value).toBe("24");
    expect(liveChanges).toBe(1);
    expect(document.querySelector(".custom-select-popover")).toBeNull();
  });

  it("encodes, decodes, and formats all 6 legal 5.8 GHz FPV racing frequency bands", () => {
    expect(VTX_BANDS.map((b) => b.groupLabel)).toEqual([
      "Raceband",
      "Fatshark / IRC",
      "Boscam A",
      "Boscam B",
      "Boscam E",
      "IMD6",
    ]);

    expect(encodeBandChannel(BAND_RACEBAND, 4)).toBe(4);
    expect(decodeBandChannel(4)).toEqual({
      band: BAND_RACEBAND,
      channel: 4,
      frequencyMhz: 5769,
      encoded: 4,
    });

    expect(encodeBandChannel(BAND_FATSHARK, 4)).toBe(24);
    expect(decodeBandChannel(24)).toEqual({
      band: BAND_FATSHARK,
      channel: 4,
      frequencyMhz: 5800,
      encoded: 24,
    });

    expect(encodeBandChannel(BAND_BOSCAM_A, 1)).toBe(41);
    expect(formatBandChannelWithFreq(BAND_BOSCAM_A, 1)).toBe("A1 · 5865 MHz");
    expect(encodeBandChannel(BAND_BOSCAM_B, 2)).toBe(62);
    expect(formatBandChannelShort(BAND_BOSCAM_B, 2)).toBe("B2");
    expect(encodeBandChannel(BAND_BOSCAM_E, 7)).toBe(37);
    expect(formatSeatVoiceChannel(BAND_FATSHARK, 4)).toBe("Fatshark 4");
    expect(encodeBandChannel(BAND_IMD6, 3)).toBe(53);
    expect(lookupBandChannelByFreqMHz(5752)?.shortCode).toBe("B2");

    // Boscam E omits out-of-band E4 (5645) and E8 (5945) unless already selected
    const htmlDefault = renderMultiBandSelectOptionsHtml({ selectedBand: 1, selectedChannel: 1 });
    expect(htmlDefault).toContain('value="31"'); // E1
    expect(htmlDefault).toContain('value="37"'); // E7 (5925)
    expect(htmlDefault).not.toContain('value="34"'); // E4 (5645)
    expect(htmlDefault).not.toContain('value="38"'); // E8 (5945)
  });

  it("wraps .table-scroll elements with left/right edge scroll shell without double-wrapping", () => {
    const root = mountHtml(`
      <div class="card" data-slot="standings">
        <div class="table-scroll">
          <table><tr><td>Row 1</td></tr></table>
        </div>
      </div>
    `);
    installTableScrollIndicators();

    const shells = root.querySelectorAll(".table-scroll-shell");
    expect(shells).toHaveLength(1);
    expect(root.querySelector(".table-edge-nav.is-left")).toBeTruthy();
    expect(root.querySelector(".table-edge-nav.is-right")).toBeTruthy();
  });
});
