from __future__ import annotations

from typing import Any

import aiohttp


async def fetch_json(service_base_url: str, path: str, timeout_seconds: float = 10.0) -> dict[str, Any]:
    url = f"{service_base_url}{path}"
    timeout = aiohttp.ClientTimeout(total=timeout_seconds)

    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.get(url) as response:
            if response.status >= 400:
                detail = await response.text()
                raise RuntimeError(f"VKTRFLO host request failed ({response.status}) for {path}: {detail.strip()}")

            payload = await response.json()
            if not isinstance(payload, dict):
                raise RuntimeError(f"VKTRFLO host returned non-object JSON for {path}")
            return payload
