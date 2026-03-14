import { app } from "/scripts/app.js";

const EXTENSION_NAME = "vktrflo.env-switcher";
const CONFIG_URL = "/vktrflo/env-switcher/config";
const STARTUP_STATE_URL = "/vktrflo/env-switcher/runtime/startup-state";
const RUNTIME_STATUS_URL = "/vktrflo/env-switcher/runtime/status";
const SWITCH_AND_START_URL = "/vktrflo/env-switcher/runtime/switch-and-start";
const PANEL_ID = "vktrflo-env-switcher-panel";
const TOGGLE_ID = "vktrflo-env-switcher-toggle";
const RECONNECT_TIMEOUT_MS = 90000;
const RECONNECT_INTERVAL_MS = 2000;

const state = {
  mode: "bootstrapping",
  visible: true,
  config: null,
  startupState: null,
  runtimeStatus: null,
  error: null,
  lastUpdatedAt: null,
  selectedVersion: null,
  switchMessage: null,
  switchTargetVersion: null,
};

let panelEl;
let toggleEl;

function ensureStyles() {
  if (document.querySelector('link[data-vktrflo-env-switcher-style="true"]')) {
    return;
  }

  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = new URL("./index.css", import.meta.url).href;
  link.dataset.vktrfloEnvSwitcherStyle = "true";
  document.head.appendChild(link);
}

function setMode(nextMode) {
  state.mode = nextMode;
  render();
}

function toneForRuntimeStatus(status) {
  switch (status) {
    case "ready":
      return "ready";
    case "loading":
      return "loading";
    case "error":
      return "error";
    case "missing":
      return "missing";
    default:
      return "idle";
  }
}

function labelForRuntimeStatus(status) {
  switch (status) {
    case "ready":
      return "Engine Ready";
    case "loading":
      return "Engine Loading";
    case "error":
      return "Engine Error";
    case "missing":
      return "Engine Missing";
    default:
      return "Engine Idle";
  }
}

function selectedProfileDetail() {
  return state.runtimeStatus?.selected_install_profile ?? state.startupState?.runtime_process_install_profile ?? "unknown";
}

function activeRuntimeDetail() {
  const selectedProfile = selectedProfileDetail();
  const profileDetails = state.runtimeStatus?.profile_details?.find?.((detail) => detail.install_profile === selectedProfile)
    ?? null;
  const activeRuntime = profileDetails?.active_runtime ?? null;

  if (!activeRuntime?.version) {
    return null;
  }

  const installedRuntime = Array.isArray(profileDetails?.installed_runtimes)
    ? profileDetails.installed_runtimes.find((runtime) => runtime.version === activeRuntime.version) ?? null
    : null;

  return installedRuntime
    ? { ...installedRuntime, ...activeRuntime }
    : activeRuntime;
}

function installedRuntimes() {
  const selectedProfile = selectedProfileDetail();
  const profileDetails = state.runtimeStatus?.profile_details?.find?.((detail) => detail.install_profile === selectedProfile)
    ?? null;
  return Array.isArray(profileDetails?.installed_runtimes) ? profileDetails.installed_runtimes : [];
}

function activeVersion() {
  return activeRuntimeDetail()?.version ?? null;
}

function sortedInstalledRuntimes() {
  return [...installedRuntimes()].sort((left, right) => String(right.version ?? "").localeCompare(String(left.version ?? "")));
}

function synchronizeSelectedVersion() {
  const runtimes = sortedInstalledRuntimes();
  const versions = new Set(runtimes.map((runtime) => runtime.version).filter(Boolean));
  if (state.selectedVersion && versions.has(state.selectedVersion)) {
    return;
  }

  state.selectedVersion = activeVersion() ?? runtimes[0]?.version ?? null;
}

function formatTimestamp(value) {
  if (!value) return "Never";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleString();
}

async function fetchJson(url) {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
    },
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload?.error?.message ?? `Request failed for ${url}`;
    throw new Error(message);
  }
  return payload;
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const responsePayload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = responsePayload?.error?.message ?? `Request failed for ${url}`;
    throw new Error(message);
  }
  return responsePayload;
}

