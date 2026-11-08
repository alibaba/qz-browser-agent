from __future__ import annotations

import asyncio
import contextlib
import json
from typing import Any

from .cases import CaseSpec


try:
    from mcp import ClientSession
    from mcp.client.streamable_http import streamablehttp_client
except Exception as exc:  # pragma: no cover - exercised by CLI users.
    raise SystemExit(
        "Missing MCP client dependencies. Run with:\n"
        "  uv run --project tests/python --locked python tests/background/agent-behavior-regression.py\n"
        f"Original error: {exc}"
    ) from exc


class QingzhouMcpClient:
    def __init__(self, session: ClientSession) -> None:
        self.session = session
        self._readback_session_id = ""
        self._readback_lock = asyncio.Lock()

    async def call(self, name: str, args: dict[str, Any]) -> dict[str, Any]:
        # timeoutSeconds is the retired bridge field. The streamable HTTP client timeout bounds the call.
        result = await self.session.call_tool(name, dict(args))
        text = "\n".join(
            item.text for item in (result.content or [])
            if getattr(item, "type", "") == "text" and hasattr(item, "text")
        )
        if getattr(result, "isError", False):
            raise RuntimeError(text or f"{name} failed")
        if not text.strip():
            return {}
        try:
            return json.loads(text)
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"{name} returned non-JSON text: {text[:500]}") from exc

    async def create_session(self, case: CaseSpec) -> str:
        payload = await self.call("qingzhou_create_session", {
            "title": case.title,
            "firstMessage": case.prompt,
        })
        return self.session_id_from_payload(payload)

    async def create_empty_session(self, title: str) -> str:
        payload = await self.call("qingzhou_create_session", {"title": title})
        return self.session_id_from_payload(payload)

    @staticmethod
    def session_id_from_payload(payload: dict[str, Any]) -> str:
        session_id = (
            payload.get("sessionId")
            or (payload.get("session") or {}).get("sessionId")
        )
        if not session_id:
            raise RuntimeError(f"create_session returned no session id: {payload}")
        return str(session_id)

    async def send_message(self, session_id: str, text: str) -> dict[str, Any]:
        return await self.call("qingzhou_send_message", {
            "sessionId": session_id,
            "text": text,
            "wait": False,
            "waitForStart": True,
        })

    async def activate_session_working_tab(self, session_id: str) -> dict[str, Any]:
        payload = await self.call("qingzhou_call", {
            "method": "runtime_message",
            "params": {
                "message": {
                    "type": "activate_session_working_tab",
                    "sessionId": session_id,
                },
                "expectedType": "session_working_tab_activated",
            },
        })
        response = payload.get("response") if isinstance(payload, dict) else None
        if not isinstance(response, dict) or response.get("type") != "session_working_tab_activated":
            raise RuntimeError(f"working tab activation was not acknowledged: {payload}")
        return response

    async def snapshot(self, session_id: str, *, num: int = 500) -> dict[str, Any]:
        return await self.call("qingzhou_get_session_snapshot", {
            "sessionId": session_id,
            "compact": False,
            "includeTrace": False,
            "includeTools": False,
            "includeArtifacts": True,
            "tail": False,
            "num": num,
        })

    async def stop_session(self, session_id: str) -> None:
        with contextlib.suppress(Exception):
            await self.call("qingzhou_stop_session", {
                "sessionId": session_id,
                "cascade": True,
            })

    async def data_store_list(self, table: str, *, session_id: str = "") -> dict[str, Any]:
        # Data tables are global. Read them through our own explicit drive session;
        # the native Agent's session remains the subject of the acceptance test.
        async with self._readback_lock:
            if not self._readback_session_id:
                created = await self.call("qingzhou_create_drive_session", {"title": "Agent test Data readback"})
                self._readback_session_id = self.session_id_from_payload(created)
            tool_result = await self.call("qingzhou_execute_tool", {
                "sessionId": self._readback_session_id,
                "name": "data_store",
                "args": {"action": "list", "table": table, "limit": 500},
            })
            return tool_result.get("result") or {}

    async def aclose(self) -> None:
        async with self._readback_lock:
            if self._readback_session_id:
                await self.stop_session(self._readback_session_id)
                self._readback_session_id = ""

    async def execute_tool(self, name: str, args: dict[str, Any], *, session_id: str = "") -> Any:
        payload: dict[str, Any] = {"name": name, "args": args}
        if session_id:
            payload["sessionId"] = session_id
        result = await self.call("qingzhou_execute_tool", payload)
        return result.get("result")

    async def list_automations(self) -> dict[str, Any]:
        return await self.call("qingzhou_list_automations", {"limit": 100, "runLimit": 5})

    async def get_skill(self, name: str) -> dict[str, Any]:
        return await self.call("qingzhou_get_skill", {
            "name": name,
            "includeContent": True,
            "includeResources": False,
        })

    async def get_skill_resource(self, name: str, path: str) -> dict[str, Any]:
        return await self.call("qingzhou_get_skill_resource", {
            "name": name,
            "path": path,
            "start": 0,
            "maxChars": 300000,
        })

    async def list_skill_settings(self) -> dict[str, Any]:
        payload = await self.call("qingzhou_call", {
            "method": "runtime_message",
            "params": {
                "message": {"type": "list_skill_settings"},
                "expectedType": "skill_settings",
            },
        })
        response = payload.get("response") if isinstance(payload, dict) else None
        if not isinstance(response, dict) or response.get("type") != "skill_settings":
            raise RuntimeError("Skill settings listing was not acknowledged")
        return response

    async def submit_wait_form(self, session_id: str, wait_id: str, answers: dict[str, Any]) -> dict[str, Any]:
        return await self.call("qingzhou_submit_wait_form", {
            "sessionId": session_id,
            "waitId": wait_id,
            "answers": answers,
            "reason": "submitted",
        })
