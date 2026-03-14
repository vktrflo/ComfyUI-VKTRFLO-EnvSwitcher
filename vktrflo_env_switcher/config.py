from __future__ import annotations

from dataclasses import dataclass
import os

DEFAULT_SERVICE_BASE_URL = "http://127.0.0.1:38431"


@dataclass(frozen=True)
class EnvSwitcherSettings:
    service_base_url: str


def _normalize_base_url(value: str | None) -> str:
    candidate = (value or "").strip().rstrip("/")
    if not candidate:
        candidate = DEFAULT_SERVICE_BASE_URL

    if not (candidate.startswith("http://") or candidate.startswith("https://")):
        raise ValueError("VKTRFLO service base URL must start with http:// or https://")

    return candidate


def get_settings() -> EnvSwitcherSettings:
    override = os.getenv("VKTRFLO_SERVICE_BASE_URL") or os.getenv("VF_SERVICE_BASE_URL")
    return EnvSwitcherSettings(service_base_url=_normalize_base_url(override))
