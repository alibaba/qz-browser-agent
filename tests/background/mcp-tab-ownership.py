#!/usr/bin/env python3
from __future__ import annotations

import argparse
import asyncio
import json
from typing import Any

from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client


class ToolFailure(RuntimeError):
    def __init__(self, payload: dict[str, Any]):
        self.payload = payload
        super().__init__(json.dumps(payload, ensure_ascii=False))


async def call(session: ClientSession, name: str, args: dict[str, Any]) -> dict[str, Any]:
    result = await session.call_tool(name, args)
    text = "\n".join(
        item.text for item in (result.content or [])
        if getattr(item, "type", "") == "text" and hasattr(item, "text")
    )
    if getattr(result, "isError", False):
        payload = json.loads(text) if text.strip() else {"code": "TOOL_ERROR", "message": f"{name} failed"}
        assert set(payload) <= {"code", "message", "hint", "details"}, payload
        assert isinstance(payload.get("code"), str) and payload["code"] == payload["code"].upper(), payload
        assert isinstance(payload.get("message"), str), payload
        assert "tabId" not in json.dumps(payload), payload
        raise ToolFailure(payload)
    return json.loads(text) if text.strip() else {}


async def execute(session: ClientSession, session_id: str, name: str, args: dict[str, Any]) -> Any:
    payload = await call(session, "qingzhou_execute_tool", {
        "sessionId": session_id,
        "name": name,
        "args": args,
        "timeoutSeconds": 30,
    })
    return payload.get("result")


async def create_session(session: ClientSession, title: str) -> str:
    payload = await call(session, "qingzhou_create_drive_session", {
        "title": title,
    })
    session_id = payload.get("sessionId")
    assert session_id, payload
    return str(session_id)


async def snapshot(session: ClientSession, session_id: str) -> dict[str, Any]:
    return await call(session, "qingzhou_get_session_snapshot", {
        "sessionId": session_id,
        "compact": True,
        "tail": True,
        "num": 5,
        "includeArtifacts": False,
    })


async def owned_tabs(session: ClientSession, session_id: str) -> list[int]:
    result = await execute(session, session_id, "list_tabs", {"scope": "owned"})
    return sorted(int(tab["tabRef"]) for tab in result["tabs"])


async def expect_denied(session: ClientSession, session_id: str, name: str, args: dict[str, Any], codes: set[str]) -> None:
    try:
        await execute(session, session_id, name, args)
    except ToolFailure as exc:
        assert exc.payload["code"] in codes, exc.payload
        return
    raise AssertionError(f"{name} unexpectedly accepted a forbidden operation")


