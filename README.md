# ComfyUI-VKTRFLO-EnvSwitcher

UI-only ComfyUI custom node package for surfacing VKTRFLO managed-runtime status and, later, engine switching controls from inside ComfyUI.

Current phase:

- package scaffold
- ComfyUI frontend extension shell
- same-origin proxy routes for VKTRFLO host status reads
- read-only runtime panel

Not implemented yet:

- switch engine
- start engine
- stop engine
- reconnect token flow
- destructive runtime lifecycle controls

## Expected Host Service

By default the package expects the VKTRFLO host service at:

- `http://127.0.0.1:38431`

Override with:

- `VKTRFLO_SERVICE_BASE_URL`

## ComfyUI Integration Shape

- `WEB_DIRECTORY = "./web"`
- `NODE_CLASS_MAPPINGS = {}`

This is a UI-only extension. It does not register execution nodes in phase 1.
