//go:build e2e

package e2e_test

import (
	"strings"
	"testing"
	"time"

	"github.com/mxschmitt/playwright-go"
)

func TestComponent_BootLoaderProgressAndReadyTransition(t *testing.T) {
	h := NewHarnessWithOptions(t, HarnessOptions{
		FullBootAnimation: true,
	})

	if _, err := h.Page.Goto(h.BaseURL+"/#/practice", playwright.PageGotoOptions{
		WaitUntil: playwright.WaitUntilStateCommit,
	}); err != nil {
		t.Fatalf("Goto #/practice: %v", err)
	}

	// Verify the radar boot loader starts visible before transitioning to .is-ready.
	h.WaitUntil("boot loader element mounted", 5*time.Second, func() (bool, error) {
		res, err := h.Page.Evaluate(`() => Boolean(document.getElementById("slaprf-boot-loader"))`)
		if err != nil {
			return false, nil
		}
		ok, _ := res.(bool)
		return ok, nil
	})
	h.MilestoneScreenshot("boot-loader-active")

	h.WaitUntil("boot loader completes and reveals #app", 15*time.Second, func() (bool, error) {
		res, err := h.Page.Evaluate(`() => {
			const loader = document.getElementById("slaprf-boot-loader");
			const app = document.getElementById("app");
			return Boolean(
				loader &&
				loader.classList.contains("is-ready") &&
				app &&
				!app.hidden &&
				app.childElementCount > 0
			);
		}`)
		if err != nil {
			return false, nil
		}
		ok, _ := res.(bool)
		return ok, nil
	})
	h.MilestoneScreenshot("boot-loader-ready")
}

func TestComponent_SidebarCollapseExpandAndPersistence(t *testing.T) {
	h := NewHarness(t)
	h.BootClean("#/practice")

	collapseBtn := h.Page.Locator(`aside button[data-action="collapse-sidebar"]`).First()
	h.MustBeVisible(collapseBtn, "Sidebar collapse button")
	if err := collapseBtn.Click(); err != nil {
		t.Fatalf("click collapse-sidebar: %v", err)
	}

	expandBtn := h.Page.Locator(`header button[data-action="expand-sidebar"], .topbar button[data-action="expand-sidebar"], button[data-action="expand-sidebar"]`).First()
	h.MustBeVisible(expandBtn, "TopBar expand-sidebar button when collapsed")
	h.MilestoneScreenshot("sidebar-collapsed")

	// Reload and confirm collapsed state persisted in localStorage.
	h.ReloadAndWait()
	h.MustBeVisible(expandBtn, "TopBar expand-sidebar button after reload")

	if err := expandBtn.Click(); err != nil {
		t.Fatalf("click expand-sidebar: %v", err)
	}
	h.MustBeVisible(collapseBtn, "Sidebar collapse button restored")
	h.MilestoneScreenshot("sidebar-expanded")
}

