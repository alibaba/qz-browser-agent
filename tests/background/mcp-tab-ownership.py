#!/usr/bin/env python3
from __future__ import annotations

import argparse
import asyncio
import json
from typing import Any

from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client


class ToolFailure(RuntimeError):
    pass


async def call(session: ClientSession, name: str, args: dict[str, Any]) -> dict[str, Any]:
    result = await session.call_tool(name, args)
    text = "\n".join(
        item.text for item in (result.content or [])
        if getattr(item, "type", "") == "text" and hasattr(item, "text")
    )
    if getattr(result, "isError", False):
        raise ToolFailure(text or f"{name} failed")
    return json.loads(text) if text.strip() else {}


async def execute(session: ClientSession, session_id: str, name: str, args: dict[str, Any]) -> Any:
    payload = await call(session, "qingzhou_execute_tool", {
        "sessionId": session_id,
        "name": name,
        "args": args,
        "timeoutSeconds": 30,
    })
    return payload.get("result")


async def create_session(session: ClientSession, title: str, parent_session_id: str = "") -> str:
    payload = await call(session, "qingzhou_create_session", {
        "title": title,
        "parentSessionId": parent_session_id,
    })
    session_id = payload.get("sessionId") or payload.get("id") or (payload.get("session") or {}).get("id")
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


def owned_tabs(value: dict[str, Any]) -> list[int]:
    runtime = value.get("runtime") or {}
    return sorted(int(item) for item in runtime.get("ownedTabIds") or runtime.get("sessionTabIds") or [])


async def expect_foreign(session: ClientSession, session_id: str, name: str, args: dict[str, Any]) -> str:
    try:
        await execute(session, session_id, name, args)
    except ToolFailure as exc:
        text = str(exc)
        assert "另一个任务" in text or "foreign" in text.lower(), text
        return text
    raise AssertionError(f"{name} unexpectedly accepted a foreign tab")


async def claim_with_client(bridge_url: str, session_id: str, tab_id: int) -> dict[str, Any]:
    async with streamablehttp_client(bridge_url, timeout=30, sse_read_timeout=120) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()
            try:
                result = await execute(session, session_id, "use_tab", {"tabId": tab_id})
                return {"ok": True, "sessionId": session_id, "result": result}
            except ToolFailure as exc:
                return {"ok": False, "sessionId": session_id, "error": str(exc)}


async def amain(args: argparse.Namespace) -> int:
    base_url = args.base_url.rstrip("/")
    async with streamablehttp_client(args.bridge_url, timeout=30, sse_read_timeout=120) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()
            bridge = await call(session, "qingzhou_bridge_status", {})
            assert bridge.get("clientCount") == 1, bridge

            root_a = await create_session(session, "ownership root A")
            root_b = await create_session(session, "ownership root B")
            child = await create_session(session, "ownership child", root_a)

            tab_a = (await execute(session, root_a, "open_tab", {"url": f"{base_url}/root-a"}))["id"]
            tab_a2 = (await execute(session, root_a, "open_tab", {"url": f"{base_url}/root-a-2"}))["id"]
            tab_b = (await execute(session, root_b, "open_tab", {"url": f"{base_url}/root-b"}))["id"]
            tab_child = (await execute(session, child, "open_tab", {"url": f"{base_url}/child"}))["id"]
            await asyncio.sleep(0.5)

            snap_a, snap_b, snap_child = await asyncio.gather(
                snapshot(session, root_a),
                snapshot(session, root_b),
                snapshot(session, child),
            )
            assert owned_tabs(snap_a) == sorted([tab_a, tab_a2]), snap_a.get("runtime")
            assert owned_tabs(snap_b) == [tab_b], snap_b.get("runtime")
            assert owned_tabs(snap_child) == [tab_child], snap_child.get("runtime")
            assert snap_child.get("session", {}).get("parentSessionId") == root_a

            await expect_foreign(session, root_a, "navigate", {
                "tabId": tab_b,
                "url": f"{base_url}/must-not-win",
            })
            await expect_foreign(session, root_a, "use_tab", {"tabId": tab_child})
            await expect_foreign(session, child, "use_tab", {"tabId": tab_a})

            article = await execute(session, root_a, "read_article", {"tabId": tab_b, "limit": 4000})
            article_text = json.dumps(article, ensure_ascii=False)
            assert "root-b" in article_text, article
            after_read_a, after_read_b = await asyncio.gather(snapshot(session, root_a), snapshot(session, root_b))
            assert owned_tabs(after_read_a) == sorted([tab_a, tab_a2])
            assert (after_read_a.get("runtime") or {}).get("workingTabId") == tab_a2
            assert owned_tabs(after_read_b) == [tab_b]

            listed = await execute(session, root_a, "list_tabs", {})
            free_url = f"{base_url}/free"
            free = next((item for item in listed if str(item.get("url") or "").rstrip("/") == free_url), None)
            assert free and free.get("claimRequired") is True, listed
            free_tab_id = int(free["id"])

    claims = await asyncio.gather(
        claim_with_client(args.bridge_url, root_a, free_tab_id),
        claim_with_client(args.bridge_url, root_b, free_tab_id),
    )
    winners = [item for item in claims if item["ok"]]
    losers = [item for item in claims if not item["ok"]]
    assert len(winners) == 1 and len(losers) == 1, claims
    assert "另一个任务" in losers[0]["error"] or "foreign" in losers[0]["error"].lower(), losers[0]

    async with streamablehttp_client(args.bridge_url, timeout=30, sse_read_timeout=120) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()
            winner = winners[0]["sessionId"]
            loser = losers[0]["sessionId"]
            winner_snapshot, loser_snapshot, child_snapshot = await asyncio.gather(
                snapshot(session, winner), snapshot(session, loser), snapshot(session, child)
            )
            assert free_tab_id in owned_tabs(winner_snapshot)
            assert free_tab_id not in owned_tabs(loser_snapshot)
            assert owned_tabs(child_snapshot) == [tab_child]
            await expect_foreign(session, loser, "navigate", {
                "tabId": free_tab_id,
                "url": f"{base_url}/loser-must-not-win",
            })
            await execute(session, winner, "navigate", {
                "tabId": free_tab_id,
                "url": f"{base_url}/winner",
            })
            await execute(session, winner, "close_tab", {"tabId": free_tab_id})
            await asyncio.sleep(0.3)
            final_a, final_b, final_child = await asyncio.gather(
                snapshot(session, root_a), snapshot(session, root_b), snapshot(session, child)
            )
            assert free_tab_id not in owned_tabs(final_a)
            assert free_tab_id not in owned_tabs(final_b)
            assert owned_tabs(final_child) == [tab_child]
            assert tab_b in owned_tabs(final_b)

    print(json.dumps({
        "ok": True,
        "sessions": {"rootA": root_a, "rootB": root_b, "child": child},
        "tabs": {"rootA": [tab_a, tab_a2], "rootB": tab_b, "child": tab_child, "contended": free_tab_id},
        "claimWinner": winners[0]["sessionId"],
        "claimLoser": losers[0]["sessionId"],
    }, ensure_ascii=False))
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Verify Session tab ownership through an isolated Qingzhou MCP E2E environment.")
    parser.add_argument("--bridge-url", required=True)
    parser.add_argument("--base-url", required=True)
    return parser.parse_args()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(amain(parse_args())))