async function refreshPanel() {
  state.error = null;
  if (state.mode !== "switch_pending" && state.mode !== "reconnect_wait") {
    setMode(state.startupState || state.runtimeStatus ? "loading" : "bootstrapping");
  }

  try {
    const [config, startupState, runtimeStatus] = await Promise.all([
      fetchJson(CONFIG_URL),
      fetchJson(STARTUP_STATE_URL),
      fetchJson(RUNTIME_STATUS_URL),
    ]);

    state.config = config;
    state.startupState = startupState;
    state.runtimeStatus = runtimeStatus;
    state.lastUpdatedAt = new Date().toISOString();
    synchronizeSelectedVersion();
    setMode("ready");
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    setMode("error");
  }
}

async function waitForRuntimeReconnect(targetVersion) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < RECONNECT_TIMEOUT_MS) {
    try {
      const [startupState, runtimeStatus] = await Promise.all([
        fetchJson(STARTUP_STATE_URL),
        fetchJson(RUNTIME_STATUS_URL),
      ]);

      state.startupState = startupState;
      state.runtimeStatus = runtimeStatus;
      state.lastUpdatedAt = new Date().toISOString();
      synchronizeSelectedVersion();

      if (
        startupState?.runtime_process_status === "ready"
        && activeVersion() === targetVersion
      ) {
        state.switchMessage = `Engine ${targetVersion} is ready.`;
        state.switchTargetVersion = null;
        setMode("ready");
        return;
      }
    } catch {
      // Expected while the current engine is tearing itself down and coming back.
    }

    await new Promise((resolve) => window.setTimeout(resolve, RECONNECT_INTERVAL_MS));
  }

  throw new Error(`Timed out waiting for engine ${targetVersion} to become ready.`);
}

async function switchEngine() {
  const version = state.selectedVersion;
  const profile = selectedProfileDetail();

  if (!version || !state.config?.capabilities?.switch_engine) {
    return;
  }

  state.error = null;
  state.switchMessage = `Requesting engine switch to ${version}.`;
  state.switchTargetVersion = version;
  setMode("switch_pending");

  try {
    await postJson(SWITCH_AND_START_URL, { profile, version });
    state.switchMessage = `Switch accepted. Waiting for ${version} to reconnect.`;
    setMode("reconnect_wait");
    await waitForRuntimeReconnect(version);
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    state.switchMessage = null;
    state.switchTargetVersion = null;
    setMode("error");
  }
}

function createElement(tag, options = {}) {
  const el = document.createElement(tag);
  if (options.className) el.className = options.className;
  if (options.text) el.textContent = options.text;
  if (options.html) el.innerHTML = options.html;
  if (options.attrs) {
    for (const [key, value] of Object.entries(options.attrs)) {
      if (value != null) {
        el.setAttribute(key, String(value));
      }
    }
  }
  return el;
}

function ensurePanel() {
  if (panelEl) return;

  ensureStyles();

  panelEl = createElement("aside", {
    className: "vktrflo-env-switcher",
    attrs: { id: PANEL_ID, "aria-live": "polite" },
  });
  document.body.appendChild(panelEl);
}

function ensureToggle() {
  if (toggleEl) return;

  toggleEl = createElement("button", {
    className: "vktrflo-env-switcher__toggle",
    text: "VKTRFLO",
    attrs: { id: TOGGLE_ID, type: "button" },
  });
  toggleEl.onclick = () => {
    state.visible = !state.visible;
    render();
  };

  const comfyMenu = document.querySelector(".comfy-menu");
  if (comfyMenu) {
    comfyMenu.appendChild(toggleEl);
  } else {
    Object.assign(toggleEl.style, {
      position: "fixed",
      top: "1rem",
      right: "1rem",
      zIndex: "91",
    });
    document.body.appendChild(toggleEl);
  }
}