func TestComponent_TopBarBreadcrumbsAndOverflowMenu(t *testing.T) {
	h := NewHarness(t)
	h.BootWithSnapshot(SnapshotPracticePopulated, "#/practice/evening-lap-lab", nil)

	crumb := h.Page.Locator(`[data-practice-breadcrumb]`).First()
	h.MustContainText(crumb, "Evening Lap Lab")
	h.MilestoneScreenshot("topbar-practice-breadcrumb")

	// Verify Practice ribbon has the Analytics tab after Signals and renders scoped analytics:
	pracAnalyticsTab := h.Page.Locator(`button[data-practice-mobile-tab="analytics"]`).First()
	h.MustBeVisible(pracAnalyticsTab, "Practice ribbon Analytics tab button")
	if err := pracAnalyticsTab.Click(); err != nil {
		t.Fatalf("click Practice ribbon Analytics tab: %v", err)
	}
	h.MustBeVisible(h.Page.Locator(`[data-slot="mobile-analytics"] .analytics-picker-row`).First(), "Embedded Practice Analytics picker row")

	// Click parent "Practice" breadcrumb link to return to Practice directory, verifying pixel-locked "Practice" position and 15px size.
	backLink := crumb.Locator(`a.topbar-crumb-item[href="#/practice"]`).First()
	h.MustBeVisible(backLink, "Practice breadcrumb parent link")
	inPracCheck, err := h.Page.Evaluate(`() => {
		const crumbSpan = document.querySelector('[data-practice-breadcrumb] a.topbar-crumb-item[href="#/practice"] span');
		const actions = document.querySelector('.topbar-actions');
		if (!crumbSpan || !actions) return { ok: false, reason: "missing crumbSpan or actions" };
		const cr = crumbSpan.getBoundingClientRect();
		const ar = actions.getBoundingClientRect();
		const cs = window.getComputedStyle(crumbSpan.parentElement);
		return {
			ok: cs.fontSize === "15px" && Math.abs((cr.top + cr.height / 2) - (ar.top + ar.height / 2)) <= 1.5,
			left: Math.round(cr.left * 10) / 10,
			top: Math.round(cr.top * 10) / 10,
		};
	}`)
	if err != nil {
		t.Fatalf("evaluate in-practice breadcrumb metrics: %v", err)
	}
	inPracMap, _ := inPracCheck.(map[string]interface{})
	if inPracMap["ok"] != true {
		t.Fatalf("expected 15px breadcrumb 'Practice' vertically centered with topbar actions: %+v", inPracMap)
	}
	if err := backLink.Click(); err != nil {
		t.Fatalf("click Practice parent breadcrumb: %v", err)
	}
	h.MustBeVisible(h.Page.Locator(`input[data-session-dir-search]`).First(), "Practice directory search")
	dirPracCheck, err := h.Page.Evaluate(`(prev) => {
		const h1 = document.querySelector('.topbar-title.is-no-subtitle h1');
		const p = document.querySelector('.topbar-title p');
		const actions = document.querySelector('.topbar-actions');
		if (!h1 || !actions) return { ok: false, reason: "missing .topbar-title.is-no-subtitle h1" };
		const hr = h1.getBoundingClientRect();
		const ar = actions.getBoundingClientRect();
		const hs = window.getComputedStyle(h1);
		const leftDiff = Math.abs(hr.left - prev.left);
		const topDiff = Math.abs(hr.top - prev.top);
		const centerDiff = Math.abs((hr.top + hr.height / 2) - (ar.top + ar.height / 2));
		return {
			ok: p === null && hs.fontSize === "15px" && leftDiff <= 1 && topDiff <= 1 && centerDiff <= 1.5,
			hasSubtitle: p !== null,
			fontSize: hs.fontSize,
			leftDiff,
			topDiff,
			centerDiff,
		};
	}`, inPracMap)
	if err != nil {
		t.Fatalf("evaluate top-level Practice title alignment: %v", err)
	}
	if dMap, _ := dirPracCheck.(map[string]interface{}); dMap["ok"] != true {
		t.Fatalf("expected top-level 'Practice' title pixel-locked with breadcrumb 'Practice' (no subtitle, 15px, centered): %+v", dMap)
	}

	// Verify Desktop Practice directory table row "..." menu (Settings + Delete):
	pracRowMoreBtn := h.Page.Locator(`button[data-practice-act="toggle-dir-session-menu"]`).First()
	h.MustBeVisible(pracRowMoreBtn, "Desktop Practice table row '...' options button")
	if err := pracRowMoreBtn.Click(); err != nil {
		t.Fatalf("click Desktop Practice table '...' button: %v", err)
	}
	pracMoreMenu := h.Page.Locator(`.dir-row-more-menu`).First()
	h.MustBeVisible(pracMoreMenu, "Desktop Practice table '...' dropdown menu")
	h.MustBeVisible(pracMoreMenu.Locator(`[data-practice-act="dir-open-session-settings"]`), "Settings item in Practice '...' menu")
	h.MustBeVisible(pracMoreMenu.Locator(`[data-practice-act="delete-session"]`), "Delete item in Practice '...' menu")
	if err := pracMoreMenu.Locator(`[data-practice-act="dir-open-session-settings"]`).Click(); err != nil {
		t.Fatalf("click Settings in Practice '...' menu: %v", err)
	}
	pracSettingsModal := h.Page.Locator(`.slaprf-modal-backdrop[data-practice-settings-modal]`).First()
	h.MustBeVisible(pracSettingsModal, "Practice Settings modal opened from table '...' menu")
	if err := h.Page.Keyboard().Press("Escape"); err != nil {
		t.Fatalf("dismiss Practice Settings modal: %v", err)
	}
	h.MustBeHidden(pracSettingsModal, "Practice Settings modal closed")

	// Switch to mobile viewport (640px) so the bottom dock More navigation button is visible,
	// open it, verify secondary navigation tiles render, and dismiss cleanly!
	if err := h.Page.SetViewportSize(640, 840); err != nil {
		t.Fatalf("SetViewportSize(640, 840): %v", err)
	}
	moreBtn := h.Page.Locator(`button[data-action="toggle-mobile-more"]`).First()
	h.MustBeVisible(moreBtn, "Mobile dock More navigation button")
	if err := moreBtn.Click(); err != nil {
		t.Fatalf("click mobile More button: %v", err)
	}

	navMoreTile := h.Page.Locator(`.mobile-more-tile[data-route="flasher"]`).First()
	h.MustBeVisible(navMoreTile, "Mobile More drawer Flasher tile")
	h.MilestoneScreenshot("topbar-overflow-menu-open")

	if err := h.Page.Locator(`[data-mobile-more-handle="1"]`).First().Click(); err != nil {
		t.Fatalf("close mobile More drawer: %v", err)
	}
	h.MustBeHidden(navMoreTile, "Mobile More drawer closed")
}

