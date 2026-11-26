import { FullUnitReport, runAllRegisteredSuites } from "./harness";

// Register all TypeScript unit test suites
import "./core_format_and_router.test";
import "./connection_graph.test";
import "./store_selectors_analysis_calibration.test";
import "./persistence_and_services.test";
import "./announcer.test";
import "./widgets_and_modals.test";
import "./modals_round_lap_multigp.test";
import "./views_races_and_analytics.test";
import "./flasher_hub_link.test";
import "./poe_bridge_view.test";
import "./editors_sim_network_views.test";
import "./rotorhazard.test";
import "./slaprf_ble.test";
import "./capabilities_and_backend_transport.test";
import "./theme_and_ui_controls.test";

let reported = false;

async function postReport(report: FullUnitReport): Promise<void> {
  if (reported) return;
  reported = true;
  try {
    await fetch("/__tsunit_report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(report),
    });
  } catch {
    // Ignore transport failure during shutdown
  }
}

window.addEventListener("error", (ev) => {
  if (/ResizeObserver loop/i.test(ev.message || "")) return;
  const err = ev.error instanceof Error ? `${ev.error.message}\n${ev.error.stack ?? ""}` : ev.message;
  void postReport({
    totalSuites: 0,
    totalTests: 0,
    passedTests: 0,
    failedTests: 1,
    skippedTests: 0,
    durationMs: 0,
    fatalError: `Uncaught error: ${err}`,
    suites: [],
  });
});

window.addEventListener("unhandledrejection", (ev) => {
  const reason =
    ev.reason instanceof Error
      ? `${ev.reason.message}\n${ev.reason.stack ?? ""}`
      : String(ev.reason);
  void postReport({
    totalSuites: 0,
    totalTests: 0,
    passedTests: 0,
    failedTests: 1,
    skippedTests: 0,
    durationMs: 0,
    fatalError: `Unhandled promise rejection: ${reason}`,
    suites: [],
  });
});

void (async () => {
  try {
    const report = await runAllRegisteredSuites();
    await postReport(report);
  } catch (err) {
    const fatal = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
    await postReport({
      totalSuites: 0,
      totalTests: 0,
      passedTests: 0,
      failedTests: 1,
      skippedTests: 0,
      durationMs: 0,
      fatalError: fatal,
      suites: [],
    });
  }
})();