function renderInstalledRuntimes(container) {
  const runtimes = sortedInstalledRuntimes();

  const section = createElement("section", { className: "vktrflo-env-switcher__grid" });
  section.appendChild(createElement("div", {
    className: "vktrflo-env-switcher__section-title",
    text: "Installed Engines",
  }));

  if (runtimes.length === 0) {
    section.appendChild(createElement("p", {
      className: "vktrflo-env-switcher__empty",
      text: "No installed managed runtimes were reported for the selected profile.",
    }));
    container.appendChild(section);
    return;
  }

  const currentActiveVersion = activeVersion();
  const wrap = createElement("div", { className: "vktrflo-env-switcher__table-wrap" });
  const table = createElement("table", { className: "vktrflo-env-switcher__table" });
  table.innerHTML = `
    <thead>
      <tr>
        <th>Version</th>
        <th>Status</th>
        <th>Python</th>
        <th>CUDA</th>
        <th>PyTorch</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;
  const tbody = table.querySelector("tbody");

  for (const runtime of runtimes) {
    const row = document.createElement("tr");
    row.dataset.active = String(runtime.version === currentActiveVersion);
    row.innerHTML = `
      <td>${runtime.version ?? "Unknown"}</td>
      <td>${runtime.status ?? "Unknown"}</td>
      <td>${runtime.python_version ?? "Unknown"}</td>
      <td>${runtime.cuda_version ?? "n/a"}</td>
      <td>${runtime.torch_version ?? "Unknown"}</td>
    `;
    tbody.appendChild(row);
  }

  wrap.appendChild(table);
  section.appendChild(wrap);
  container.appendChild(section);
}

function renderSwitchControls(container) {
  const runtimes = sortedInstalledRuntimes();
  const currentActiveVersion = activeVersion();
  const canSwitch = Boolean(state.config?.capabilities?.switch_engine);
  const selectDisabled = runtimes.length === 0 || state.mode === "switch_pending" || state.mode === "reconnect_wait";
  const switchDisabled = (
    !canSwitch
    || !state.selectedVersion
    || runtimes.length === 0
    || selectDisabled
    || state.selectedVersion === currentActiveVersion
  );

  const section = createElement("section", { className: "vktrflo-env-switcher__grid" });
  section.appendChild(createElement("div", {
    className: "vktrflo-env-switcher__section-title",
    text: "Engine Switch",
  }));

  const controls = createElement("div", { className: "vktrflo-env-switcher__controls" });
  const select = createElement("select", {
    className: "vktrflo-env-switcher__select",
    attrs: {
      "aria-label": "Select installed engine version",
    },
  });
  select.disabled = selectDisabled;
  select.onchange = (event) => {
    state.selectedVersion = event.target.value;
    state.switchMessage = null;
    render();
  };

  for (const runtime of runtimes) {
    const option = document.createElement("option");
    option.value = runtime.version ?? "";
    option.textContent = `${runtime.version ?? "Unknown"}${runtime.version === currentActiveVersion ? " (current)" : ""}`;
    option.selected = runtime.version === state.selectedVersion;
    select.appendChild(option);
  }

  const switchButton = createElement("button", {
    className: "vktrflo-env-switcher__button vktrflo-env-switcher__button--primary",
    text: state.mode === "switch_pending"
      ? "Switching..."
      : state.mode === "reconnect_wait"
        ? "Reconnecting..."
        : "Switch Engine",
    attrs: { type: "button" },
  });
  switchButton.disabled = switchDisabled;
  switchButton.onclick = () => {
    void switchEngine();
  };

  controls.appendChild(select);
  controls.appendChild(switchButton);
  section.appendChild(controls);

  const detailText = !canSwitch
    ? "Engine switching is not enabled by the current VKTRFLO host."
    : runtimes.length < 2
      ? "Install another managed runtime to test live engine switching from inside ComfyUI."
      : state.selectedVersion === currentActiveVersion
        ? "Choose a different installed runtime version to switch engines."
        : "Switches are host-mediated and intentionally wait for the replacement engine to come back healthy.";

  section.appendChild(createElement("p", {
    className: "vktrflo-env-switcher__detail",
    text: detailText,
  }));

  if (state.switchMessage) {
    section.appendChild(createElement("p", {
      className: "vktrflo-env-switcher__notice",
      text: state.switchMessage,
      attrs: {
        "data-tone": state.mode === "error" ? "error" : state.mode === "ready" ? "ready" : "loading",
      },
    }));
  }

  container.appendChild(section);
}

function render() {
  ensurePanel();
  ensureToggle();

  panelEl.hidden = !state.visible;
  toggleEl.textContent = state.visible ? "Hide VKTRFLO" : "Show VKTRFLO";

  const runtimeStatus = state.startupState?.runtime_process_status ?? "idle";
  const tone = toneForRuntimeStatus(runtimeStatus);
  const activeRuntime = activeRuntimeDetail();

  panelEl.innerHTML = "";

  const header = createElement("div", { className: "vktrflo-env-switcher__header" });
  const headerCopy = createElement("div");
  headerCopy.appendChild(createElement("div", {
    className: "vktrflo-env-switcher__eyebrow",
    text: "VKTRFLO Env Switcher",
  }));
  headerCopy.appendChild(createElement("h2", {
    className: "vktrflo-env-switcher__title",
    text: "Managed Runtime Panel",
  }));
  headerCopy.appendChild(createElement("p", {
    className: "vktrflo-env-switcher__subcopy",
    text: "Managed runtime visibility plus guarded engine switching inside ComfyUI. Stop and delete actions remain intentionally disabled here.",
  }));
  header.appendChild(headerCopy);

  const refreshButton = createElement("button", {
    className: "vktrflo-env-switcher__button",
    text: state.mode === "loading" || state.mode === "bootstrapping" ? "Refreshing..." : "Refresh",
    attrs: { type: "button" },
  });
  refreshButton.disabled = state.mode === "loading" || state.mode === "bootstrapping";
  refreshButton.onclick = () => {
    void refreshPanel();
  };
  header.appendChild(refreshButton);
  panelEl.appendChild(header);

  const service = createElement("div", { className: "vktrflo-env-switcher__service" });
  service.appendChild(createElement("div", {
    className: "vktrflo-env-switcher__detail",
    text: state.error ? "VKTRFLO host unavailable" : `Host service: ${state.config?.service_base_url ?? "loading..."}`,
  }));
  const badge = createElement("div", {
    className: "vktrflo-env-switcher__badge",
    text: state.error ? "Panel Error" : labelForRuntimeStatus(runtimeStatus),
    attrs: { "data-tone": state.error ? "error" : tone },
  });
  service.appendChild(badge);
  panelEl.appendChild(service);

  if (state.error) {
    panelEl.appendChild(createElement("p", {
      className: "vktrflo-env-switcher__error",
      text: state.error,
    }));
  } else {
    const active = createElement("section", { className: "vktrflo-env-switcher__active" });
    const facts = createElement("div", { className: "vktrflo-env-switcher__facts" });
    facts.appendChild(createElement("div", { className: "vktrflo-env-switcher__section-title", text: "Active Engine" }));

    const factRows = [
      ["Profile", String(selectedProfileDetail()).toUpperCase()],
      ["Active Version", activeRuntime?.version ?? "Unknown"],
      ["Process State", runtimeStatus],
      ["Message", state.startupState?.runtime_process_message ?? "No message"],
      ["Last Launched", formatTimestamp(activeRuntime?.last_launched_at)],
    ];

    for (const [label, value] of factRows) {
      const row = createElement("div", { className: "vktrflo-env-switcher__fact" });
      row.appendChild(createElement("span", {
        className: "vktrflo-env-switcher__fact-label",
        text: label,
      }));
      row.appendChild(createElement("span", {
        className: "vktrflo-env-switcher__fact-value",
        text: value,
      }));
      facts.appendChild(row);
    }

    active.appendChild(facts);
    panelEl.appendChild(active);
    renderSwitchControls(panelEl);
    renderInstalledRuntimes(panelEl);
  }

  const footer = createElement("div", { className: "vktrflo-env-switcher__footer" });
  footer.appendChild(createElement("span", {
    text: state.lastUpdatedAt ? `Last updated ${formatTimestamp(state.lastUpdatedAt)}` : "Waiting for first hydrate",
  }));
  footer.appendChild(createElement("span", {
    text:
      state.mode === "bootstrapping" ? "Bootstrapping"
      : state.mode === "loading" ? "Loading"
      : state.mode === "switch_pending" ? "Switch Pending"
      : state.mode === "reconnect_wait" ? "Reconnect Wait"
      : state.mode === "error" ? "Error"
      : "Ready",
  }));
  panelEl.appendChild(footer);
}

function mountWhenReady() {
  ensurePanel();
  ensureToggle();
  render();
  void refreshPanel();
}

app.registerExtension({
  name: EXTENSION_NAME,
  async setup() {
    if (document.readyState === "loading") {
      window.addEventListener("DOMContentLoaded", mountWhenReady, { once: true });
    } else {
      mountWhenReady();
    }
  },
});
