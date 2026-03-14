import { app } from "/scripts/app.js";

const EXTENSION_NAME = "vktrflo.env-switcher";
const HOST_API_PORT = "38431";
const STARTUP_STATE_PATH = "/api/v1/startup-state";
const RUNTIME_STATUS_PATH = "/api/v1/runtime/status";
const SWITCH_AND_START_PATH = "/api/v1/runtime/switch-and-start";
const SYSTEM_STATS_URL = "/system_stats";
const PANEL_ID = "vktrflo-env-switcher-panel";
const TOGGLE_ID = "vktrflo-env-switcher-toggle";
const SWITCH_STATE_STORAGE_KEY = "vktrflo.env-switcher.switch-state";
const SERVICE_BASE_URL_STORAGE_KEY = "vktrflo.env-switcher.service-base-url";
const POST_SWITCH_RELOAD_STORAGE_KEY = "vktrflo.env-switcher.post-switch-reload";
const RECONNECT_TIMEOUT_MS = 90000;
const RECONNECT_INTERVAL_MS = 2000;

const state = {
  mode: "bootstrapping",
  visible: true,
  serviceBaseUrl: null,
  startupState: null,
  runtimeStatus: null,
  systemStats: null,
  error: null,
  lastUpdatedAt: null,
  selectedVersion: null,
  switchMessage: null,
  switchTargetVersion: null,
  switchStartedAt: null,
  lastReconnectError: null,
};

let panelEl;
let toggleEl;
let progressRenderTimer = null;

function isSwitchInFlight(mode = state.mode) {
  return mode === "switch_pending" || mode === "reconnect_wait";
}

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

function normalizeBaseUrl(value) {
  const candidate = String(value ?? "").trim().replace(/\/+$/, "");
  if (!candidate) {
    throw new Error("VKTRFLO host service URL is empty.");
  }
  if (!candidate.startsWith("http://") && !candidate.startsWith("https://")) {
    throw new Error("VKTRFLO host service URL must start with http:// or https://.");
  }
  return candidate;
}

function defaultServiceBaseUrl() {
  const protocol = window.location.protocol === "https:" ? "https:" : "http:";
  const hostname = window.location.hostname || "127.0.0.1";
  return `${protocol}//${hostname}:${HOST_API_PORT}`;
}

function resolveServiceBaseUrl() {
  const configured = window.VKTRFLO_SERVICE_BASE_URL
    ?? window.localStorage.getItem(SERVICE_BASE_URL_STORAGE_KEY)
    ?? defaultServiceBaseUrl();
  const normalized = normalizeBaseUrl(configured);
  window.localStorage.setItem(SERVICE_BASE_URL_STORAGE_KEY, normalized);
  return normalized;
}

function serviceUrl(path) {
  if (!state.serviceBaseUrl) {
    state.serviceBaseUrl = resolveServiceBaseUrl();
  }
  return `${state.serviceBaseUrl}${path}`;
}

function setMode(nextMode) {
  state.mode = nextMode;
  syncProgressRenderTimer();
  render();
}

function switchModeForRestore(mode) {
  if (mode === "switch_pending") {
    return "reconnect_wait";
  }
  return mode ?? "reconnect_wait";
}

function persistSwitchState() {
  try {
    if (!state.switchTargetVersion) {
      window.localStorage.removeItem(SWITCH_STATE_STORAGE_KEY);
      return;
    }

    window.localStorage.setItem(
      SWITCH_STATE_STORAGE_KEY,
      JSON.stringify({
        mode: state.mode,
        selectedVersion: state.selectedVersion,
        switchMessage: state.switchMessage,
        switchTargetVersion: state.switchTargetVersion,
        switchStartedAt: state.switchStartedAt,
        lastReconnectError: state.lastReconnectError,
      }),
    );
  } catch (_error) {
    // Storage failures should not break the panel.
  }
}

function restoreSwitchState() {
  try {
    const raw = window.localStorage.getItem(SWITCH_STATE_STORAGE_KEY);
    if (!raw) {
      return;
    }

    const persisted = JSON.parse(raw);
    if (!persisted?.switchTargetVersion) {
      window.localStorage.removeItem(SWITCH_STATE_STORAGE_KEY);
      return;
    }

    state.mode = switchModeForRestore(persisted.mode);
    state.selectedVersion = persisted.selectedVersion ?? null;
    state.switchMessage = persisted.switchMessage ?? `Resuming engine switch to ${persisted.switchTargetVersion}.`;
    state.switchTargetVersion = persisted.switchTargetVersion;
    state.switchStartedAt = persisted.switchStartedAt ?? new Date().toISOString();
    state.lastReconnectError = persisted.lastReconnectError ?? null;
    syncProgressRenderTimer();
  } catch (_error) {
    window.localStorage.removeItem(SWITCH_STATE_STORAGE_KEY);
  }
}

