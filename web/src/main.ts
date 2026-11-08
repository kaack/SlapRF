import { installCustomSelects } from "./core/custom_select";
import { Router } from "./core/router";
import { installTableScrollIndicators } from "./core/table_scroll";
import { AppShell } from "./layout/AppShell";
import { Announcer } from "./services/announcer";
import { ApiClient } from "./services/api_client";
import { AppStore } from "./state/store";

async function bootstrap(): Promise<void> {
  const root = document.getElementById("app");
  if (!root) throw new Error("Missing #app root element");

  installCustomSelects();
  installTableScrollIndicators();

  const store = new AppStore();
  const api = new ApiClient(store);
  const router = new Router();
  // Lives for the whole app so lap calls happen whichever view is open.
  const announcer = new Announcer(store);

  new AppShell(root, store, api, router, announcer);
  await api.initialize();
}

document.addEventListener("DOMContentLoaded", () => {
  bootstrap().catch((err) => console.error("Gate Timer failed to start:", err));
});