func TestComponent_TopBarAnnouncerQuickMuteToggle(t *testing.T) {
	h := NewHarness(t)
	h.BootClean("#/practice")

	annBtn := h.Page.Locator(`button[data-action="announcer"]`).First()
	h.MustBeVisible(annBtn, "TopBar announcer mute toggle")

	readEnabled := func() bool {
		v, err := h.Page.Evaluate(`() => {
			try {
				const raw = localStorage.getItem("gate-timer.announcer");
				if (!raw) return false;
				const parsed = JSON.parse(raw);
				return Boolean(parsed.enabled);
			} catch {
				return false;
			}
		}`)
		if err != nil {
			t.Fatalf("read announcer storage: %v", err)
		}
		b, _ := v.(bool)
		return b
	}

	initial := readEnabled()
	if err := annBtn.Click(); err != nil {
		t.Fatalf("click announcer toggle (1): %v", err)
	}
	h.WaitUntil("announcer enabled flipped", 5*time.Second, func() (bool, error) {
		return readEnabled() != initial, nil
	})
	h.MilestoneScreenshot("topbar-announcer-toggled")

	if err := annBtn.Click(); err != nil {
		t.Fatalf("click announcer toggle (2): %v", err)
	}
	h.WaitUntil("announcer enabled restored", 5*time.Second, func() (bool, error) {
		return readEnabled() == initial, nil
	})
}

func TestComponent_CustomSelectOpenSelectEscapeAndOutsideClick(t *testing.T) {
	h := NewHarness(t)
	h.BootClean("#/pilots")

	trigger := h.Page.Locator(`button.custom-select-trigger`).First()
	h.MustBeVisible(trigger, "Upgraded CustomSelect trigger button")

	popover := h.Page.Locator(`.custom-select-popover`).First()

	// 1. Open and dismiss with Escape.
	if err := trigger.Click(); err != nil {
		t.Fatalf("open custom select (1): %v", err)
	}
	h.MustBeVisible(popover, "CustomSelect popover on click")
	h.MilestoneScreenshot("custom-select-open")

	if err := h.Page.Keyboard().Press("Escape"); err != nil {
		t.Fatalf("press Escape: %v", err)
	}
	h.MustBeHidden(popover, "CustomSelect popover closed on Escape")

	// 2. Open and dismiss via outside click.
	if err := trigger.Click(); err != nil {
		t.Fatalf("open custom select (2): %v", err)
	}
	h.MustBeVisible(popover, "CustomSelect popover reopened")
	if err := h.Page.Locator(`.topbar`).First().Click(); err != nil {
		t.Fatalf("outside click: %v", err)
	}
	h.MustBeHidden(popover, "CustomSelect popover closed on outside click")

	// 3. Open and choose a different option; verify trigger label updates.
	if err := trigger.Click(); err != nil {
		t.Fatalf("open custom select (3): %v", err)
	}
	h.MustBeVisible(popover, "CustomSelect popover reopened for selection")

	unselectedOpt := h.Page.Locator(`.custom-select-popover .custom-select-option:not(.is-selected):not([disabled])`).First()
	h.MustBeVisible(unselectedOpt, "Unselected CustomSelect option")
	optLabel, _ := unselectedOpt.Locator(`.custom-select-opt-text`).InnerText()
	optLabel = strings.TrimSpace(optLabel)

	if err := unselectedOpt.Click(); err != nil {
		t.Fatalf("click unselected option: %v", err)
	}
	h.MustBeHidden(popover, "CustomSelect popover closed after picking option")
	h.MustContainText(trigger, optLabel)
	h.MilestoneScreenshot("custom-select-updated")
}