function resetSwitchState() {
  state.switchMessage = null;
  state.switchTargetVersion = null;
  state.switchStartedAt = null;
  state.lastReconnectError = null;
  persistSwitchState();
  syncProgressRenderTimer();
}

function markPostSwitchReload(targetVersion) {
  try {
    window.sessionStorage.setItem(POST_SWITCH_RELOAD_STORAGE_KEY, JSON.stringify({
      targetVersion,
      at: new Date().toISOString(),
    }));
  } catch (_error) {
    // Session storage failures should not break the panel.
  }
}

function consumePostSwitchReloadMarker() {
  try {
    const raw = window.sessionStorage.getItem(POST_SWITCH_RELOAD_STORAGE_KEY);
    if (!raw) {
      return null;
    }

    window.sessionStorage.removeItem(POST_SWITCH_RELOAD_STORAGE_KEY);
    return JSON.parse(raw);
  } catch (_error) {
    window.sessionStorage.removeItem(POST_SWITCH_RELOAD_STORAGE_KEY);
    return null;
  }
}

function reloadAfterConfirmedSwitch(targetVersion) {
  markPostSwitchReload(targetVersion);
  window.location.reload();
}

function stopProgressRenderTimer() {
  if (progressRenderTimer == null) {
    return;
  }

  window.clearInterval(progressRenderTimer);
  progressRenderTimer = null;
}

function startProgressRenderTimer() {
  if (progressRenderTimer != null) {
    return;
  }

  progressRenderTimer = window.setInterval(() => {
    if (!isSwitchInFlight()) {
      stopProgressRenderTimer();
      return;
    }

    render();
  }, 1000);
}

function syncProgressRenderTimer() {
  if (isSwitchInFlight()) {
    startProgressRenderTimer();
    return;
  }

  stopProgressRenderTimer();
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
  const profileDetails = state.runtimeStatus?.profile_details?.find?.((detail) => detail.install_profile === selectedProfile) ?? null;
  const activeRuntime = profileDetails?.active_runtime ?? null;

  if (!activeRuntime?.version) {
    return null;
  }

  const installedRuntime = Array.isArray(profileDetails?.installed_runtimes)
    ? profileDetails.installed_runtimes.find((runtime) => runtime.version === activeRuntime.version) ?? null
    : null;

  return installedRuntime ? { ...installedRuntime, ...activeRuntime } : activeRuntime;
}

function parsePythonSemver(value) {
  if (!value) return null;
  const match = String(value).match(/\d+\.\d+\.\d+/);
  return match ? match[0] : null;
}

function parsePythonMajorMinor(value) {
  const semver = parsePythonSemver(value);
  if (!semver) return null;
  return semver.split(".").slice(0, 2).join(".");
}

function systemStatsPythonVersion() {
  return parsePythonSemver(state.systemStats?.system?.python_version ?? null);
}

function installedRuntimes() {
  const selectedProfile = selectedProfileDetail();
  const profileDetails = state.runtimeStatus?.profile_details?.find?.((detail) => detail.install_profile === selectedProfile) ?? null;
  return Array.isArray(profileDetails?.installed_runtimes) ? profileDetails.installed_runtimes : [];
}

function sortedInstalledRuntimes() {
  return [...installedRuntimes()].sort((left, right) => String(right.version ?? "").localeCompare(String(left.version ?? "")));
}

function deriveLiveRuntimeVersion() {
  const livePythonVersion = systemStatsPythonVersion();
  const livePythonMajorMinor = parsePythonMajorMinor(livePythonVersion);
  if (!livePythonMajorMinor) {
    return null;
  }

  const matches = sortedInstalledRuntimes().filter((runtime) => String(runtime.python_version ?? "").startsWith(livePythonMajorMinor));
  if (matches.length === 1) {
    return matches[0].version ?? null;
  }

  return null;
}

function liveRuntimeDetail() {
  const liveVersion = deriveLiveRuntimeVersion();
  if (!liveVersion) {
    return null;
  }
  return installedRuntimes().find((runtime) => runtime.version === liveVersion) ?? null;
}

function activeVersion() {
  return activeRuntimeDetail()?.version ?? null;
}

