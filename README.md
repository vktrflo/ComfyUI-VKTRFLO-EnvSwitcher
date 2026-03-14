# ComfyUI-VKTRFLO-EnvSwitcher

ComfyUI custom node package that exposes VKTRFLO managed-runtime status and engine switching controls from inside the active ComfyUI session.

This is a UI-first control-plane extension:

- it registers same-origin ComfyUI routes
- it mounts a VKTRFLO panel inside the ComfyUI frontend
- it talks to a running VKTRFLO host service
- it does not register execution graph nodes

## Current Status

Implemented:

- read VKTRFLO startup state from inside ComfyUI
- read managed runtime inventory and active runtime facts
- switch between installed managed runtimes
- reconnect-aware polling after a switch request
- same-origin proxy routes so the browser does not need to call the host service directly

Not implemented yet:

- standalone `start` action from the panel
- standalone `stop` action from the panel
- richer progress UX during reconnect
- polished failure recovery UX
- any graph execution nodes

## Requirements

- ComfyUI
- a running VKTRFLO host service
- at least one installed managed runtime in VKTRFLO

If you want switching to be meaningful, you need at least two installed runtimes in VKTRFLO for the same profile.

## Host Service Dependency

By default the extension expects the VKTRFLO host service at:

- `http://127.0.0.1:38431`

Override that with:

- `VKTRFLO_SERVICE_BASE_URL`

Example:

```powershell
$env:VKTRFLO_SERVICE_BASE_URL = "http://10.0.0.164:38431"
```

```bash
export VKTRFLO_SERVICE_BASE_URL="http://10.0.0.164:38431"
```

This extension is not a generic runtime manager for vanilla ComfyUI. It is a VKTRFLO control surface mounted inside ComfyUI.

## Installation

Place the repo in your ComfyUI `custom_nodes` directory:

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

Backend:

- `GET /vktrflo/env-switcher/config`
- `GET /vktrflo/env-switcher/runtime/startup-state`
- `GET /vktrflo/env-switcher/runtime/status`
- `POST /vktrflo/env-switcher/runtime/switch-and-start`

Frontend:

- a VKTRFLO env-switcher panel mounted into the ComfyUI UI

Package integration shape:

- `WEB_DIRECTORY = "./web"`
- `NODE_CLASS_MAPPINGS = {}`

This is intentional. The package is a frontend/control-plane extension, not a node pack.

## How Switching Works

The switch button does not fake anything in the browser.

It sends a real request through the ComfyUI-local proxy to the VKTRFLO host service:

- ComfyUI panel
- `POST /vktrflo/env-switcher/runtime/switch-and-start`
- VKTRFLO host `POST /api/v1/runtime/switch-and-start`
- host changes active runtime
- host starts the selected runtime
- panel polls until the new runtime converges back to `ready`

That means the extension is self-disruptive by design. It is issuing a control-plane command from inside the engine session that may tear down the current engine and bring it back as a different runtime.

## Development

Local project path used during VKTRFLO development:

- `D:\Projects\vktrflo-custom-nodes\ComfyUI-VKTRFLO-EnvSwitcher`

VKTRFLO host development can bundle this extension automatically into managed runtime installs when the sibling workspace layout exists or when `VF_ENV_SWITCHER_CUSTOM_NODE_DIR` is set.

## Limitations

- The panel depends on VKTRFLO host APIs and is not useful without them.
- If the host service is down, the panel will surface proxy/fetch failures.
- Engine switching is only as good as the installed runtime inventory and host lifecycle behavior.
- The panel currently assumes a single VKTRFLO host target.

## Repository Scope

This repository contains the standalone ComfyUI custom node package only.

The VKTRFLO host-side lifecycle APIs and managed runtime orchestration live in the main VKTRFLO repository:

- `https://github.com/vktrflo/vktrflo`