func TestComponent_SectionAnchorScrollSpyAndDeepLink(t *testing.T) {
	h := NewHarness(t)
	h.BootClean("#/setup/persistence")

	// Deep link #/setup/persistence must scroll the Persistence section into view automatically.
	h.WaitUntil("page scrolled down to #/setup/persistence section", 8*time.Second, func() (bool, error) {
		res, err := h.Page.Evaluate(`() => window.scrollY > 120`)
		if err != nil {
			return false, nil
		}
		ok, _ := res.(bool)
		return ok, nil
	})
	h.MilestoneScreenshot("section-anchor-deep-link-persistence")

	// Simulate user scrolling back to top after initial deep-link settle window and verify scroll-spy clears /persistence.
	h.WaitUntil("scroll-spy updates hash at top of Setup page", 8*time.Second, func() (bool, error) {
		res, err := h.Page.Evaluate(`() => {
			window.dispatchEvent(new WheelEvent("wheel", { deltaY: -400 }));
			window.scrollTo({ top: 0, behavior: "auto" });
			window.dispatchEvent(new Event("scroll"));
			return window.location.hash;
		}`)
		if err != nil {
			return false, nil
		}
		hash, _ := res.(string)
		return hash == "#/setup" || hash == "#/setup/datasource", nil
	})
	h.MilestoneScreenshot("section-anchor-scroll-spy-top")
}

func TestComponent_SettingsIntroResponsiveCollapseSeeMoreLess(t *testing.T) {
	h := NewHarnessWithOptions(t, HarnessOptions{
		Viewport: &playwright.Size{Width: 960, Height: 800},
	})
	h.BootClean("#/setup")

	firstIntro := h.Page.Locator(`.settings-intro`).First()
	moreBtn := firstIntro.Locator(`.settings-intro-more`).First()
	h.MustBeVisible(moreBtn, "Responsive (see more) toggle in narrow viewport")
	h.MilestoneScreenshot("settings-intro-collapsed")

	if err := moreBtn.Click(); err != nil {
		t.Fatalf("click (see more): %v", err)
	}
	h.WaitUntil(".settings-intro.is-expanded set", 5*time.Second, func() (bool, error) {
		res, err := firstIntro.Evaluate(`el => el.classList.contains("is-expanded")`, nil)
		if err != nil {
			return false, nil
		}
		ok, _ := res.(bool)
		return ok, nil
	})

	lessBtn := firstIntro.Locator(`.settings-intro-less`).First()
	h.MustBeVisible(lessBtn, "Responsive (see less) button when expanded")
	h.MilestoneScreenshot("settings-intro-expanded")

	if err := lessBtn.Click(); err != nil {
		t.Fatalf("click (see less): %v", err)
	}
	h.WaitUntil(".settings-intro collapsed again", 5*time.Second, func() (bool, error) {
		res, err := firstIntro.Evaluate(`el => !el.classList.contains("is-expanded")`, nil)
		if err != nil {
			return false, nil
		}
		ok, _ := res.(bool)
		return ok, nil
	})
}

