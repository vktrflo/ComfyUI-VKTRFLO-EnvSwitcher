import { app } from "/scripts/app.js";

const EXTENSION_NAME = "vktrflo.env-switcher";
const HOST_API_PORT = "38431";
const STARTUP_STATE_PATH = "/api/v1/startup-state";
const RUNTIME_STATUS_PATH = "/api/v1/runtime/status";
const SWITCH_AND_START_PATH = "/api/v1/runtime/switch-and-start";
const RUNTIME_START_PATH = "/api/v1/runtime/start";
const RUNTIME_STOP_PATH = "/api/v1/runtime/stop";
const SYSTEM_STATS_URL = "/system_stats";
const PANEL_ID = "vktrflo-env-switcher-panel";
const SWITCH_STATE_STORAGE_KEY = "vktrflo.env-switcher.switch-state";
const POST_SWITCH_RELOAD_STORAGE_KEY = "vktrflo.env-switcher.post-switch-reload";
const PANEL_UI_STATE_STORAGE_KEY = "vktrflo.env-switcher.panel-ui";
const RECONNECT_TIMEOUT_MS = 90000;
const RECONNECT_INTERVAL_MS = 2000;

const state = {
  mode: "bootstrapping",
  serviceBaseUrl: null,
  startupState: null,
  runtimeStatus: null,
  systemStats: null,
  error: null,
  lastUpdatedAt: null,
  selectedVersion: null,
  switchMessage: null,
  switchOperation: null,
  switchTargetVersion: null,
  switchStartedAt: null,
  lastReconnectError: null,
  panelUi: {
    collapsed: false,
    top: 84,
    left: null,
    selectedVersion: null,
  },
};

let panelEl;
let progressRenderTimer = null;
let dragState = null;

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
  return normalizeBaseUrl(window.VKTRFLO_SERVICE_BASE_URL ?? defaultServiceBaseUrl());
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
  return mode === "switch_pending" ? "reconnect_wait" : (mode ?? "reconnect_wait");
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
        switchOperation: state.switchOperation,
        switchTargetVersion: state.switchTargetVersion,
        switchStartedAt: state.switchStartedAt,
        lastReconnectError: state.lastReconnectError,
      }),
    );
  } catch (_error) {
    // Ignore storage failures.
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
    state.switchOperation = persisted.switchOperation ?? "switch";
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
  state.switchOperation = null;
  state.switchTargetVersion = null;
  state.switchStartedAt = null;
  state.lastReconnectError = null;
  persistSwitchState();
  syncProgressRenderTimer();
}

function persistPanelUiState() {
  try {
    state.panelUi.selectedVersion = state.selectedVersion;
    window.localStorage.setItem(PANEL_UI_STATE_STORAGE_KEY, JSON.stringify(state.panelUi));
  } catch (_error) {
    // Ignore storage failures.
  }
}

function restorePanelUiState() {
  try {
    const raw = window.localStorage.getItem(PANEL_UI_STATE_STORAGE_KEY);
    if (!raw) {
      return;
    }
    const persisted = JSON.parse(raw);
    if (typeof persisted?.collapsed === "boolean") {
      state.panelUi.collapsed = persisted.collapsed;
    }
    if (Number.isFinite(persisted?.top)) {
      state.panelUi.top = persisted.top;
    }
    if (persisted?.left == null || Number.isFinite(persisted.left)) {
      state.panelUi.left = persisted.left ?? null;
    }
    if (typeof persisted?.selectedVersion === "string" || persisted?.selectedVersion == null) {
      state.panelUi.selectedVersion = persisted.selectedVersion ?? null;
      state.selectedVersion = persisted.selectedVersion ?? null;
    }
  } catch (_error) {
    window.localStorage.removeItem(PANEL_UI_STATE_STORAGE_KEY);
  }
}

function markPostSwitchReload(targetVersion) {
  try {
    window.sessionStorage.setItem(POST_SWITCH_RELOAD_STORAGE_KEY, JSON.stringify({
      targetVersion,
      at: new Date().toISOString(),
    }));
  } catch (_error) {
    // Ignore storage failures.
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
  } else {
    stopProgressRenderTimer();
  }
}