function parseTimestamp(value) {
  if (!value) {
    return null;
  }

  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

function hostReportsTargetReady(targetVersion) {
  const runtimeStatus = state.startupState?.runtime_process_status;
  if (runtimeStatus !== "ready") {
    return false;
  }

  const activeRuntime = activeRuntimeDetail();
  if (!activeRuntime?.version || activeRuntime.version !== targetVersion) {
    return false;
  }

  const switchStartedAt = parseTimestamp(state.switchStartedAt);
  const lastLaunchedAt = parseTimestamp(activeRuntime.last_launched_at);

  if (!switchStartedAt || !lastLaunchedAt) {
    return true;
  }

  return lastLaunchedAt >= switchStartedAt;
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

function formatElapsedSince(value) {
  if (!value) return "0s";
  const startedAt = new Date(value).getTime();
  if (Number.isNaN(startedAt)) return "0s";
  const elapsedSeconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  if (elapsedSeconds < 60) return `${elapsedSeconds}s`;
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

function humanModeLabel(mode) {
  switch (mode) {
    case "bootstrapping":
      return "Bootstrapping";
    case "loading":
      return "Loading";
    case "switch_pending":
      return "Switch Pending";
    case "reconnect_wait":
      return "Reconnect Wait";
    case "error":
      return "Error";
    default:
      return "Ready";
  }
}

function refreshButtonLabel() {
  if (state.mode === "loading" || state.mode === "bootstrapping") {
    return "Refreshing...";
  }
  if (state.mode === "reconnect_wait") {
    return "Polling...";
  }
  return "Refresh";
}

function switchButtonLabel() {
  if (state.mode === "switch_pending") {
    return "Switching...";
  }
  if (state.mode === "reconnect_wait") {
    return "Reconnecting...";
  }
  return "Switch Engine";
}

function switchDetailText(runtimes, currentActiveVersion) {
  if (runtimes.length < 2) {
    return "Install another managed runtime to test live engine switching from inside ComfyUI.";
  }
  if (state.selectedVersion === currentActiveVersion) {
    return "Choose a different installed runtime version to switch engines.";
  }
  return "Switches are executed by the VKTRFLO host service. This panel only mirrors that control plane.";
}

function progressTitle() {
  const targetVersion = state.switchTargetVersion ?? "target engine";
  if (state.mode === "switch_pending") {
    return `Starting ${targetVersion}`;
  }
  if (state.mode === "reconnect_wait") {
    return `Waiting for ${targetVersion}`;
  }
  return `Switch to ${targetVersion} failed`;
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

async function hydrateRuntimeState() {
  const [startupState, runtimeStatus, systemStats] = await Promise.all([
    fetchJson(serviceUrl(STARTUP_STATE_PATH)),
    fetchJson(serviceUrl(RUNTIME_STATUS_PATH)),
    fetchJson(SYSTEM_STATS_URL).catch(() => null),
  ]);

  state.startupState = startupState;
  state.runtimeStatus = runtimeStatus;
  state.systemStats = systemStats;
  state.lastUpdatedAt = new Date().toISOString();
  synchronizeSelectedVersion();

  return { startupState, runtimeStatus, systemStats };
}

async function refreshPanel() {
  state.error = null;
  if (!isSwitchInFlight()) {
    setMode(state.startupState || state.runtimeStatus ? "loading" : "bootstrapping");
  }

  try {
    state.serviceBaseUrl = resolveServiceBaseUrl();
    const { startupState } = await hydrateRuntimeState();

    if (state.switchTargetVersion) {
      const liveVersion = deriveLiveRuntimeVersion();
      if (
        (startupState?.runtime_process_status === "ready" && liveVersion === state.switchTargetVersion)
        || hostReportsTargetReady(state.switchTargetVersion)
      ) {
        const targetVersion = state.switchTargetVersion;
        state.switchMessage = `Engine ${targetVersion} is ready.`;
        resetSwitchState();
        setMode("ready");
        reloadAfterConfirmedSwitch(targetVersion);
        return;
      }

      if (startupState?.runtime_process_status === "error") {
        const hostMessage = startupState?.runtime_process_message ?? "Host reported an engine error during reconnect.";
        state.error = hostMessage;
        state.lastReconnectError = hostMessage;
        setMode("error");
        return;
      }

      persistSwitchState();
      setMode(state.mode === "switch_pending" ? "switch_pending" : "reconnect_wait");
      return;
    }

    setMode("ready");
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    if (state.switchTargetVersion) {
      state.lastReconnectError = state.error;
      persistSwitchState();
    }
    setMode("error");
  }
}

async function waitForRuntimeReconnect(targetVersion) {
  const existingStartedAt = state.switchStartedAt ? new Date(state.switchStartedAt).getTime() : Date.now();
  const startedAt = Number.isNaN(existingStartedAt) ? Date.now() : existingStartedAt;

  if (!state.switchStartedAt || Number.isNaN(existingStartedAt)) {
    state.switchStartedAt = new Date().toISOString();
  }
  state.lastReconnectError = null;
  persistSwitchState();

  while (Date.now() - startedAt < RECONNECT_TIMEOUT_MS) {
    try {
      const { startupState } = await hydrateRuntimeState();
      const liveVersion = deriveLiveRuntimeVersion();

      if (startupState?.runtime_process_status === "error") {
        throw new Error(startupState?.runtime_process_message ?? `Engine ${targetVersion} entered an error state during reconnect.`);
      }

      if (
        (startupState?.runtime_process_status === "ready" && liveVersion === targetVersion)
        || hostReportsTargetReady(targetVersion)
      ) {
        state.switchMessage = `Engine ${targetVersion} is ready.`;
        resetSwitchState();
        setMode("ready");
        reloadAfterConfirmedSwitch(targetVersion);
        return;
      }

      if (startupState?.runtime_process_status === "ready" && liveVersion && liveVersion !== targetVersion) {
        state.lastReconnectError = `Live engine is still ${liveVersion}. Waiting for ${targetVersion}.`;
      }
    } catch (error) {
      state.lastReconnectError = error instanceof Error ? error.message : String(error);
    }

    persistSwitchState();
    render();
    await new Promise((resolve) => window.setTimeout(resolve, RECONNECT_INTERVAL_MS));
  }

  throw new Error(`Timed out waiting for engine ${targetVersion} to become ready.`);
}

async function switchEngine() {
  const version = state.selectedVersion;
  const profile = selectedProfileDetail();

  if (!version) {
    return;
  }

  state.error = null;
  state.switchMessage = `Requesting engine switch to ${version}.`;
  state.switchTargetVersion = version;
  state.switchStartedAt = new Date().toISOString();
  state.lastReconnectError = null;
  persistSwitchState();
  setMode("switch_pending");

  try {
    await postJson(serviceUrl(SWITCH_AND_START_PATH), { profile, version });
    state.switchMessage = `Switch accepted. Waiting for ${version} to reconnect.`;
    persistSwitchState();
    setMode("reconnect_wait");
    await waitForRuntimeReconnect(version);
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
    state.lastReconnectError = state.error;
    persistSwitchState();
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

  const currentLiveVersion = deriveLiveRuntimeVersion();
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
    row.dataset.active = String(runtime.version === currentLiveVersion);
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
  const currentActiveVersion = deriveLiveRuntimeVersion() ?? activeVersion();
  const selectDisabled = runtimes.length === 0 || isSwitchInFlight();
  const switchDisabled = !state.selectedVersion
    || runtimes.length === 0
    || selectDisabled
    || state.selectedVersion === currentActiveVersion;

  const section = createElement("section", { className: "vktrflo-env-switcher__grid" });
  section.appendChild(createElement("div", {
    className: "vktrflo-env-switcher__section-title",
    text: "Engine Switch",
  }));

  const controls = createElement("div", { className: "vktrflo-env-switcher__controls" });
  const select = createElement("select", {
    className: "vktrflo-env-switcher__select",
    attrs: { "aria-label": "Select installed engine version" },
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
    text: switchButtonLabel(),
    attrs: { type: "button" },
  });
  switchButton.disabled = switchDisabled;
  switchButton.onclick = () => {
    void switchEngine();
  };

  controls.appendChild(select);
  controls.appendChild(switchButton);
  section.appendChild(controls);

  section.appendChild(createElement("p", {
    className: "vktrflo-env-switcher__detail",
    text: switchDetailText(runtimes, currentActiveVersion),
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

  if (isSwitchInFlight() || (state.mode === "error" && state.switchTargetVersion)) {
    const progress = createElement("div", {
      className: "vktrflo-env-switcher__progress",
      attrs: { "data-tone": state.mode === "error" ? "error" : "loading" },
    });

    progress.appendChild(createElement("div", {
      className: "vktrflo-env-switcher__progress-title",
      text: progressTitle(),
    }));

    const progressMeta = createElement("div", { className: "vktrflo-env-switcher__progress-meta" });
    progressMeta.appendChild(createElement("span", {
      text: `Elapsed ${formatElapsedSince(state.switchStartedAt)}`,
    }));
    progress.appendChild(progressMeta);

    if (state.mode !== "error") {
      progress.appendChild(createElement("div", {
        className: "vktrflo-env-switcher__progress-bar",
        html: '<span class="vktrflo-env-switcher__progress-fill"></span>',
      }));
    }

    if (state.lastReconnectError && state.mode !== "ready") {
      progress.appendChild(createElement("p", {
        className: "vktrflo-env-switcher__detail",
        text: `Last reconnect signal: ${state.lastReconnectError}`,
      }));
    }

    if (state.switchTargetVersion) {
      const progressActions = createElement("div", { className: "vktrflo-env-switcher__error-actions" });
      const resetButton = createElement("button", {
        className: "vktrflo-env-switcher__button",
        text: "Reset Panel State",
        attrs: { type: "button" },
      });
      resetButton.onclick = () => {
        state.error = null;
        resetSwitchState();
        void refreshPanel();
      };
      progressActions.appendChild(resetButton);
      progress.appendChild(progressActions);
    }

    section.appendChild(progress);
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
  const liveRuntime = liveRuntimeDetail();
  const liveVersion = liveRuntime?.version ?? deriveLiveRuntimeVersion() ?? "Unknown";
  const livePythonVersion = systemStatsPythonVersion() ?? "Unknown";

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
    text: "Thin ComfyUI wrapper around the VKTRFLO host service. The host owns engine lifecycle; this panel only drives it.",
  }));
  header.appendChild(headerCopy);

  const refreshButton = createElement("button", {
    className: "vktrflo-env-switcher__button",
    text: refreshButtonLabel(),
    attrs: { type: "button" },
  });
  refreshButton.disabled = state.mode === "loading" || state.mode === "bootstrapping" || state.mode === "switch_pending";
  refreshButton.onclick = () => {
    void refreshPanel();
  };
  header.appendChild(refreshButton);
  panelEl.appendChild(header);

  const service = createElement("div", { className: "vktrflo-env-switcher__service" });
  service.appendChild(createElement("div", {
    className: "vktrflo-env-switcher__detail",
    text: state.error ? "VKTRFLO host unavailable" : `Host service: ${state.serviceBaseUrl ?? defaultServiceBaseUrl()}`,
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
    if (state.switchTargetVersion) {
      const retryWrap = createElement("div", { className: "vktrflo-env-switcher__error-actions" });
      const retryButton = createElement("button", {
        className: "vktrflo-env-switcher__button",
        text: "Retry Poll",
        attrs: { type: "button" },
      });
      retryButton.onclick = () => {
        state.error = null;
        setMode("reconnect_wait");
        void waitForRuntimeReconnect(state.switchTargetVersion);
      };
      const clearButton = createElement("button", {
        className: "vktrflo-env-switcher__button",
        text: "Dismiss Switch State",
        attrs: { type: "button" },
      });
      clearButton.onclick = () => {
        state.error = null;
        resetSwitchState();
        void refreshPanel();
      };
      retryWrap.appendChild(retryButton);
      retryWrap.appendChild(clearButton);
      panelEl.appendChild(retryWrap);
    }
  } else {
    const active = createElement("section", { className: "vktrflo-env-switcher__active" });
    const facts = createElement("div", { className: "vktrflo-env-switcher__facts" });
    facts.appendChild(createElement("div", {
      className: "vktrflo-env-switcher__section-title",
      text: "Active Engine",
    }));

    const factRows = [
      ["Profile", String(selectedProfileDetail()).toUpperCase()],
      ["Live Engine Version", liveVersion],
      ["Selected Version", activeRuntime?.version ?? "Unknown"],
      ["Live Python", livePythonVersion],
      ["Process State", runtimeStatus],
      ["Message", state.startupState?.runtime_process_message ?? "No message"],
      ["Last Launched", formatTimestamp(liveRuntime?.last_launched_at ?? activeRuntime?.last_launched_at)],
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
    text: humanModeLabel(state.mode),
  }));
  panelEl.appendChild(footer);
}

function mountWhenReady() {
  consumePostSwitchReloadMarker();
  restoreSwitchState();
  syncProgressRenderTimer();
  ensurePanel();
  ensureToggle();
  render();
  void refreshPanel();
  if (state.switchTargetVersion) {
    void waitForRuntimeReconnect(state.switchTargetVersion).catch((error) => {
      state.error = error instanceof Error ? error.message : String(error);
      state.lastReconnectError = state.error;
      persistSwitchState();
      setMode("error");
    });
  }
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