func TestComponent_TableScrollShellOverflowArrowsAndScrollPreserve(t *testing.T) {
	h := NewHarnessWithOptions(t, HarnessOptions{
		Viewport: &playwright.Size{Width: 940, Height: 820},
	})
	h.BootWithSnapshot(SnapshotPracticePopulated, "#/sim", nil)

	shell := h.Page.Locator(`.table-scroll-shell.has-overflow`).First()
	h.MustBeVisible(shell, "Horizontally overflowing .table-scroll-shell")

	rightBtn := shell.Locator(`.table-edge-nav.is-right.is-visible`).First()
	h.MustBeVisible(rightBtn, "Right table edge scroll arrow")
	h.MilestoneScreenshot("table-scroll-right-arrow")

	if err := rightBtn.Click(); err != nil {
		t.Fatalf("click right scroll edge button: %v", err)
	}

	leftBtn := shell.Locator(`.table-edge-nav.is-left.is-visible`).First()
	h.MustBeVisible(leftBtn, "Left table edge scroll arrow after scrolling right")
	h.MilestoneScreenshot("table-scroll-left-arrow")

	if err := leftBtn.Click(); err != nil {
		t.Fatalf("click left scroll edge button: %v", err)
	}
	h.WaitUntil("table scrolled back toward left", 5*time.Second, func() (bool, error) {
		res, err := shell.Locator(`.table-scroll-viewport`).First().Evaluate(`el => el.scrollLeft < 20`, nil)
		if err != nil {
			return false, nil
		}
		ok, _ := res.(bool)
		return ok, nil
	})
}

func TestComponent_MultiTabOwnershipConflictAndTakeover(t *testing.T) {
	// Single-tab IndexedDB ownership conflict applies in Standalone Browser Demo Mode (StaticDemoMode: true).
	// Native Go Backend Mode intentionally supports multi-tab simultaneous operation without conflict locks.
	h := NewHarnessWithOptions(t, HarnessOptions{StaticDemoMode: true})
	h.BootClean("#/practice")

	// Open a second tab in the same BrowserContext so BroadcastChannel / localStorage lock collides.
	page2, err := h.Ctx.NewPage()
	if err != nil {
		t.Fatalf("NewPage (tab 2): %v", err)
	}
	h.AttachErrorGuards(page2)

	if _, err := page2.Goto(h.BaseURL+"/#/practice", playwright.PageGotoOptions{
		WaitUntil: playwright.WaitUntilStateDomcontentloaded,
	}); err != nil {
		t.Fatalf("tab 2 Goto: %v", err)
	}

	takeoverBtn2 := page2.Locator(`#slaprf-boot-takeover-btn`).First()
	h.MustBeVisible(takeoverBtn2, "Tab 2 multi-tab conflict Use Here button")

	// Click "Use Here" in Tab 2 and verify Tab 2 boots while Tab 1 enters conflict lock screen!
	if err := takeoverBtn2.Click(); err != nil {
		t.Fatalf("click Use Here on tab 2: %v", err)
	}

	h.WaitUntil("Tab 2 takes over and Tab 1 shows displaced lock screen", 15*time.Second, func() (bool, error) {
		r2, err2 := page2.Evaluate(`() => {
			const loader = document.getElementById("slaprf-boot-loader");
			return Boolean(loader && loader.classList.contains("is-ready") && !loader.classList.contains("is-conflict"));
		}`)
		r1, err1 := h.Page.Evaluate(`() => {
			const loader = document.getElementById("slaprf-boot-loader");
			return Boolean(loader && loader.classList.contains("is-conflict"));
		}`)
		if err1 != nil || err2 != nil {
			return false, nil
		}
		ok2, _ := r2.(bool)
		ok1, _ := r1.(bool)
		return ok2 && ok1, nil
	})
	h.MilestoneScreenshot("tab1-displaced-conflict-screen")
	_ = page2.Close()
}

