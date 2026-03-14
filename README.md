# ComfyUI-VKTRFLO-EnvSwitcher

ComfyUI custom node package that mounts a VKTRFLO runtime-control panel inside the active ComfyUI session.

This package is intentionally thin:

- minimal Python registration so ComfyUI loads the extension
- frontend HTML/CSS/JS panel inside ComfyUI
- direct browser calls to the VKTRFLO host service on `38431`
- optional `/system_stats` reads to verify what engine is actually live

It does not register graph execution nodes, and it does not try to become a second runtime-control backend.

## Current Architecture

The VKTRFLO host service owns:

- engine inventory
- selected runtime metadata
- start/stop/switch lifecycle
- runtime error reporting

This extension owns:

- rendering a control panel inside ComfyUI
- calling the host service directly
- surviving refresh/reconnect during engine turnover

That is the correct split.

## Current Status

Implemented:

- panel mount inside ComfyUI
- direct host reads for:
  - `GET /api/v1/startup-state`
  - `GET /api/v1/runtime/status`
- direct host switch action for:
  - `POST /api/v1/runtime/switch-and-start`
- reconnect-aware polling with browser-local persisted switch state
- optional live-engine verification through local `/system_stats`

Not implemented yet:

- standalone `start` action
- standalone `stop` action
- polished settings/override UX for host URL configuration
- final production UX hardening

## Requirements

- ComfyUI
- a running VKTRFLO host service
- at least one installed managed runtime in VKTRFLO

If you want switching to be meaningful, you need at least two installed runtimes for the same profile.

## Host Service Dependency

By default the panel resolves the host service from the current ComfyUI page hostname:

- `http://<current-hostname>:38431`

Examples:

- if ComfyUI is loaded from `http://127.0.0.1:8188`, host default is `http://127.0.0.1:38431`
- if ComfyUI is loaded from `http://10.0.0.164:8188`, host default is `http://10.0.0.164:38431`

You can override that in the browser by setting:

- `window.VKTRFLO_SERVICE_BASE_URL`

or by populating local storage key:

- `vktrflo.env-switcher.service-base-url`

This package is not a generic runtime manager for vanilla ComfyUI. It is a VKTRFLO control surface mounted inside ComfyUI.

## Installation

Place the repo in your ComfyUI `custom_nodes` directory.

### Windows

```powershell
cd C:\path\to\ComfyUI\custom_nodes
git clone https://github.com/vktrflo/ComfyUI-VKTRFLO-EnvSwitcher.git
```

### Linux

```bash
cd /path/to/ComfyUI/custom_nodes
git clone https://github.com/vktrflo/ComfyUI-VKTRFLO-EnvSwitcher.git
```

Then restart ComfyUI.

## What It Registers

Frontend:

- a VKTRFLO env-switcher panel mounted into the ComfyUI UI

Package integration shape:

- `WEB_DIRECTORY = "./web"`
- `NODE_CLASS_MAPPINGS = {}`

That is intentional. This is a frontend/control-plane extension, not a node pack.

## How Switching Works

The switch button is a thin host-service client.

Flow:

1. panel selects a target installed engine
2. panel calls host `POST /api/v1/runtime/switch-and-start`
3. host performs the real stop/select/start lifecycle
4. panel persists in-flight switch state in browser storage
5. panel polls host state until the replacement engine converges
6. panel optionally checks `/system_stats` so it does not report fake success

That means the extension is self-disruptive by design. It is issuing a control-plane command from inside the engine session that may tear down the current engine and bring it back as a different runtime.

## Development

Local project path used during VKTRFLO development:

- `D:\Projects\vktrflo-custom-nodes\ComfyUI-VKTRFLO-EnvSwitcher`

VKTRFLO host development can bundle this extension automatically into managed runtime installs when the sibling workspace layout exists or when `VF_ENV_SWITCHER_CUSTOM_NODE_DIR` is set.

## Limitations

- The panel depends on VKTRFLO host APIs and is not useful without them.
- If the host service is down, the panel will surface direct fetch failures.
- Engine switching is only as good as the host lifecycle behavior.
- Browser caching can keep stale extension assets loaded until a hard refresh.

## Repository Scope

This repository contains the standalone ComfyUI custom node package only.

The VKTRFLO host-side lifecycle APIs and managed runtime orchestration live in the main VKTRFLO repository:

- `https://github.com/vktrflo/vktrflo`