function selectedProfileDetail() {
  return state.runtimeStatus?.selected_install_profile ?? state.startupState?.runtime_process_install_profile ?? "gpu";
}

function selectedProfileRuntimeDetail() {
  const selectedProfile = selectedProfileDetail();
  return state.runtimeStatus?.profile_details?.find?.((detail) => detail.install_profile === selectedProfile) ?? null;
}

function activeRuntimeDetail() {
  const profileDetail = selectedProfileRuntimeDetail();
  const activeRuntime = profileDetail?.active_runtime ?? null;
  if (!activeRuntime?.version) {
    return null;
  }

  const installedRuntime = Array.isArray(profileDetail?.installed_runtimes)
    ? profileDetail.installed_runtimes.find((runtime) => runtime.version === activeRuntime.version) ?? null
    : null;

  return installedRuntime ? { ...installedRuntime, ...activeRuntime } : activeRuntime;
}

function installedRuntimes() {
  const profileDetail = selectedProfileRuntimeDetail();
  return Array.isArray(profileDetail?.installed_runtimes) ? profileDetail.installed_runtimes : [];
}

function sortedInstalledRuntimes() {
  return [...installedRuntimes()].sort((left, right) => String(right.version ?? "").localeCompare(String(left.version ?? "")));
}

function parsePythonSemver(value) {
  if (!value) {
    return null;
  }
  const match = String(value).match(/\d+\.\d+\.\d+/);
  return match ? match[0] : null;
}

function parsePythonMajorMinor(value) {
  const semver = parsePythonSemver(value);
  return semver ? semver.split(".").slice(0, 2).join(".") : null;
}

function systemStatsPythonVersion() {
  return parsePythonSemver(state.systemStats?.system?.python_version ?? null);
}

function systemStatsPythonMajorMinor() {
  return parsePythonMajorMinor(state.systemStats?.system?.python_version ?? null);
}

function deriveLiveRuntimeVersion() {
  const livePythonMajorMinor = parsePythonMajorMinor(systemStatsPythonVersion());
  if (!livePythonMajorMinor) {
    return null;
  }

  const matches = sortedInstalledRuntimes().filter((runtime) => String(runtime.python_version ?? "").startsWith(livePythonMajorMinor));
  return matches.length === 1 ? matches[0].version ?? null : null;
}

function liveRuntimeDetail() {
  const liveVersion = deriveLiveRuntimeVersion();
  return liveVersion ? (installedRuntimes().find((runtime) => runtime.version === liveVersion) ?? null) : null;
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
  if (state.startupState?.runtime_process_status !== "ready") {
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
    persistPanelUiState();
    return;
  }
  state.selectedVersion = activeVersion() ?? runtimes[0]?.version ?? null;
  persistPanelUiState();
}