func TestComponent_AnnouncerWinnerHornAndCallout(t *testing.T) {
	h := NewHarness(t)
	if err := h.Ctx.AddInitScript(playwright.Script{
		Content: playwright.String(`
			window.__E2E_AUDIO_LOG = [];
			if (window.speechSynthesis) {
				window.speechSynthesis.getVoices = () => [{
					voiceURI: "Google US English",
					name: "Google US English",
					lang: "en-US",
					localService: true,
					default: true
				}];
				window.speechSynthesis.speak = (utt) => {
					window.__E2E_AUDIO_LOG.push({ kind: "speak", text: String(utt?.text || ""), t: Math.round(performance.now()) });
					setTimeout(() => { try { utt?.onstart?.(new Event("start")); } catch {} }, 5);
					setTimeout(() => { try { utt?.onend?.(new Event("end")); } catch {} }, 50);
				};
				window.speechSynthesis.cancel = () => {};
			}
			if (window.AudioContext) {
				const origOsc = AudioContext.prototype.createOscillator;
				AudioContext.prototype.createOscillator = function() {
					const osc = origOsc.call(this);
					const origStart = osc.start.bind(osc);
					osc.start = function(...args) {
						window.__E2E_AUDIO_LOG.push({ kind: "osc", type: osc.type, t: Math.round(performance.now()) });
						return origStart(...args);
					};
					return osc;
				};
			}
		`),
	}); err != nil {
		t.Fatalf("AddInitScript audio hooks: %v", err)
	}

	h.SeedSimStateAndStorage("", map[string]string{
		"gate-timer.announcer": `{"enabled":true,"raceLapCallouts":true,"keepScreenAwake":true,"voiceURI":"system","rate":1,"volume":1,"testPhrase":""}`,
	})
	h.BootClean("#/races")

	// Create a competitive Single Elimination race and navigate to Race Control.
	_, err := h.Page.Evaluate(`async () => {
		const r1 = await window.slaprfCurl({
			method: "POST",
			url: "/v1/race/sessions",
			body: { name: "Winner Announcer Test" },
			syncUi: true
		});
		const raceId = r1.json.raceState.raceId;
		await window.slaprfCurl({
			method: "POST",
			url: "/v1/race/sessions/" + encodeURIComponent(raceId) + "/pilots:checkInAll",
			body: {},
			syncUi: true
		});
		await window.slaprfCurl({
			method: "POST",
			url: "/v1/race/sessions/" + encodeURIComponent(raceId) + "/bracket:edit",
			body: { action: "apply_template", templateId: "single_elimination" },
			syncUi: true
		});
		window.location.hash = "#/races/" + raceId + "/control";
		return { raceId };
	}`)
	if err != nil {
		t.Fatalf("open control view: %v", err)
	}

	startBtn := h.Page.Locator(`[data-ctrl="start"]`).First()
	h.MustBeVisible(startBtn, "Start Heat button")
	if err := startBtn.Click(); err != nil {
		t.Fatalf("click Start Heat: %v", err)
	}
	time.Sleep(200 * time.Millisecond)
	_, _ = h.Page.Evaluate(`() => {
		const confirmBtn = document.querySelector('.slaprf-modal-foot .btn-armed');
		if (confirmBtn) confirmBtn.click();
	}`)

	h.WaitUntil("heat running", 10*time.Second, func() (bool, error) {
		res, err := h.Page.Evaluate(`async () => {
			const st = await window.slaprfCurl({ method: "GET", url: "/v1/status" });
			return st.json?.raceState?.heats?.[0]?.state === "running";
		}`)
		if err != nil {
			return false, nil
		}
		ok, _ := res.(bool)
		return ok, nil
	})

	winnerCallsignRaw, err := h.Page.Evaluate(`async () => {
		const st = await window.slaprfCurl({ method: "GET", url: "/v1/status" });
		const raceId = st.json.raceState.raceId;
		const heat = st.json.raceState.heats[0];
		const seated = heat.seats.filter(s => s.pilotSlotIndex > 0);
		const p1 = seated[0];
		const p2 = seated[1];
		const targetLaps = Math.max(1, heat.targetLaps || 3);
		for (let c = 0; c <= targetLaps; c++) {
			await window.slaprfCurl({
				method: "POST",
				url: "/v1/race/sessions/" + encodeURIComponent(raceId) + "/heats/" + encodeURIComponent(heat.id) + "/pilots/" + p1.pilotSlotIndex + ":marshal",
				body: { action: "add_crossing", offsetMs: 700 + c * 12000 },
				syncUi: true
			});
		}
		if (p2) {
			for (let c = 0; c <= targetLaps; c++) {
				await window.slaprfCurl({
					method: "POST",
					url: "/v1/race/sessions/" + encodeURIComponent(raceId) + "/heats/" + encodeURIComponent(heat.id) + "/pilots/" + p2.pilotSlotIndex + ":marshal",
					body: { action: "add_crossing", offsetMs: 900 + c * 13500 },
					syncUi: true
				});
			}
		}
		return p1.callsign;
	}`)
	if err != nil {
		t.Fatalf("marshal crossings: %v", err)
	}
	winnerCallsign, _ := winnerCallsignRaw.(string)

	h.WaitUntil("winner horn played followed by 1st-place winner callout", 5*time.Second, func() (bool, error) {
		res, err := h.Page.Evaluate(`(callsign) => {
			const log = window.__E2E_AUDIO_LOG || [];
			const sawtoothCount = log.filter(e => e.kind === "osc" && e.type === "sawtooth").length;
			const speak1st = log.find(e => e.kind === "speak" && e.text.toLowerCase().includes("finishes 1st") && e.text.toLowerCase().includes(callsign.toLowerCase()));
			return sawtoothCount >= 6 && Boolean(speak1st);
		}`, strings.TrimSpace(winnerCallsign))
		if err != nil {
			return false, nil
		}
		ok, _ := res.(bool)
		return ok, nil
	})
	h.MilestoneScreenshot("winner-horn-and-1st-callout-verified")
}

