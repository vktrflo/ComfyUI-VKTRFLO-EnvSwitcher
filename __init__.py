from __future__ import annotations

WEB_DIRECTORY = "./web"
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

try:
    from .vktrflo_env_switcher.routes import register_routes

    register_routes()
except Exception as exc:  # pragma: no cover - best-effort bootstrap in host runtime
    print(f"[VKTRFLO Env Switcher] route registration failed: {exc}")

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