function formatTimestamp(value) {
  if (!value) {
    return "Never";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return String(value);
  }
  return parsed.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatElapsedSince(value) {
  if (!value) {
    return "0s";
  }
  const startedAt = new Date(value).getTime();
  if (Number.isNaN(startedAt)) {
    return "0s";
  }
  const elapsedSeconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  if (elapsedSeconds < 60) {
    return `${elapsedSeconds}s`;
  }
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

function toneForStatus(status) {
  switch (status) {
    case "ready":
      return "ready";
    case "loading":
      return "loading";
    case "error":
      return "error";
    default:
      return "idle";
  }
}

function displayStatusLabel() {
  if (state.mode === "switch_pending") {
    return "Switching";
  }
  if (state.mode === "reconnect_wait") {
    return "Restarting";
  }
  if (state.mode === "error") {
    return "Error";
  }

  switch (state.startupState?.runtime_process_status) {
    case "ready":
      return "Ready";
    case "loading":
      return "Restarting";
    case "error":
      return "Error";
    default:
      return "Idle";
  }
}

function currentStatusTone() {
  if (state.mode === "switch_pending" || state.mode === "reconnect_wait") {
    return "loading";
  }
  if (state.mode === "error") {
    return "error";
  }
  return toneForStatus(state.startupState?.runtime_process_status ?? "idle");
}

function friendlyAcceleration(runtime) {
  const cuda = String(runtime?.cuda_version ?? "").trim();
  if (!cuda) {
    return "GPU";
  }
  const match = cuda.match(/^cu(\d{2})(\d)$/i);
  if (!match) {
    return cuda.toUpperCase();
  }
  return `CUDA ${Number(match[1])}.${match[2]}`;
}

function gpuShortLabel() {
  const primaryDeviceName = String(state.systemStats?.devices?.[0]?.name ?? "").trim();
  const match = primaryDeviceName.match(/RTX\s+(\d{3,4})/i) ?? primaryDeviceName.match(/(\d{3,4})(?!.*\d)/);
  if (match) {
    return match[1];
  }
  return "GPU";
}

function currentComfyUiVersion() {
  return (
    state.systemStats?.system?.comfyui_version
    ?? selectedProfileRuntimeDetail()?.comfyui_version
    ?? state.runtimeStatus?.base_domain_comfyui_version
    ?? "Unknown"
  );
}

function currentPythonVersion(runtime) {
  return String(runtime?.python_version ?? "").trim() || systemStatsPythonMajorMinor() || "Unknown";
}

function currentTorchVersion(runtime) {
  return (
    String(runtime?.torch_version ?? "").trim()
    || String(state.systemStats?.system?.pytorch_version ?? "").trim()
    || String(selectedProfileRuntimeDetail()?.torch_version ?? "").trim()
    || "Unknown"
  );
}

function currentEngineHeadline() {
  return `ComfyUI: ${currentComfyUiVersion()} (${gpuShortLabel()})`;
}

function switchOptionLabel(runtime) {
  return `${currentEngineHeadline()} | ${currentPythonVersion(runtime)} | ${currentTorchVersion(runtime)} | Sage Attn: n/a`;
}

function selectedRuntimeDetail() {
  return installedRuntimes().find((runtime) => runtime.version === state.selectedVersion) ?? liveRuntimeDetail() ?? activeRuntimeDetail() ?? null;
}

function collapsedSummaryLabel() {
  return switchOptionLabel(selectedRuntimeDetail() ?? {});
}

function switchButtonLabel() {
  if (state.mode === "reconnect_wait" || (state.mode === "switch_pending" && state.switchOperation === "restart")) {
    return "Restarting";
  }
  if (state.mode === "switch_pending") {
    return "Switching";
  }
  return "Switch";
}

function progressHeadline() {
  if (state.mode === "reconnect_wait" || (state.mode === "switch_pending" && state.switchOperation === "restart")) {
    return "Restarting engine";
  }
  if (state.mode === "switch_pending") {
    return "Switching engine";
  }
  return "Engine switch needs attention";
}

async function fetchJson(url) {
  const response = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error?.message ?? `Request failed for ${url}`);
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
    throw new Error(responsePayload?.error?.message ?? `Request failed for ${url}`);
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
  return { startupState };
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
        resetSwitchState();
        setMode("ready");
        reloadAfterConfirmedSwitch(targetVersion);
        return;
      }

      if (startupState?.runtime_process_status === "error") {
        throw new Error(startupState?.runtime_process_message ?? "Host reported an engine error during reconnect.");
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
        resetSwitchState();
        setMode("ready");
        reloadAfterConfirmedSwitch(targetVersion);
        return;
      }

      if (startupState?.runtime_process_status === "ready" && liveVersion && liveVersion !== targetVersion) {
        state.lastReconnectError = `Live engine is still ${switchOptionLabel(liveRuntimeDetail() ?? {})}.`;
      }
    } catch (error) {
      state.lastReconnectError = error instanceof Error ? error.message : String(error);
    }

    persistSwitchState();
    render();
    await new Promise((resolve) => window.setTimeout(resolve, RECONNECT_INTERVAL_MS));
  }

  throw new Error(`Timed out waiting for ${targetVersion} to become ready.`);
}