func TestComponent_AnnouncerControlLapCalloutsToggleRespected(t *testing.T) {
	h := NewHarness(t)
	if err := h.Ctx.AddInitScript(playwright.Script{
		Content: playwright.String(`
			window.__E2E_SPEAK_LOG = [];
			if (window.speechSynthesis) {
				window.speechSynthesis.getVoices = () => [{
					voiceURI: "Google US English",
					name: "Google US English",
					lang: "en-US",
					localService: true,
					default: true
				}];
				window.speechSynthesis.speak = (utt) => {
					window.__E2E_SPEAK_LOG.push(String(utt?.text || ""));
					setTimeout(() => { try { utt?.onstart?.(new Event("start")); } catch {} }, 5);
					setTimeout(() => { try { utt?.onend?.(new Event("end")); } catch {} }, 35);
				};
				window.speechSynthesis.cancel = () => {};
			}
		`),
	}); err != nil {
		t.Fatalf("AddInitScript speechSynthesis hook: %v", err)
	}

	h.SeedSimStateAndStorage("", map[string]string{
		"gate-timer.announcer": `{"enabled":true,"qualifierLapCallouts":true,"raceLapCallouts":false,"keepScreenAwake":true,"voiceURI":"system","rate":1,"volume":1,"testPhrase":""}`,
	})
	h.BootClean("#/races")

	// Enable simulation, create a Qualifying race, navigate to Control, and toggle lap callouts OFF via the cockpit button.
	_, err := h.Page.Evaluate(`async () => {
		await window.slaprfCurl({
			method: "PATCH",
			url: "/v1/sim",
			body: { running: true, speedMultiplier: 8 },
			syncUi: true
		});
		const r1 = await window.slaprfCurl({
			method: "POST",
			url: "/v1/race/sessions",
			body: { name: "Muted Lap Callout Cup" },
			syncUi: true
		});
		const raceId = r1.json.raceState.raceId;
		await window.slaprfCurl({
			method: "POST",
			url: "/v1/race/sessions/" + encodeURIComponent(raceId) + "/pilots:checkInAll",
			body: {},
			syncUi: true
		});
		await window.slaprfCurl({
			method: "POST",
			url: "/v1/race/sessions/" + encodeURIComponent(raceId) + "/bracket:edit",
			body: { action: "apply_template", templateId: "qual_ladder_mains" },
			syncUi: true
		});
		window.location.hash = "#/races/" + raceId + "/control";
	}`)
	if err != nil {
		t.Fatalf("setup race: %v", err)
	}
	h.ConnectSimHubH1()

	toggleBtn := h.Page.Locator(`button[data-toggle-race-lap-callouts]`).First()
	h.MustBeVisible(toggleBtn, "Control lap callouts toggle button")
	// Qualifier defaults ON -> click to toggle OFF!
	if err := toggleBtn.Click(); err != nil {
		t.Fatalf("click lap callouts toggle OFF: %v", err)
	}
	h.WaitUntil("lap callouts toggle button is muted", 3*time.Second, func() (bool, error) {
		pressed, err := toggleBtn.GetAttribute("aria-pressed")
		return err == nil && pressed == "false", nil
	})

	// Clear spoken log before starting heat, then start Q1-1!
	_, _ = h.Page.Evaluate(`() => {
		window.__E2E_SPEAK_LOG = [];
	}`)
	if err := h.Page.Locator(`[data-ctrl="start"]`).First().Click(); err != nil {
		t.Fatalf("click Start Heat: %v", err)
	}
	time.Sleep(150 * time.Millisecond)
	_, _ = h.Page.Evaluate(`() => {
		const confirmBtn = document.querySelector('.slaprf-modal-foot .btn-armed');
		if (confirmBtn) confirmBtn.click();
	}`)

	h.WaitUntil("Q1-1 enters running state", 10*time.Second, func() (bool, error) {
		res, err := h.Page.Evaluate(`async () => {
			const st = await window.slaprfCurl({ method: "GET", url: "/v1/status" });
			return st.json?.raceState?.heats?.[0]?.state === "running";
		}`)
		if err != nil {
			return false, nil
		}
		ok, _ := res.(bool)
		return ok, nil
	})

	// Clear countdown speech, run a simulated pack burst while lap callouts are OFF, and verify laps complete silently!
	_, err = h.Page.Evaluate(`async () => {
		window.__E2E_SPEAK_LOG = [];
		await window.slaprfCurl({ method: "POST", url: "/v1/sim:packBurst", body: {}, syncUi: true });
	}`)
	if err != nil {
		t.Fatalf("pack-burst while muted: %v", err)
	}

	h.WaitUntil("at least 2 simulated laps completed in Q1-1", 5*time.Second, func() (bool, error) {
		res, err := h.Page.Evaluate(`async () => {
			const st = await window.slaprfCurl({ method: "GET", url: "/v1/status" });
			const h0 = st.json?.raceState?.heats?.[0];
			if (!h0) return false;
			const totalLaps = (h0.seats || []).reduce((sum, s) => sum + (s.lapsCompleted || 0), 0);
			return totalLaps >= 2;
		}`)
		if err != nil {
			return false, nil
		}
		ok, _ := res.(bool)
		return ok, nil
	})
	time.Sleep(250 * time.Millisecond)

	// Verify ZERO numeric lap-time callouts (e.g. "<Callsign>, 12.34") were spoken while muted!
	res, err := h.Page.Evaluate(`() => {
		const log = window.__E2E_SPEAK_LOG || [];
		const lapSpoken = log.filter(s => /,\s*\d+(?:\.\d+)?$/.test(s.trim()));
		return { log, lapSpoken };
	}`)
	if err != nil {
		t.Fatalf("read speak log: %v", err)
	}
	resMap, _ := res.(map[string]interface{})
	if lapSpoken, ok := resMap["lapSpoken"].([]interface{}); ok && len(lapSpoken) > 0 {
		t.Fatalf("expected ZERO spoken lap times while lap-callouts toggle is OFF, got %v (full log=%v)", lapSpoken, resMap["log"])
	}

	// Now toggle lap callouts ON and trigger another pack-burst -> MUST announce lap times!
	if err := toggleBtn.Click(); err != nil {
		t.Fatalf("click lap callouts toggle ON: %v", err)
	}
	h.WaitUntil("lap callouts toggle button is active", 3*time.Second, func() (bool, error) {
		pressed, err := toggleBtn.GetAttribute("aria-pressed")
		return err == nil && pressed == "true", nil
	})
	_, err = h.Page.Evaluate(`async () => {
		window.__E2E_SPEAK_LOG = [];
		await window.slaprfCurl({ method: "POST", url: "/v1/sim:packBurst", body: {}, syncUi: true });
	}`)
	if err != nil {
		t.Fatalf("pack-burst while unmuted: %v", err)
	}
	h.WaitUntil("spoken lap time callout emitted when toggled ON", 5*time.Second, func() (bool, error) {
		r2, err := h.Page.Evaluate(`() => {
			const log = window.__E2E_SPEAK_LOG || [];
			return log.some(s => /,\s*\d+(?:\.\d+)?$/.test(s.trim()));
		}`)
		if err != nil {
			return false, nil
		}
		ok, _ := r2.(bool)
		return ok, nil
	})
}
