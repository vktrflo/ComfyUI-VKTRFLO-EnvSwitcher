from __future__ import annotations

import aiohttp
from aiohttp import web

from .config import get_settings
from .web import fetch_json

_ROUTES_REGISTERED = False


def _json_error(message: str, status: int = 500) -> web.Response:
    return web.json_response({"error": {"message": message, "status": status}}, status=status)


async def _forward_post(request: web.Request, path: str) -> web.Response:
    try:
        settings = get_settings()
        payload = await request.json()
        timeout = aiohttp.ClientTimeout(total=30)

        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(
                f"{settings.service_base_url}{path}",
                json=payload,
            ) as response:
                body = await response.json(content_type=None)
                return web.json_response(body, status=response.status)
    except ValueError as exc:
        return _json_error(str(exc), status=400)
    except Exception as exc:
        return _json_error(str(exc), status=502)


def register_routes() -> None:
    global _ROUTES_REGISTERED

    if _ROUTES_REGISTERED:
        return

    try:
        from server import PromptServer
    except Exception as exc:  # pragma: no cover - depends on ComfyUI runtime import model
        print(f"[VKTRFLO Env Switcher] PromptServer unavailable: {exc}")
        return

    routes = PromptServer.instance.routes

    @routes.get("/vktrflo/env-switcher/config")
    async def env_switcher_config(_: web.Request) -> web.Response:
        settings = get_settings()
        return web.json_response(
            {
                "service_base_url": settings.service_base_url,
                "phase": "switchable",
                "capabilities": {
                    "read_status": True,
                    "switch_engine": True,
                    "start_engine": False,
                    "stop_engine": False,
                },
            }
        )

    @routes.get("/vktrflo/env-switcher/runtime/startup-state")
    async def env_switcher_startup_state(_: web.Request) -> web.Response:
        try:
            settings = get_settings()
            payload = await fetch_json(settings.service_base_url, "/api/v1/startup-state")
            return web.json_response(payload)
        except ValueError as exc:
            return _json_error(str(exc), status=400)
        except Exception as exc:
            return _json_error(str(exc), status=502)

    @routes.get("/vktrflo/env-switcher/runtime/status")
    async def env_switcher_runtime_status(_: web.Request) -> web.Response:
        try:
            settings = get_settings()
            payload = await fetch_json(settings.service_base_url, "/api/v1/runtime/status")
            return web.json_response(payload)
        except ValueError as exc:
            return _json_error(str(exc), status=400)
        except Exception as exc:
            return _json_error(str(exc), status=502)

    @routes.post("/vktrflo/env-switcher/runtime/switch-and-start")
    async def env_switcher_switch_and_start(request: web.Request) -> web.Response:
        return await _forward_post(request, "/api/v1/runtime/switch-and-start")

    _ROUTES_REGISTERED = True