async function switchEngine() {
  const version = state.selectedVersion;
  if (!version) {
    return;
  }

  state.error = null;
  state.switchOperation = "switch";
  state.switchTargetVersion = version;
  state.switchStartedAt = new Date().toISOString();
  state.lastReconnectError = null;
  state.switchMessage = `Requesting ${version}.`;
  persistSwitchState();
  setMode("switch_pending");

  try {
    await postJson(serviceUrl(SWITCH_AND_START_PATH), {
      profile: selectedProfileDetail(),
      version,
    });
    state.switchMessage = `Switch accepted. Waiting for ${version}.`;
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

async function restartCurrentEngine() {
  const version = deriveLiveRuntimeVersion() ?? activeVersion() ?? state.selectedVersion;
  if (!version) {
    return;
  }

  state.error = null;
  state.switchOperation = "restart";
  state.switchTargetVersion = version;
  state.switchStartedAt = new Date().toISOString();
  state.lastReconnectError = null;
  state.switchMessage = `Restarting ${version}.`;
  persistSwitchState();
  setMode("switch_pending");

  try {
    await postJson(serviceUrl(RUNTIME_STOP_PATH), {});
    await postJson(serviceUrl(RUNTIME_START_PATH), {});
    state.switchMessage = `Restart accepted. Waiting for ${version}.`;
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
  if (options.className) {
    el.className = options.className;
  }
  if (options.text != null) {
    el.textContent = options.text;
  }
  if (options.html != null) {
    el.innerHTML = options.html;
  }
  if (options.attrs) {
    for (const [key, value] of Object.entries(options.attrs)) {
      if (value != null) {
        el.setAttribute(key, String(value));
      }
    }
  }
  return el;
}

function clampPanelPosition() {
  if (!panelEl) {
    return;
  }

  const margin = 12;
  const width = panelEl.offsetWidth || 360;
  const height = panelEl.offsetHeight || 180;
  const maxLeft = Math.max(margin, window.innerWidth - width - margin);
  const maxTop = Math.max(margin, window.innerHeight - height - margin);

  if (state.panelUi.left == null) {
    state.panelUi.left = maxLeft;
  } else {
    state.panelUi.left = Math.min(Math.max(margin, state.panelUi.left), maxLeft);
  }
  state.panelUi.top = Math.min(Math.max(margin, state.panelUi.top), maxTop);
}

function applyPanelPosition() {
  if (!panelEl) {
    return;
  }
  clampPanelPosition();
  panelEl.style.left = `${state.panelUi.left}px`;
  panelEl.style.top = `${state.panelUi.top}px`;
}

function endDrag() {
  if (!dragState) {
    return;
  }
  dragState = null;
  window.removeEventListener("pointermove", handleDragMove);
  window.removeEventListener("pointerup", endDrag);
  panelEl?.classList.remove("vktrflo-env-switcher--dragging");
  persistPanelUiState();
}

function handleDragMove(event) {
  if (!dragState) {
    return;
  }
  state.panelUi.left = dragState.startLeft + (event.clientX - dragState.pointerStartX);
  state.panelUi.top = dragState.startTop + (event.clientY - dragState.pointerStartY);
  applyPanelPosition();
}

function beginDrag(event) {
  if (event.button !== 0) {
    return;
  }
  dragState = {
    pointerStartX: event.clientX,
    pointerStartY: event.clientY,
    startLeft: state.panelUi.left ?? 0,
    startTop: state.panelUi.top ?? 0,
  };
  panelEl?.classList.add("vktrflo-env-switcher--dragging");
  window.addEventListener("pointermove", handleDragMove);
  window.addEventListener("pointerup", endDrag);
}

function toggleCollapsed() {
  state.panelUi.collapsed = !state.panelUi.collapsed;
  persistPanelUiState();
  render();
}

function ensurePanel() {
  if (panelEl) {
    return;
  }
  ensureStyles();
  panelEl = createElement("aside", {
    className: "vktrflo-env-switcher",
    attrs: { id: PANEL_ID, "aria-live": "polite" },
  });
  document.body.appendChild(panelEl);
}

function renderCollapsedBody(container) {
  const body = createElement("button", {
    className: "vktrflo-env-switcher__collapsed",
    attrs: { type: "button" },
  });
  body.onclick = () => toggleCollapsed();
  body.appendChild(createElement("span", {
    className: "vktrflo-env-switcher__collapsed-engine",
    text: collapsedSummaryLabel(),
  }));
  container.appendChild(body);
}

function renderFact(container, label, value) {
  const row = createElement("div", { className: "vktrflo-env-switcher__fact" });
  row.appendChild(createElement("span", {
    className: "vktrflo-env-switcher__fact-label",
    text: label,
  }));
  row.appendChild(createElement("span", {
    className: "vktrflo-env-switcher__fact-value",
    text: value,
  }));
  container.appendChild(row);
}

function renderExpandedBody(container, runtime) {
  const switchCard = createElement("section", { className: "vktrflo-env-switcher__card" });
  switchCard.appendChild(createElement("label", {
    className: "vktrflo-env-switcher__section-title",
    text: "Switch To",
    attrs: { for: "vktrflo-env-switcher-select" },
  }));

  const controls = createElement("div", { className: "vktrflo-env-switcher__controls" });
  const runtimes = sortedInstalledRuntimes();
  const currentVersion = deriveLiveRuntimeVersion() ?? activeVersion();
  const select = createElement("select", {
    className: "vktrflo-env-switcher__select",
    attrs: { id: "vktrflo-env-switcher-select", "aria-label": "Switch to engine" },
  });
  select.disabled = isSwitchInFlight() || runtimes.length === 0;
  select.onchange = (event) => {
    state.selectedVersion = event.target.value;
    persistPanelUiState();
    render();
  };

  for (const runtimeOption of runtimes) {
    const option = document.createElement("option");
    option.value = runtimeOption.version ?? "";
    option.textContent = `${switchOptionLabel(runtimeOption)}${runtimeOption.version === currentVersion ? " (Current)" : ""}`;
    option.selected = runtimeOption.version === state.selectedVersion;
    select.appendChild(option);
  }

  const switchButton = createElement("button", {
    className: "vktrflo-env-switcher__button vktrflo-env-switcher__button--primary",
    text: switchButtonLabel(),
    attrs: { type: "button" },
  });
  switchButton.disabled = !state.selectedVersion || isSwitchInFlight() || state.selectedVersion === currentVersion;
  switchButton.onclick = () => {
    void switchEngine();
  };

  controls.appendChild(select);
  controls.appendChild(switchButton);
  switchCard.appendChild(controls);
  container.appendChild(switchCard);

  const card = createElement("section", { className: "vktrflo-env-switcher__card" });
  card.appendChild(createElement("div", {
    className: "vktrflo-env-switcher__section-title",
    text: "Current Engine",
  }));

  const facts = createElement("div", { className: "vktrflo-env-switcher__facts" });
  renderFact(facts, "Current Engine", currentEngineHeadline());
  renderFact(facts, "Python", currentPythonVersion(runtime));
  renderFact(facts, "PyTorch", currentTorchVersion(runtime));
  renderFact(facts, "Sage Attn", "n/a");
  renderFact(facts, "Last Started", formatTimestamp(runtime?.last_launched_at));
  card.appendChild(facts);
  container.appendChild(card);

  if (isSwitchInFlight()) {
    const progress = createElement("section", {
      className: "vktrflo-env-switcher__progress",
      attrs: { "data-tone": "loading" },
    });
    progress.appendChild(createElement("div", {
      className: "vktrflo-env-switcher__progress-title",
      text: progressHeadline(),
    }));
    progress.appendChild(createElement("div", {
      className: "vktrflo-env-switcher__progress-meta",
      text: `Elapsed ${formatElapsedSince(state.switchStartedAt)}`,
    }));
    progress.appendChild(createElement("div", {
      className: "vktrflo-env-switcher__progress-bar",
      html: '<span class="vktrflo-env-switcher__progress-fill"></span>',
    }));
    container.appendChild(progress);
  }

  if (state.error) {
    const errorCard = createElement("section", { className: "vktrflo-env-switcher__error-card" });
    errorCard.appendChild(createElement("div", {
      className: "vktrflo-env-switcher__section-title",
      text: "Error",
    }));
    errorCard.appendChild(createElement("p", {
      className: "vktrflo-env-switcher__error-text",
      text: state.error,
    }));
    const actions = createElement("div", { className: "vktrflo-env-switcher__actions" });
    const retryButton = createElement("button", {
      className: "vktrflo-env-switcher__button",
      text: "Retry",
      attrs: { type: "button" },
    });
    retryButton.onclick = () => {
      state.error = null;
      if (state.switchTargetVersion) {
        setMode("reconnect_wait");
        void waitForRuntimeReconnect(state.switchTargetVersion).catch((error) => {
          state.error = error instanceof Error ? error.message : String(error);
          state.lastReconnectError = state.error;
          persistSwitchState();
          setMode("error");
        });
        return;
      }
      void refreshPanel();
    };
    const resetButton = createElement("button", {
      className: "vktrflo-env-switcher__button",
      text: "Reset Panel",
      attrs: { type: "button" },
    });
    resetButton.onclick = () => {
      state.error = null;
      resetSwitchState();
      void refreshPanel();
    };
    actions.appendChild(retryButton);
    actions.appendChild(resetButton);
    errorCard.appendChild(actions);
    container.appendChild(errorCard);
  }
}

function render() {
  ensurePanel();

  const runtime = liveRuntimeDetail() ?? activeRuntimeDetail() ?? { python_version: state.systemStats?.system?.python_version };
  panelEl.className = `vktrflo-env-switcher${state.panelUi.collapsed ? " vktrflo-env-switcher--collapsed" : ""}`;
  panelEl.innerHTML = "";

  const header = createElement("div", { className: "vktrflo-env-switcher__header" });
  header.onpointerdown = (event) => beginDrag(event);

  const titleWrap = createElement("div", { className: "vktrflo-env-switcher__title-wrap" });
  titleWrap.appendChild(createElement("div", {
    className: "vktrflo-env-switcher__eyebrow",
    text: "VKTRFLO",
  }));
  titleWrap.appendChild(createElement("h2", {
    className: "vktrflo-env-switcher__title",
    text: state.panelUi.collapsed ? "Engine" : "Engine Switcher",
  }));
  header.appendChild(titleWrap);

  const headerActions = createElement("div", { className: "vktrflo-env-switcher__header-actions" });
  const restartButton = createElement("button", {
    className: "vktrflo-env-switcher__button vktrflo-env-switcher__button--header",
    text: state.mode === "reconnect_wait" || (state.mode === "switch_pending" && state.switchOperation === "restart") ? "Restarting" : "Restart",
    attrs: { type: "button", "aria-label": "Restart current engine" },
  });
  restartButton.disabled = isSwitchInFlight();
  restartButton.onclick = () => {
    void restartCurrentEngine();
  };
  headerActions.appendChild(restartButton);
  const collapseButton = createElement("button", {
    className: "vktrflo-env-switcher__icon-button",
    html: `<span class="ready-title-caret" aria-hidden="true">${state.panelUi.collapsed ? "▾" : "▴"}</span>`,
    attrs: { type: "button", "aria-label": state.panelUi.collapsed ? "Expand panel" : "Collapse panel" },
  });
  collapseButton.onclick = () => toggleCollapsed();
  headerActions.appendChild(collapseButton);
  header.appendChild(headerActions);
  panelEl.appendChild(header);

  if (state.panelUi.collapsed) {
    renderCollapsedBody(panelEl);
  } else {
    renderExpandedBody(panelEl, runtime);
  }

  applyPanelPosition();
}

function mountWhenReady() {
  consumePostSwitchReloadMarker();
  restorePanelUiState();
  restoreSwitchState();
  syncProgressRenderTimer();
  ensurePanel();
  render();
  window.addEventListener("resize", () => {
    applyPanelPosition();
    persistPanelUiState();
  });
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