async def amain(args: argparse.Namespace) -> int:
    base_url = args.base_url.rstrip("/")
    async with streamablehttp_client(args.bridge_url, timeout=30, sse_read_timeout=120) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()
            bridge = await call(session, "qingzhou_bridge_status", {})
            assert bridge.get("clientCount") == 1, bridge

            root_a = await create_session(session, "ownership root A")
            root_b = await create_session(session, "ownership root B")
            child = await create_session(session, "ownership independent session")

            tab_a = (await execute(session, root_a, "open_tab", {"url": f"{base_url}/root-a"}))["tabRef"]
            tab_a2 = (await execute(session, root_a, "open_tab", {"url": f"{base_url}/root-a-2"}))["tabRef"]
            tab_b = (await execute(session, root_b, "open_tab", {"url": f"{base_url}/root-b"}))["tabRef"]
            tab_child = (await execute(session, child, "open_tab", {"url": f"{base_url}/child"}))["tabRef"]

            tabs_a, tabs_b, tabs_child = await asyncio.gather(
                owned_tabs(session, root_a), owned_tabs(session, root_b), owned_tabs(session, child)
            )
            assert tabs_a == sorted([tab_a, tab_a2]), tabs_a
            assert tabs_b == [tab_b], tabs_b
            assert tabs_child == [tab_child], tabs_child
            snap_child = await snapshot(session, child)
            assert "workingTabId" not in (snap_child.get("runtime") or {}), snap_child

            await expect_denied(session, root_a, "navigate", {
                "tabRef": tab_b, "url": f"{base_url}/must-not-win",
            }, {"SESSION_TAB_FOREIGN"})
            for owner, reference in [(root_a, tab_child), (child, tab_a)]:
                await expect_denied(session, owner, "close_tab", {"tabRef": reference}, {"SESSION_TAB_FOREIGN", "SESSION_TAB_UNOWNED"})
            for name in ["use_tab", "get_working_tab"]:
                await expect_denied(session, root_a, name, {}, {"DRIVE_TOOL_FORBIDDEN"})

            article = await execute(session, root_a, "read_article", {"tabRef": tab_b, "limit": 4000})
            assert "root-b" in json.dumps(article, ensure_ascii=False), article
            assert "tabRef" not in article, article
            assert await owned_tabs(session, root_a) == sorted([tab_a, tab_a2])
            assert await owned_tabs(session, root_b) == [tab_b]

            listed = await execute(session, root_a, "list_tabs", {"scope": "all"})
            free_url = f"{base_url}/free"
            free = next((item for item in listed["tabs"] if str(item.get("url") or "").rstrip("/") == free_url), None)
            assert free and set(free) == {"tabRef", "url", "title", "active", "ownership"}, listed
            assert free["ownership"] == "unclaimed", free
            assert next(item for item in listed["tabs"] if item["tabRef"] == tab_b)["ownership"] == "foreign", listed
            default_listed = await execute(session, root_a, "list_tabs", {})
            assert {item["tabRef"]: item["ownership"] for item in default_listed["tabs"] if item["tabRef"] in {tab_a, tab_b, free["tabRef"]}} == {
                tab_a: "owned", free["tabRef"]: "unclaimed",
            }, default_listed
            free_tab_ref = int(free["tabRef"])
            free_article = await execute(session, root_a, "read_article", {"tabRef": free_tab_ref, "limit": 4000})
            assert "free" in json.dumps(free_article), free_article
            assert free_tab_ref not in await owned_tabs(session, root_a)

            claimed_url = f"{base_url}/claimed-free"
            await execute(session, root_a, "navigate", {"tabRef": free_tab_ref, "url": claimed_url})
            assert await owned_tabs(session, root_a) == sorted([tab_a, tab_a2, free_tab_ref])
            claimed_tabs = await execute(session, root_a, "list_tabs", {})
            claimed_free = next(item for item in claimed_tabs["tabs"] if item["tabRef"] == free_tab_ref)
            assert claimed_free["ownership"] == "owned", claimed_free
            assert claimed_free["url"] == claimed_url, claimed_free
            assert claimed_free["active"] == free["active"], "ownership must not change the user's active tab"
            await expect_denied(session, root_b, "navigate", {
                "tabRef": free_tab_ref, "url": f"{base_url}/must-not-steal",
            }, {"SESSION_TAB_FOREIGN"})
            assert await execute(session, root_a, "close_tab", {"tabRef": free_tab_ref}) == {"closed": True}
            assert await owned_tabs(session, root_a) == sorted([tab_a, tab_a2])

            await execute(session, root_a, "navigate", {"tabRef": tab_a, "url": f"{base_url}/owned-navigation"})
            navigated = await execute(session, root_a, "read_article", {"tabRef": tab_a, "limit": 4000})
            assert "owned-navigation" in json.dumps(navigated), navigated
            closed = await execute(session, root_a, "close_tab", {"tabRef": tab_a})
            assert closed == {"closed": True}, closed
            assert await owned_tabs(session, root_a) == [tab_a2]
            assert await owned_tabs(session, root_b) == [tab_b]
            assert await owned_tabs(session, child) == [tab_child]

    print(json.dumps({
        "ok": True,
        "sessions": {"rootA": root_a, "rootB": root_b, "child": child},
        "tabs": {"rootA": [tab_a, tab_a2], "rootB": tab_b, "child": tab_child, "unowned": free_tab_ref},
    }, ensure_ascii=False))
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Verify Session tab ownership through an isolated Qingzhou MCP E2E environment.")
    parser.add_argument("--bridge-url", required=True)
    parser.add_argument("--base-url", required=True)
    return parser.parse_args()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(amain(parse_args())))
