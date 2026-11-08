from __future__ import annotations

import contextlib
import json
import re
from collections import Counter
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

from .cases import CaseSpec
from .client import QingzhouMcpClient
from .fixtures import CATALOG, NEWS, POSTS, FixtureHandler


TOOL_RECOVERY_KEYS = {
    "click_element": "act_on_element",
    "fill_input": "act_on_element",
    "select_element": "act_on_element",
}


async def validate_case(
    client: QingzhouMcpClient,
    case: CaseSpec,
    run_tag: str,
    session_id: str,
    snapshot: dict[str, Any],
    timed_out: bool,
    error: str,
) -> dict[str, Any]:
    if error:
        return {"success": False, "reason": error, "checks": {}}
    if timed_out:
        return {"success": False, "reason": "case timed out", "checks": {}}
    status = snapshot.get("status") or (snapshot.get("runtime") or {}).get("status")
    checks: dict[str, Any] = {"status": status}
    allowed_statuses = {"completed"}
    if case.name == "image_selection_insufficient_metadata":
        allowed_statuses.add("waiting_user")
    if status not in allowed_statuses:
        return {"success": False, "reason": f"session status is {status}", "checks": checks}

    transcript = snapshot.get("transcript") or []
    failed_calls = [item for item in transcript if item.get("type") == "tool" and item.get("isError")]
    checks["failedToolCallCount"] = len(failed_calls)
    unrecovered_calls = unrecovered_tool_calls(transcript)
    checks["unrecoveredToolCallCount"] = len(unrecovered_calls)
    if unrecovered_calls and case.suite == "base":
        checks["unrecoveredTools"] = [str(item.get("name") or "") for item in unrecovered_calls]
        return {"success": False, "reason": "tool call failed without recovery", "checks": checks}
    used_tools = [
        str(item.get("name") or "")
        for item in transcript
        if item.get("type") == "tool" and not item.get("isError")
    ]
    if case.required_tools:
        missing_tools = sorted(set(case.required_tools) - set(used_tools))
        checks["requiredTools"] = list(case.required_tools)
        checks["missingTools"] = missing_tools
        if missing_tools:
            return {"success": False, "reason": f"missing required tools: {missing_tools}", "checks": checks}

    table = case.table
    data = await client.data_store_list(table, session_id=session_id) if table else {}
    rows = (data.get("rows") or []) if isinstance(data, dict) else []
    checks["table"] = table
    checks["rowCount"] = len(rows)
    checks["totalRows"] = data.get("totalRows") if isinstance(data, dict) else None

    if case.suite in {"journeys", "journeys-vision"}:
        return await validate_journey_case(
            client,
            case,
            session_id=session_id,
            snapshot=snapshot,
            transcript=transcript,
            rows=rows,
            checks=checks,
        )

    if case.name in {"current_page_environment_handoff", "no_working_tab_environment"}:
        setup = ((snapshot.get("_behaviorDriver") or {}).get("environmentSetup") or {})
        visible_tab_id = safe_int(setup.get("visibleTabId"))
        working_tab_id = safe_int(setup.get("workingTabId"))
        visible_owner_id = str(setup.get("visibleOwnerSessionId") or "")
        expects_working_tab = case.name == "current_page_environment_handoff"
        checks["environmentSetup"] = setup
        if visible_tab_id is None or not visible_owner_id or (expects_working_tab and working_tab_id is None):
            return {"success": False, "reason": "environment setup metadata is incomplete", "checks": checks}

        row_datas = row_data_list(rows)
        checks["environmentRows"] = row_datas
        if expects_working_tab:
            actual = {str(item.get("pageRole") or ""): item for item in row_datas}
            if len(rows) != 2 or set(actual) != {"user-visible", "session-working"}:
                return {"success": False, "reason": "expected exactly one row for each page role", "checks": checks}
            expected_rows = [
                (case.expected[name], actual.get(case.expected[name]["pageRole"], {}))
                for name in ("visible", "working")
            ]
        else:
            if len(rows) != 1 or str(row_datas[0].get("check") or "") != "no-working-page-context":
                return {"success": False, "reason": "expected one no-working-page-context row", "checks": checks}
            if row_datas[0].get("hasWorkingTab") is not False:
                return {"success": False, "reason": "no-working row did not preserve hasWorkingTab=false", "checks": checks}
            expected_rows = [(case.expected["visible"], row_datas[0])]
        for expected, stored in expected_rows:
            if str(stored.get("pageRole") or "") != expected["pageRole"]:
                return {"success": False, "reason": f"pageRole mismatch for {expected['pageRole']}", "checks": checks}
            if str(stored.get("marker") or "") != expected["marker"]:
                return {"success": False, "reason": f"marker mismatch for {expected['pageRole']}", "checks": checks}
            if str(stored.get("title") or "") != expected["title"]:
                return {"success": False, "reason": f"title mismatch for {expected['pageRole']}", "checks": checks}
            if urlparse(str(stored.get("url") or "")).path != expected["path"]:
                return {"success": False, "reason": f"URL mismatch for {expected['pageRole']}", "checks": checks}

        foreign_read_tools = {"read_article", "read_dom", "find_elements", "inspect_element", "list_images", "read_image"}
        owned_read_tools = {*foreign_read_tools, "get_ax_tree"}
        page_reads = [
            item for item in transcript
            if item.get("type") == "tool"
            and item.get("name") in owned_read_tools
            and not item.get("isError")
        ]
        checks["pageReads"] = [
            {
                "tool": item.get("name"),
                "tabId": tool_effective_tab_id(item),
                "path": tool_page_path(item),
            }
            for item in page_reads
        ]
        visible_reads = [
            item for item in page_reads
            if item.get("name") in foreign_read_tools and tool_effective_tab_id(item) == visible_tab_id
        ]
        working_reads = [item for item in page_reads if tool_effective_tab_id(item) == working_tab_id]
        if not visible_reads or (expects_working_tab and not working_reads):
            return {"success": False, "reason": "agent did not read the required page roles with page read tools", "checks": checks}
        if any(safe_int(parse_tool_args(item).get("tabId")) != visible_tab_id for item in visible_reads):
            return {"success": False, "reason": "foreign visible page was not addressed by explicit tabId", "checks": checks}

        working_getter_results = [
            item.get("result") if isinstance(item.get("result"), dict) else {}
            for item in tool_items(transcript, "get_working_tab", successful_only=True)
        ]
        checks["workingGetterResults"] = working_getter_results
        if not expects_working_tab and any(result.get("hasWorkingTab") is not False for result in working_getter_results):
            return {"success": False, "reason": "get_working_tab did not report the normal empty state", "checks": checks}
        if not expects_working_tab and failed_calls:
            return {"success": False, "reason": "no-working-tab flow produced a recoverable tool failure", "checks": checks}

        foreign_access_errors = [
            {
                "tool": str(item.get("name") or ""),
                "code": str((item.get("result") or {}).get("code") or ""),
            }
            for item in failed_calls
            if str((item.get("result") or {}).get("code") or "") == "SESSION_TAB_FOREIGN"
        ]
        checks["foreignAccessErrors"] = foreign_access_errors
        if foreign_access_errors:
            return {"success": False, "reason": "agent attempted an owner-only tool on the foreign visible page", "checks": checks}

        lifecycle_tools = {
            "open_tab", "use_tab", "navigate", "close_tab", "act_on_element", "act_on_screen", "run_script",
        }
        lifecycle_calls = [
            str(item.get("name") or "")
            for item in transcript
            if item.get("type") == "tool" and item.get("name") in lifecycle_tools
        ]
        checks["lifecycleCalls"] = lifecycle_calls
        if lifecycle_calls:
            return {"success": False, "reason": f"read-only handoff used page lifecycle tools: {lifecycle_calls}", "checks": checks}

        runtime = snapshot.get("runtime") if isinstance(snapshot.get("runtime"), dict) else {}
        owned_tabs = {safe_int(value) for value in (runtime.get("ownedTabIds") or runtime.get("sessionTabIds") or [])}
        checks["subjectOwnership"] = {
            "workingTabId": safe_int(runtime.get("workingTabId")),
            "ownedTabIds": sorted(value for value in owned_tabs if value is not None),
        }
        if expects_working_tab:
            ownership_changed = (
                safe_int(runtime.get("workingTabId")) != working_tab_id
                or working_tab_id not in owned_tabs
                or visible_tab_id in owned_tabs
            )
        else:
            ownership_changed = safe_int(runtime.get("workingTabId")) is not None or bool(owned_tabs)
        if ownership_changed:
            return {"success": False, "reason": "subject tab ownership changed during read-only handoff", "checks": checks}

        owner_snapshot = await client.snapshot(visible_owner_id)
        owner_runtime = owner_snapshot.get("runtime") if isinstance(owner_snapshot.get("runtime"), dict) else {}
        owner_tabs = {safe_int(value) for value in (owner_runtime.get("ownedTabIds") or owner_runtime.get("sessionTabIds") or [])}
        checks["visibleOwnerOwnership"] = {
            "workingTabId": safe_int(owner_runtime.get("workingTabId")),
            "ownedTabIds": sorted(value for value in owner_tabs if value is not None),
        }
        if safe_int(owner_runtime.get("workingTabId")) != visible_tab_id or visible_tab_id not in owner_tabs:
            return {"success": False, "reason": "foreign visible page ownership was transferred", "checks": checks}

        listed_tabs = await client.execute_tool("list_tabs", {}, session_id=session_id)
        listed_tabs = listed_tabs if isinstance(listed_tabs, list) else []
        active_tabs = [item for item in listed_tabs if isinstance(item, dict) and item.get("active") is True]
        checks["activeTabs"] = [
            {"id": item.get("id"), "url": item.get("url"), "ownerSessionId": item.get("ownerSessionId")}
            for item in active_tabs
        ]
        if len(active_tabs) != 1 or safe_int(active_tabs[0].get("id")) != visible_tab_id:
            return {"success": False, "reason": "user-visible active tab changed during the task", "checks": checks}
        return {"success": True, "checks": checks}

    if case.name == "data_store_crud":
        actions = data_store_actions(transcript)
        required = {"upsert", "list", "delete"}
        checks["dataStoreActions"] = actions
        checks["remainingNames"] = [((row.get("data") or {}).get("name")) for row in rows]
        missing = sorted(required - set(actions))
        if missing:
            return {"success": False, "reason": f"missing data_store actions: {missing}", "checks": checks}
        checks["betaUpdated"] = has_data_store_row_state(
            transcript,
            name="beta",
            expected={"value": 999, "status": "updated"},
            actions={"update", "replace", "upsert"},
        )
        if not checks["betaUpdated"]:
            return {"success": False, "reason": "beta was not durably updated to value=999/status=updated", "checks": checks}
        if len(rows) != 1 or (rows[0].get("data") or {}).get("name") != "alpha":
            return {"success": False, "reason": "CRUD final table state mismatch", "checks": checks}
        return {"success": True, "checks": checks}

    if case.name == "web_explore_click":
        if len(rows) != 3:
            return {"success": False, "reason": "expected 3 page-2 news rows", "checks": checks}
        row_datas = row_data_list(rows)
        expected = {
            title: {"author": author, "path": f"/news/{story_id}"}
            for story_id, title, author in NEWS[2]
        }
        actual = {str(data.get("title") or ""): data for data in row_datas}
        checks["newsTitles"] = sorted(actual)
        if set(actual) != set(expected):
            return {"success": False, "reason": "page-2 news titles do not match the fixture", "checks": checks}
        for title, wanted in expected.items():
            data = actual[title]
            if str(data.get("author") or "") != wanted["author"]:
                return {"success": False, "reason": f"news author mismatch for {title}", "checks": checks}
            if safe_int(data.get("page")) != 2:
                return {"success": False, "reason": f"news page mismatch for {title}", "checks": checks}
            if urlparse(str(data.get("url") or "")).path != wanted["path"]:
                return {"success": False, "reason": f"news URL mismatch for {title}", "checks": checks}
        return {"success": True, "checks": checks}

    if case.name == "run_script_collection":
        run_script_timeouts = extract_run_script_timeouts(transcript)
        checks["runScriptTimeouts"] = run_script_timeouts
        if len(rows) != 6:
            return {"success": False, "reason": "expected 6 catalog rows", "checks": checks}
        row_datas = row_data_list(rows)
        expected = {
            sku: {"name": name, "price": int(price), "page": page}
            for page, items in CATALOG.items()
            for sku, name, price in items
        }
        actual = {str(data.get("sku") or ""): data for data in row_datas}
        checks["catalogSkus"] = sorted(actual)
        if set(actual) != set(expected):
            return {"success": False, "reason": "catalog SKUs do not match both fixture pages", "checks": checks}
        for sku, wanted in expected.items():
            data = actual[sku]
            if str(data.get("name") or "") != wanted["name"]:
                return {"success": False, "reason": f"catalog name mismatch for {sku}", "checks": checks}
            if safe_int(data.get("price")) != wanted["price"] or safe_int(data.get("page")) != wanted["page"]:
                return {"success": False, "reason": f"catalog value/page mismatch for {sku}", "checks": checks}
            if not str(data.get("url") or "").strip():
                return {"success": False, "reason": f"catalog source URL missing for {sku}", "checks": checks}
        return {"success": True, "checks": checks}

    if case.name == "goal_driven_pagination":
        goal_actions = manage_goal_actions(transcript)
        checks["goalActions"] = goal_actions
        for action in ("create", "checkpoint", "complete"):
            if action not in goal_actions:
                return {"success": False, "reason": f"missing manage_goal {action}", "checks": checks}
        if len(rows) != 9:
            return {"success": False, "reason": "expected 9 post rows", "checks": checks}
        row_datas = row_data_list(rows)
        expected = {
            title: {"author": author, "page": page, "path": f"/posts/{post_id}"}
            for page, items in POSTS.items()
            for post_id, title, author in items
        }
        actual = {str(data.get("title") or ""): data for data in row_datas}
        checks["postTitles"] = sorted(actual)
        if set(actual) != set(expected):
            return {"success": False, "reason": "post titles do not match all fixture pages", "checks": checks}
        for title, wanted in expected.items():
            data = actual[title]
            if str(data.get("author") or "") != wanted["author"] or safe_int(data.get("page")) != wanted["page"]:
                return {"success": False, "reason": f"post author/page mismatch for {title}", "checks": checks}
            if urlparse(str(data.get("url") or "")).path != wanted["path"]:
                return {"success": False, "reason": f"post URL mismatch for {title}", "checks": checks}
        return {"success": True, "checks": checks}

    if case.name == "document_pipeline":
        row_datas = row_data_list(rows)
        completed = [data for data in row_datas if data.get("step") == "document_pipeline_completed"]
        checks["documentPipelineRows"] = completed
        if len(completed) != 1:
            return {"success": False, "reason": "missing unique document_pipeline_completed row", "checks": checks}
        identifiers = {key: str(completed[0].get(key) or "").strip() for key in ("fileId", "docModelId", "artifactId")}
        checks["documentIdentifiers"] = identifiers
        if not all(identifiers.values()):
            return {"success": False, "reason": "document pipeline identifiers are incomplete", "checks": checks}
        required_order = [
            "qingzhou_documents__document_fetch",
            "qingzhou_documents__document_parse",
            "qingzhou_documents__document_read_chunk",
            "qingzhou_documents__document_create",
        ]
        used_in_order = [
            str(item.get("name") or "")
            for item in transcript
            if item.get("type") == "tool" and not item.get("isError") and item.get("name") in required_order
        ]
        checks["documentToolOrder"] = used_in_order
        positions = [used_in_order.index(name) if name in used_in_order else -1 for name in required_order]
        if positions != sorted(positions) or any(position < 0 for position in positions):
            return {"success": False, "reason": "document tools did not run in fetch/parse/read/create order", "checks": checks}
        if any(item.get("type") == "tool" and item.get("name") in {"download_url", "save_file"} for item in transcript):
            return {"success": False, "reason": "document pipeline unexpectedly downloaded the artifact", "checks": checks}
        return {"success": True, "checks": checks}

    if case.name == "mcp_probe":
        row_datas = row_data_list(rows)
        probes = [data for data in row_datas if data.get("check") == "mcp_registry_listed"]
        checks["mcpProbeRows"] = probes
        if len(probes) != 1:
            return {"success": False, "reason": "missing unique mcp_registry_listed row", "checks": checks}
        server_count = safe_int(probes[0].get("serverCount"))
        tool_count = safe_int(probes[0].get("toolCount"))
        checks["mcpCounts"] = {"serverCount": server_count, "toolCount": tool_count}
        if server_count is None or server_count < 0 or tool_count is None or tool_count < 0:
            return {"success": False, "reason": "MCP registry counts are missing or invalid", "checks": checks}
        if tool_args_list(transcript, "qingzhou_mcp__mcp_call_tool"):
            return {"success": False, "reason": "MCP probe called an external tool unexpectedly", "checks": checks}
        return {"success": True, "checks": checks}

    if case.name == "confirm_wait":
        row_datas = row_data_list(rows)
        wait_rows = [data for data in row_datas if data.get("check") == "wait_completed"]
        checks["waitRows"] = wait_rows
        if len(wait_rows) != 1 or not truthy(wait_rows[0].get("waited")):
            return {"success": False, "reason": "wait completion was not durably verified", "checks": checks}
        successful_tools = [
            str(item.get("name") or "")
            for item in transcript
            if item.get("type") == "tool" and not item.get("isError")
        ]
        checks["waitToolOrder"] = successful_tools
        if successful_tools.index("wait") > successful_tools.index("data_store"):
            return {"success": False, "reason": "wait completion was recorded before waiting", "checks": checks}
        return {"success": True, "checks": checks}

    if case.name in {"navigation_readiness_plain", "navigation_readiness_watched"}:
        calls = [item for item in transcript if item.get("type") == "tool"]
        navigations = [(index, item) for index, item in enumerate(calls)
                       if item.get("name") in {"open_tab", "navigate"}]
        if failed_calls or [item.get("name") for _, item in navigations] != ["open_tab", "navigate", "navigate", "navigate"]:
            return failure("expected four successful navigations without retries", checks)
        if any(item.get("name") in {"wait", "wait_for_navigation", "run_script"} for item in calls):
            return failure("agent masked navigation readiness with an extra wait or script", checks)
        if parse_tool_args(navigations[0][1]).get("watchNetwork") is not case.expected["watchNetwork"]:
            return failure("open_tab did not use the requested watchNetwork mode", checks)
        if parse_tool_args(navigations[1][1]).get("url") != parse_tool_args(navigations[2][1]).get("url"):
            return failure("reload did not navigate to exactly the same URL", checks)
        expected_receipts = dict(zip(("open", "navigate", "reload", "redirect"),
                                    ("QZ-first-1", "QZ-second-1", "QZ-second-2", "QZ-landed-1")))
        checks["navigationReads"] = []
        opened = navigations[0][1]
        opened_result = opened.get("result") or {}
        opened_ref = opened_result.get("tabRef", opened_result.get("id"))
        references = {str(value) for value in (opened_ref, parse_tool_args(opened).get("tabAlias")) if value is not None}
        for (index, navigation), (step, receipt) in zip(navigations, expected_receipts.items()):
            read = calls[index + 1] if index + 1 < len(calls) else {}
            result = read.get("result") or {}
            if read.get("name") != "read_article" or receipt not in str(result.get("text") or ""):
                return failure(f"{step}: first read did not return the new document's receipt", checks)
            if opened_ref is None or str(tool_page_reference(read)) not in references or (step != "open" and str(tool_page_reference(navigation)) not in references):
                return failure(f"{step}: navigation/read did not retain the opened tab", checks)
            checks["navigationReads"].append({"step": step, "receipt": receipt, "tabRef": opened_ref})
        stored = {str(row.get("step") or ""): row.get("receipt") for row in row_data_list(rows)}
        if len(rows) != 4 or stored != expected_receipts:
            return failure("stored receipts do not match the four actual documents", checks)
        if case.expected["watchNetwork"]:
            records = flatten_tool_results(transcript, "network_recent")
            checks["firstRequestCaptured"] = any(urlparse(str(record.get("url") or "")).path == "/navigation/first" for record in records)
            if not checks["firstRequestCaptured"]:
                return failure("network monitoring missed the first document request", checks)
        return success(checks)

    if case.name == "network_form_edge":
        open_args = tool_args_list(transcript, "open_tab")
        checks["openTabWatchNetwork"] = [bool(args.get("watchNetwork")) for args in open_args]
        network_watch_used = bool(tool_args_list(transcript, "network_watch"))
        checks["networkWatchUsed"] = network_watch_used
        if not network_watch_used and not any(checks["openTabWatchNetwork"]):
            return {"success": False, "reason": "network capture was not enabled before form interaction", "checks": checks}
        network_records = flatten_tool_results(transcript, "network_recent")
        network_records.extend(
            result["response"]
            for item in tool_items(transcript, "wait_for_response", successful_only=True)
            if isinstance(result := item.get("result"), dict)
            and result.get("matched") is True and isinstance(result.get("response"), dict)
        )
        matching_responses = []
        for record in network_records:
            parsed = urlparse(str(record.get("url") or ""))
            query = parse_qs(parsed.query)
            status = safe_int(record.get("status"))
            if (
                parsed.path == "/api/search" and query.get("q") == ["chair"]
                and query.get("category") == ["furniture"] and query.get("vip") == ["1"]
                and status is not None and 200 <= status < 300
                and not record.get("failed") and not record.get("canceled")
            ):
                matching_responses.append(record)
        checks["matchingNetworkResponseCount"] = len(matching_responses)
        if not matching_responses:
            return {"success": False, "reason": "successful form network response evidence is missing", "checks": checks}
        console_text = "\n".join(str(record.get("text") or "") for record in flatten_tool_results(transcript, "read_console_messages"))
        if "fixture search submit chair furniture 1" not in console_text or "fixture search rendered 2" not in console_text:
            return {"success": False, "reason": "form submission and rendering console evidence is missing", "checks": checks}
        row_datas = row_data_list(rows)
        checks["storedChecks"] = [data.get("check") for data in row_datas]
        form_rows = [data for data in row_datas if data.get("check") == "form_network_console"]
        if not form_rows:
            return {"success": False, "reason": "missing form_network_console data row", "checks": checks}
        data = form_rows[0]
        checks["formRow"] = {
            "query": data.get("query"),
            "category": data.get("category"),
            "vip": data.get("vip"),
            "resultCount": data.get("resultCount"),
            "networkMatched": data.get("networkMatched"),
            "consoleSeen": data.get("consoleSeen"),
        }
        if str(data.get("query") or "").lower() != "chair":
            return {"success": False, "reason": "network form query was not stored as chair", "checks": checks}
        if str(data.get("category") or "").lower() != "furniture":
            return {"success": False, "reason": "network form category was not furniture", "checks": checks}
        if not network_evidence(data.get("networkMatched")):
            return {"success": False, "reason": "network response was not marked matched", "checks": checks}
        if safe_int(data.get("resultCount")) != 2:
            return {"success": False, "reason": "form result count was not verified as 2", "checks": checks}
        if not console_evidence(data.get("consoleSeen")):
            return {"success": False, "reason": "form console evidence was not stored", "checks": checks}
        return {"success": True, "checks": checks}

    if case.name in {"image_collection_targets", "image_collection_urls"}:
        collect_args = tool_args_list(transcript, "collect_images")
        selections = [summarize_image_selections(args) for args in collect_args]
        checks["imageSelections"] = selections
        if any(item["legacyFields"] for item in selections):
            return {"success": False, "reason": "collect_images used a removed scan or ordinal field", "checks": checks}
        selected_targets = sum(item["targetCount"] for item in selections)
        selected_urls = sum(item["urlCount"] for item in selections)
        checks["selectedTargets"] = selected_targets
        checks["selectedUrls"] = selected_urls
        if selected_targets + selected_urls != 2:
            return {"success": False, "reason": "collect_images did not explicitly select exactly 2 targets/URLs", "checks": checks}
        if case.name == "image_collection_targets" and selected_targets != 2:
            return {"success": False, "reason": "page candidate task did not use 2 explicit targets", "checks": checks}
        if case.name == "image_collection_urls" and selected_urls != 2:
            return {"success": False, "reason": "URL task did not use 2 explicit URLs", "checks": checks}
        if len(rows) < 2:
            return {"success": False, "reason": "expected at least 2 image collection rows", "checks": checks}
        row_datas = row_data_list(rows)
        collected_sources = sorted(Path(urlparse(str(data.get("src") or "")).path).name for data in row_datas)
        checks["collectedSources"] = collected_sources
        if collected_sources != ["blue.svg", "red.svg"]:
            return {"success": False, "reason": "image selection did not preserve the two requested sources", "checks": checks}
        asset_ids = [data.get("assetId") for data in row_datas if data.get("assetId")]
        checks["assetIds"] = asset_ids
        if len(asset_ids) < 2:
            return {"success": False, "reason": "image collection rows do not contain at least 2 assetIds", "checks": checks}
        return {"success": True, "checks": checks}

    if case.name == "image_selection_metadata":
        tool_names = [
            str(item.get("name") or "")
            for item in transcript
            if item.get("type") == "tool"
        ]
        evidence_tools = {"get_ax_tree", "read_article", "list_images", "find_elements", "inspect_element"}
        evidence_positions = [index for index, name in enumerate(tool_names) if name in evidence_tools]
        collect_positions = [index for index, name in enumerate(tool_names) if name == "collect_images"]
        checks["imageEvidencePositions"] = evidence_positions
        checks["collectImagePositions"] = collect_positions
        if not evidence_positions or not collect_positions or min(evidence_positions) > min(collect_positions):
            return {"success": False, "reason": "image evidence was not inspected before collection", "checks": checks}

        collect_args = tool_args_list(transcript, "collect_images")
        selections = [summarize_image_selections(args) for args in collect_args]
        checks["imageSelections"] = selections
        if any(item["legacyFields"] for item in selections):
            return {"success": False, "reason": "collect_images used a removed scan or ordinal field", "checks": checks}
        if any(item["targetCount"] + item["urlCount"] > 2 for item in selections):
            return {"success": False, "reason": "collect_images included candidates beyond the selected article images", "checks": checks}
        collected_counts = [
            safe_int(result.get("collected"))
            for result in tool_result_list(transcript, "collect_images")
        ]
        checks["collectedPerCall"] = collected_counts
        if any(count is not None and count > 2 for count in collected_counts):
            return {"success": False, "reason": "collect_images saved unrelated candidates before final verification", "checks": checks}

        row_datas = row_data_list(rows)
        collected_sources = sorted(Path(urlparse(str(data.get("src") or "")).path).name for data in row_datas)
        checks["collectedSources"] = collected_sources
        expected_sources = ["grind-step.svg", "pour-step.svg"]
        if collected_sources != expected_sources:
            return {
                "success": False,
                "reason": f"expected only semantic article images {expected_sources}",
                "checks": checks,
            }
        asset_ids = [data.get("assetId") for data in row_datas if data.get("assetId")]
        checks["assetIds"] = asset_ids
        if len(asset_ids) != 2:
            return {"success": False, "reason": "selected image rows do not contain exactly 2 assetIds", "checks": checks}
        return {"success": True, "checks": checks}

    if case.name == "image_collection_tab_locality":
        indexed_tools = [
            (index, item) for index, item in enumerate(transcript)
            if item.get("type") == "tool"
        ]
        collection_tools = [
            item for item in transcript
            if item.get("type") == "tool" and item.get("name") == "collect_images"
        ]
        selections = [summarize_image_selections(parse_tool_args(item)) for item in collection_tools]
        checks["imageSelections"] = selections
        checks["collectionPageUrls"] = [
            str((item.get("result") or {}).get("_pageUrl") or "")
            for item in collection_tools
        ]
        if len(collection_tools) != 2:
            return {"success": False, "reason": "expected one collection call for each source page", "checks": checks}
        if any(item["targetCount"] != 1 or item["urlCount"] != 0 for item in selections):
            return {"success": False, "reason": "each source page should collect its accepted target in place", "checks": checks}
        collection_pages = {
            urlparse(url).path for url in checks["collectionPageUrls"] if url
        }
        expected_pages = {"/image-locality/source-a", "/image-locality/source-b"}
        if collection_pages != expected_pages:
            return {"success": False, "reason": "collection did not stay in each candidate's source-page context", "checks": checks}
        lifecycle_tools = {"open_tab", "use_tab", "navigate", "close_tab", "act_on_element"}
        for source_page in expected_pages:
            discovery_positions = [
                index for index, item in indexed_tools
                if item.get("name") == "list_images" and tool_page_path(item) == source_page
            ]
            collection_positions = [
                index for index, item in indexed_tools
                if item.get("name") == "collect_images" and tool_page_path(item) == source_page
            ]
            if not discovery_positions or not collection_positions:
                return {"success": False, "reason": f"missing discovery/collection pair for {source_page}", "checks": checks}
            discovery_index = min(discovery_positions)
            later_collections = [index for index in collection_positions if index > discovery_index]
            if not later_collections:
                return {"success": False, "reason": f"{source_page} was not collected after discovery", "checks": checks}
            collection_index = min(later_collections)
            context_changes = [
                {
                    "index": index,
                    "tool": str(item.get("name") or ""),
                    "page": tool_page_path(item),
                }
                for index, item in indexed_tools
                if discovery_index < index < collection_index
                and item.get("name") in lifecycle_tools
                and tool_page_path(item)
                and tool_page_path(item) != source_page
            ]
            if context_changes:
                checks.setdefault("prematureContextChanges", {})[source_page] = context_changes
                return {"success": False, "reason": f"left {source_page} before collecting its accepted target", "checks": checks}
        row_datas = row_data_list(rows)
        collected_sources = sorted(Path(urlparse(str(data.get("src") or "")).path).name for data in row_datas)
        checks["collectedSources"] = collected_sources
        if collected_sources != ["cmu-defense.svg", "cmu-lab.svg"]:
            return {"success": False, "reason": "expected exactly the two CMU source-page images", "checks": checks}
        asset_ids = [data.get("assetId") for data in row_datas if data.get("assetId")]
        checks["assetIds"] = asset_ids
        if len(asset_ids) != 2:
            return {"success": False, "reason": "tab-local image rows do not contain exactly two assets", "checks": checks}
        return {"success": True, "checks": checks}

    if case.name == "image_selection_insufficient_metadata":
        evidence_tools = {"get_ax_tree", "read_article", "list_images", "find_elements", "inspect_element"}
        evidence_positions = [
            index for index, item in enumerate(transcript)
            if item.get("type") == "tool" and item.get("name") in evidence_tools
        ]
        collect_positions = [
            index for index, item in enumerate(transcript)
            if item.get("type") == "tool" and item.get("name") == "collect_images"
        ]
        download_positions = [
            index for index, item in enumerate(transcript)
            if item.get("type") == "tool" and item.get("name") == "download_url"
        ]
        checks["imageEvidencePositions"] = evidence_positions
        checks["collectImagePositions"] = collect_positions
        checks["downloadImagePositions"] = download_positions
        if status == "waiting_user":
            wait_tools = [
                str(item.get("name") or "")
                for item in transcript
                if item.get("type") == "tool"
                and item.get("name") in {"ask_user", "wait_for_user"}
                and not item.get("isError")
            ]
            checks["waitTools"] = wait_tools
            if not wait_tools:
                return {"success": False, "reason": "session waited without an explicit user question", "checks": checks}
        if not evidence_positions:
            return {"success": False, "reason": "image evidence was not inspected before declining collection", "checks": checks}
        if collect_positions:
            return {"success": False, "reason": "text-only model collected images without evidence", "checks": checks}
        if download_positions:
            return {"success": False, "reason": "text-only model downloaded image binaries without usable evidence", "checks": checks}
        if rows:
            return {"success": False, "reason": "image table should remain empty when visual selection is impossible", "checks": checks}
        return {"success": True, "checks": checks}

    if case.name == "selector_article_fallback":
        read_args = tool_args_list(transcript, "read_article")
        checks["readArticleUsed"] = bool(read_args)
        checks["readArticleArgs"] = [
            {"source": args.get("source"), "selector": args.get("selector"), "limit": args.get("limit")}
            for args in read_args
        ]
        read_limits = [safe_int(args.get("limit")) for args in read_args]
        checks["readArticleLimits"] = read_limits
        if read_limits and any(value is None or value <= 0 or value > 20000 for value in read_limits):
            return {"success": False, "reason": "read_article did not use an explicit sane limit", "checks": checks}
        dom_args = tool_args_list(transcript, "read_dom")
        checks["readDomUsed"] = bool(dom_args)
        dom_selectors = [str(args.get("selector") or "").strip() for args in dom_args]
        checks["readDomSelectors"] = dom_selectors
        localized_dom = any(selector and selector not in {"body", "css:body"} for selector in dom_selectors)
        if dom_args and not localized_dom:
            return {"success": False, "reason": "read_dom did not use a localized selector for DOM evidence", "checks": checks}
        row_datas = row_data_list(rows)
        topics = {str(data.get("topic") or "").lower() for data in row_datas}
        checks["topics"] = sorted(topics)
        for topic in ("insight_alpha", "insight_beta", "insight_gamma", "article_data_topic", "related_document_href"):
            if topic not in topics:
                return {"success": False, "reason": f"missing article topic {topic}", "checks": checks}
        row_text = json.dumps(row_datas, ensure_ascii=False).lower()
        checks["containsDataTopic"] = "selector-fallback" in row_text
        checks["containsRelatedHref"] = "/docs/sample.txt" in row_text
        if "selector-fallback" not in row_text:
            return {"success": False, "reason": "article data-topic was not stored", "checks": checks}
        if "/docs/sample.txt" not in row_text:
            return {"success": False, "reason": "related document href was not stored", "checks": checks}
        noisy = row_text
        if "advertisement" in noisy or "footer boilerplate" in noisy:
            return {"success": False, "reason": "selector article extraction stored noisy boilerplate", "checks": checks}
        return {"success": True, "checks": checks}

    if case.name == "dynamic_target_recovery":
        checks["findElementsUsed"] = "find_elements" in [
            str(item.get("name") or "") for item in transcript if item.get("type") == "tool"
        ]
        checks["waitForElementUsed"] = "wait_for_element" in [
            str(item.get("name") or "") for item in transcript if item.get("type") == "tool"
        ]
        action_args = tool_args_list(transcript, "act_on_element")
        targets = [str(args.get("target") or "") for args in action_args]
        checks["actTargets"] = targets
        if not targets or any(not (target.startswith("uid:") or target.startswith("css:")) for target in targets):
            return {"success": False, "reason": "act_on_element used a non-machine target", "checks": checks}
        row_datas = row_data_list(rows)
        dynamic_rows = [data for data in row_datas if data.get("check") == "dynamic_saved"]
        checks["dynamicRows"] = dynamic_rows
        if not dynamic_rows:
            return {"success": False, "reason": "missing dynamic_saved data row", "checks": checks}
        data = dynamic_rows[0]
        if str(data.get("value") or "") != "edge-ok" or not truthy(data.get("saved")):
            return {"success": False, "reason": "dynamic saved row does not verify edge-ok", "checks": checks}
        return {"success": True, "checks": checks}

    if case.suite == "base":
        return {
            "success": False,
            "reason": f"base case {case.name} has no task-specific acceptance judge",
            "checks": checks,
        }

    if case.suite == "realworld":
        if len(rows) < case.min_rows:
            return {"success": False, "reason": f"expected at least {case.min_rows} rows", "checks": checks}
        return {"success": True, "checks": checks}

    return {"success": False, "reason": f"unknown case {case.name}", "checks": checks}


async def validate_journey_case(
    client: QingzhouMcpClient,
    case: CaseSpec,
    *,
    session_id: str,
    snapshot: dict[str, Any],
    transcript: list[dict[str, Any]],
    rows: list[dict[str, Any]],
    checks: dict[str, Any],
) -> dict[str, Any]:
    row_datas = row_data_list(rows)

    if case.name == "parallel_subtasks":
        calls = tool_items(transcript, "manage_sessions")
        creates = [parse_tool_args(item) for item in calls if parse_tool_args(item).get("action") == "create"]
        waits = [parse_tool_args(item) for item in calls if parse_tool_args(item).get("action") == "wait"]
        checks["createdSubtasks"] = len(creates)
        checks["waitModes"] = [str(item.get("waitFor") or "all") for item in waits]
        if len(creates) != 3 or any(not str(item.get("firstMessage") or "").strip() for item in creates):
            return failure("expected exactly three dispatched child sessions", checks)
        wait_modes = checks["waitModes"]
        if "any" not in wait_modes or "all" not in wait_modes or wait_modes.index("any") > wait_modes.index("all"):
            return failure("parent did not inspect waitFor:any before waitFor:all", checks)
        actual = {str(data.get("branch") or "").lower(): data for data in row_datas}
        checks["branches"] = sorted(actual)
        if set(actual) != {"alpha", "beta", "gamma"} or len(rows) != 3:
            return failure("parallel summary must contain exactly alpha, beta, and gamma", checks)
        for branch, code in case.expected["codes"].items():
            if str(actual[branch].get("code") or "") != code or str(actual[branch].get("status") or "").lower() != "ready":
                return failure(f"{branch} result was not verified as {code}/ready", checks)
        gamma = actual["gamma"]
        if str(gamma.get("status") or "").lower() != "unavailable" or str(gamma.get("code") or "").strip():
            return failure("unavailable gamma branch was guessed or mislabeled", checks)
        return success(checks)

    if case.name == "absolute_time_alignment":
        waits = tool_items(transcript, "wait_until", successful_only=True)
        relative_waits = tool_items(transcript, "wait")
        checks["absoluteWaitCount"] = len(waits)
        checks["relativeWaitCount"] = len(relative_waits)
        if len(waits) != 1 or relative_waits:
            return failure("absolute task must use one wait_until and no relative wait", checks)
        until = str(parse_tool_args(waits[0]).get("until") or "")
        checks["waitUntil"] = until
        if not same_instant(until, str(case.expected["targetIso"]), tolerance_seconds=1):
            return failure("wait_until target did not match the requested absolute instant", checks)
        result = waits[0].get("result") if isinstance(waits[0].get("result"), dict) else {}
        checks["waitResult"] = {
            "targetAt": result.get("targetAt"),
            "pastDue": result.get("pastDue"),
            "waitedSeconds": result.get("waitedSeconds"),
        }
        if result.get("pastDue") is True:
            return failure("wait_until reported the freshly requested instant as already past due", checks)
        if len(row_datas) != 1 or row_datas[0].get("check") != "exact-ready" or not truthy(row_datas[0].get("reached")):
            return failure("absolute-time result row is not the exact requested payload", checks)
        wait_index = transcript.index(waits[0])
        write_indexes = [
            index for index, item in enumerate(transcript)
            if item.get("type") == "tool"
            and item.get("name") == "data_store"
            and str(parse_tool_args(item).get("action") or "") in {"insert", "upsert", "update", "replace"}
        ]
        if not write_indexes or min(write_indexes) < wait_index:
            return failure("data row was written before wait_until completed", checks)
        return success(checks)

    if case.name == "automation_schedule_creation":
        calls = tool_items(transcript, "manage_sessions")
        create_items = [item for item in calls if parse_tool_args(item).get("action") == "create_automation"]
        checks["automationCreateCount"] = len(create_items)
        if len(create_items) != 1:
            return failure("expected exactly one create_automation call", checks)
        args = parse_tool_args(create_items[0])
        schedule = args.get("schedule") if isinstance(args.get("schedule"), dict) else {}
        instruction = str(args.get("instruction") or "")
        checks["automationRequest"] = {
            "title": args.get("title"),
            "schedule": schedule,
            "missedPolicy": args.get("missedPolicy"),
            "notifyPolicy": args.get("notifyPolicy"),
        }
        if case.expected["titleMarker"] not in str(args.get("title") or ""):
            return failure("automation title lost the requested marker", checks)
        if schedule.get("type") != "daily" or str(schedule.get("time") or "") != "11:55":
            return failure("automation was not saved as a daily 11:55 Beijing schedule", checks)
        if args.get("missedPolicy") != "latest_only" or args.get("notifyPolicy") != "failure":
            return failure("automation missed/notification policies do not match the request", checks)
        required_instruction_fragments = [case.expected["probeUrl"], case.expected["outputTable"], "12:00"]
        if any(fragment not in instruction for fragment in required_instruction_fragments):
            return failure("automation instruction omitted target, output, or 12:00 alignment", checks)
        listed = await client.list_automations()
        automations = listed.get("automations") if isinstance(listed, dict) else []
        matching = [item for item in (automations or []) if case.expected["titleMarker"] in str(item.get("title") or "")]
        checks["persistedAutomationCount"] = len(matching)
        if len(matching) != 1:
            return failure("saved automation was not found exactly once in the repository", checks)
        persisted = matching[0]
        persisted_schedule = persisted.get("schedule") if isinstance(persisted.get("schedule"), dict) else {}
        checks["persistedSchedule"] = persisted_schedule
        if (
            persisted_schedule.get("type") != schedule.get("type")
            or persisted_schedule.get("time") != schedule.get("time")
            or persisted.get("missedPolicy") != "latest_only"
            or persisted.get("notifyPolicy") != "failure"
        ):
            return failure("persisted automation differs from the validated request", checks)
        return success(checks)

    if case.name == "human_clarification_resume":
        submitted = (((snapshot.get("_behaviorDriver") or {}).get("submittedWaits")) or [])
        asks = tool_items(transcript, "ask_user", successful_only=True)
        checks["submittedWaits"] = submitted
        checks["askUserCount"] = len(asks)
        if len(submitted) != 1 or len(asks) != 1:
            return failure("clarification did not suspend once and resume after one submitted form", checks)
        ask_index = transcript.index(asks[0])
        write_indexes = [
            index for index, item in enumerate(transcript)
            if item.get("type") == "tool"
            and item.get("name") == "data_store"
            and str(parse_tool_args(item).get("action") or "") in {"insert", "upsert", "update", "replace"}
        ]
        if not write_indexes or ask_index > min(write_indexes):
            return failure("budget was written before the user supplied the currency", checks)
        if len(row_datas) != 1:
            return failure("clarification task must leave exactly one durable row", checks)
        data = row_datas[0]
        if data.get("project") != "journey" or safe_int(data.get("amount")) != 1000 or str(data.get("currency") or "").upper() != "CNY":
            return failure("resumed task did not persist project=journey, amount=1000, currency=CNY", checks)
        return success(checks)

    if case.name == "skill_settings_validation_recovery":
        skill_name = str(case.expected["skillName"])
        skill = await client.get_skill(skill_name)
        resource = await client.get_skill_resource(skill_name, "plugin.json")
        content = str(skill.get("content") or "") if isinstance(skill, dict) else ""
        checks["skillLoaded"] = isinstance(skill, dict) and skill.get("name") == skill_name
        checks["skillMarkerPresent"] = "harbor-42" in content
        if not checks["skillLoaded"] or not checks["skillMarkerPresent"]:
            return failure("created Skill could not be loaded with its durable marker", checks)
        try:
            manifest = json.loads(str(resource.get("content") or ""))
        except (AttributeError, json.JSONDecodeError):
            return failure("plugin.json could not be read as JSON after creation", checks)
        expected_manifest = case.expected["pluginManifest"]
        checks["pluginId"] = manifest.get("id")
        if manifest.get("id") != expected_manifest["id"] or manifest.get("settings") != expected_manifest["settings"]:
            return failure("persisted plugin settings schema differs from the requested schema", checks)
        setting_calls = tool_items(transcript, "qingzhou_management__manage_skill_settings")
        attempts = [
            (item, parse_tool_args(item)) for item in setting_calls
            if parse_tool_args(item).get("action") == "update"
        ]
        invalid = [item for item, args in attempts if (args.get("values") or {}).get("retryCount") == 99]
        corrected = [item for item, args in attempts if (args.get("values") or {}).get("retryCount") == 5]
        checks["invalidAttemptRejected"] = len(invalid) == 1 and invalid[0].get("isError") is True
        checks["correctedAttemptSucceeded"] = len(corrected) == 1 and corrected[0].get("isError") is not True
        if not checks["invalidAttemptRejected"] or not checks["correctedAttemptSucceeded"]:
            return failure("Agent did not recover from the intentional retryCount=99 validation error", checks)
        listed = await client.list_skill_settings()
        settings = listed.get("settings") if isinstance(listed, dict) else []
        matches = [item for item in (settings or []) if item.get("skillName") == skill_name]
        if len(matches) != 1:
            return failure("created Skill settings were not discoverable through the shared settings service", checks)
        fields = matches[0].get("fields") or []
        by_key = {str(field.get("key") or ""): field for field in fields}
        checks["storedRetryCount"] = by_key.get("retryCount", {}).get("value")
        checks["secretHasValue"] = by_key.get("apiToken", {}).get("hasValue")
        if safe_int(checks["storedRetryCount"]) != 5 or checks["secretHasValue"] is not True:
            return failure("corrected setting or secret presence was not durably stored", checks)
        # The owner-facing settings service includes editable secret values. Check
        # redaction at the model's public read boundary, not the administrative readback.
        public_reads = [
            item for item in setting_calls
            if item.get("isError") is not True and parse_tool_args(item).get("action") in {"list", "get"}
        ]
        checks["publicSettingsReadCount"] = len(public_reads)
        if not public_reads:
            return failure("settings were not read back through the model's public tools", checks)
        checks["secretExposedBySettingsRead"] = any(
            case.expected["secret"] in json.dumps(item.get("result"), ensure_ascii=False)
            for item in public_reads
        )
        checks["secretEchoedByAssistant"] = any(
            case.expected["secret"] in str(item.get("content") or "")
            for item in transcript if item.get("type") == "assistant"
        )
        if checks["secretExposedBySettingsRead"]:
            return failure("secret value was exposed by the model's public settings read tool", checks)
        if checks["secretEchoedByAssistant"]:
            return failure("assistant repeated the secret despite the user's instruction", checks)
        return success(checks)

    if case.name == "browser_library_workflow":
        expected = case.expected
        errors: list[str] = []
        history_results = flatten_tool_results(transcript, "browse_history")
        checks["historyMatched"] = any(expected["libraryUrl"] == str(item.get("url") or "") for item in history_results)
        if not checks["historyMatched"]:
            errors.append("opened library page was not verified through browser history")
        bookmark_calls = tool_items(transcript, "manage_bookmarks", successful_only=True)
        creates = [parse_tool_args(item) for item in bookmark_calls if parse_tool_args(item).get("action") == "create"]
        folder_creates = [args for args in creates if not args.get("url")]
        link_creates = [args for args in creates if args.get("url")]
        checks["bookmarkCreateCount"] = len(creates)
        if len(folder_creates) != 1 or len(link_creates) != 1:
            errors.append("expected exactly one bookmark folder and one bookmark creation")
        elif (
            link_creates[0].get("title") != expected["bookmarkTitle"]
            or link_creates[0].get("url") != expected["libraryUrl"]
            or not link_creates[0].get("parentId")
        ):
            errors.append("bookmark was not created under the new folder with the requested title")
        download_calls = tool_items(transcript, "download_url", successful_only=True)
        expected_download_id: Any = None
        if len(download_calls) != 1:
            errors.append("expected exactly one successful download_url call")
        else:
            download_args = parse_tool_args(download_calls[0])
            download_result = download_calls[0].get("result") if isinstance(download_calls[0].get("result"), dict) else {}
            expected_download_id = download_result.get("downloadId")
            if download_args.get("url") != expected["reportUrl"] or download_args.get("filename") != expected["downloadFilename"]:
                errors.append("download URL or filename differs from the requested report")
            if expected_download_id is None:
                errors.append("download_url did not return a stable downloadId")
            if download_result.get("artifactRecorded") is not True:
                errors.append("download_url did not confirm the task artifact registration path")
        downloads = flatten_tool_results(transcript, "list_downloads")
        download_status_calls = tool_items(transcript, "list_downloads", successful_only=True)
        checks["downloadStatusQueries"] = [parse_tool_args(item) for item in download_status_calls]
        download_call_index = transcript.index(download_calls[0]) if len(download_calls) == 1 else -1
        exact_status_calls = [
            item for item in download_status_calls
            if expected_download_id is not None
            and str(parse_tool_args(item).get("id")) == str(expected_download_id)
            and transcript.index(item) > download_call_index
        ]
        if not exact_status_calls:
            errors.append("download completion was not queried after download by the returned downloadId")
        matching_downloads = {
            str(item.get("id")): item
            for item in downloads
            if expected_download_id is not None and str(item.get("id")) == str(expected_download_id)
        }
        checks["matchingDownloads"] = list(matching_downloads.values())
        if len(matching_downloads) != 1 or next(iter(matching_downloads.values())).get("state") != "complete":
            errors.append("download was not verified as complete by downloadId")
        artifacts = snapshot.get("artifacts") if isinstance(snapshot.get("artifacts"), dict) else {}
        files = artifacts.get("files") if isinstance(artifacts, dict) else []
        matching_artifacts = [
            item for item in (files or [])
            if item.get("filename") == expected["downloadFilename"]
            and expected_download_id is not None
            and str(item.get("downloadId")) == str(expected_download_id)
        ]
        checks["matchingFileArtifacts"] = len(matching_artifacts)
        if len(matching_artifacts) != 1:
            errors.append("download did not become exactly one reusable task artifact")
        if errors:
            return failure("; ".join(errors), checks)
        return success(checks)

    if case.name in {"foreground_alert_decision", "background_alert_decision"}:
        alerts = tool_items(transcript, "send_alert", successful_only=True)
        expected_count = int(case.expected["alertCount"])
        checks["alertCount"] = len(alerts)
        if len(alerts) != expected_count:
            return failure(f"expected {expected_count} local alert calls, got {len(alerts)}", checks)
        if alerts:
            marker = str(case.expected.get("marker") or "")
            args = parse_tool_args(alerts[0])
            result = alerts[0].get("result") if isinstance(alerts[0].get("result"), dict) else {}
            if marker not in str(args.get("message") or "") or result.get("sent") is not True:
                return failure("background alert was missing its marker or was not actually sent", checks)
        return success(checks)

    if case.name.startswith("visual_ui_"):
        screenshots = tool_items(transcript, "screenshot", successful_only=True)
        action_counts = Counter(
            str(parse_tool_args(item).get("action") or "")
            for item in tool_items(transcript, "act_on_screen", successful_only=True)
        )
        required_counts = case.expected["requiredActionCounts"]
        checks["screenActionCounts"] = dict(action_counts)
        checks["requiredScreenActionCounts"] = required_counts
        for action, minimum in required_counts.items():
            if action_counts[action] < int(minimum):
                return failure(f"visual UI task did not perform {action} at least {minimum} time(s)", checks)

        if case.name == "visual_ui_form":
            presses = [
                item for item in tool_items(transcript, "act_on_screen", successful_only=True)
                if str(parse_tool_args(item).get("action") or "") == "press"
            ]
            checks["screenshotCount"] = len(screenshots)
            checks["pressCount"] = len(presses)
            if not presses:
                return failure("visual keyboard submit did not press Enter", checks)
            submit_press = presses[-1]
            submit_press_index = next(index for index, item in enumerate(transcript) if item is submit_press)
            checks["screenshotsBeforePress"] = len(tool_items(
                transcript[:submit_press_index], "screenshot", successful_only=True,
            ))
            if checks["screenshotsBeforePress"] != 1:
                return failure("visual keyboard submit must not capture an extra input screenshot before press", checks)
            press_args = parse_tool_args(submit_press)
            press_result = submit_press.get("result") if isinstance(submit_press.get("result"), dict) else {}
            checks["pressKey"] = press_args.get("key")
            checks["pressHasCoordinates"] = press_args.get("x") is not None or press_args.get("y") is not None
            checks["pressSourceScreenshotId"] = press_result.get("sourceScreenshotId")
            if press_args.get("key") != "Enter" or checks["pressHasCoordinates"]:
                return failure("visual keyboard submit must use a coordinate-free Enter press", checks)
            if press_result.get("sourceScreenshotId") is not None or press_result.get("sourceCoordinateSpace") is not None:
                return failure("visual keyboard submit still depended on an input screenshot", checks)

        ui_state = FixtureHandler.visual_ui_state(str(case.expected["stateKey"]))
        checks["uiState"] = ui_state
        if ui_state.get("status") != "completed" or ui_state.get("receipt") != case.expected["receipt"]:
            return failure("visual UI did not reach the expected browser-side completion state", checks)

        if len(row_datas) != 1:
            return failure("visual UI task must leave exactly one verification row", checks)
        data = row_datas[0]
        if (
            data.get("check") != case.expected["check"]
            or data.get("receipt") != case.expected["receipt"]
            or not truthy(data.get("verified"))
        ):
            return failure("visual UI verification row does not match the confirmed page receipt", checks)
        return success(checks)

    if case.name == "visual_canvas_inspection":
        screenshots = tool_items(transcript, "screenshot", successful_only=True)
        checks["screenshotCount"] = len(screenshots)
        if not screenshots:
            return failure("visual-only page was answered without screenshot evidence", checks)
        if len(row_datas) != 1:
            return failure("visual task must leave exactly one verification row", checks)
        data = row_datas[0]
        if data.get("check") != "canvas-layout" or data.get("answer") != case.expected["answer"] or not truthy(data.get("verified")):
            return failure("visual conclusion does not match the rendered canvas", checks)
        return success(checks)

    return failure(f"journey case {case.name} has no task-specific acceptance judge", checks)


def success(checks: dict[str, Any]) -> dict[str, Any]:
    return {"success": True, "checks": checks}


def failure(reason: str, checks: dict[str, Any]) -> dict[str, Any]:
    return {"success": False, "reason": reason, "checks": checks}


def data_store_actions(transcript: list[dict[str, Any]]) -> list[str]:
    actions: list[str] = []
    for item in transcript:
        if item.get("type") != "tool" or item.get("name") != "data_store":
            continue
        args = parse_tool_args(item)
        action = str(args.get("action") or "").strip()
        if action:
            actions.append(action)
    return actions


def has_data_store_row_state(
    transcript: list[dict[str, Any]],
    *,
    name: str,
    expected: dict[str, Any],
    actions: set[str],
) -> bool:
    for item in transcript:
        if item.get("type") != "tool" or item.get("name") != "data_store":
            continue
        args = parse_tool_args(item)
        if str(args.get("action") or "").strip() not in actions:
            continue
        candidates = []
        if isinstance(args.get("data"), dict):
            candidates.append(args["data"])
        candidates.extend(row for row in args.get("rows") or [] if isinstance(row, dict))
        result = item.get("result") if isinstance(item.get("result"), dict) else {}
        for result_row in (result.get("row"), result.get("deletedRow")):
            if isinstance(result_row, dict):
                candidates.append(result_row.get("data") if isinstance(result_row.get("data"), dict) else result_row)
        for result_row in result.get("rowsSample") or []:
            if isinstance(result_row, dict):
                candidates.append(result_row.get("data") if isinstance(result_row.get("data"), dict) else result_row)
        for row in candidates:
            if str(row.get("name") or "") != name:
                continue
            if all(row.get(key) == value for key, value in expected.items()):
                return True
    return False


def unrecovered_tool_calls(transcript: list[dict[str, Any]]) -> list[dict[str, Any]]:
    tool_calls = [item for item in transcript if item.get("type") == "tool"]
    unrecovered: list[dict[str, Any]] = []
    for index, item in enumerate(tool_calls):
        if not item.get("isError"):
            continue
        name = str(item.get("name") or "")
        recovery_key = tool_recovery_key(name)
        recovered = any(
            tool_recovery_key(str(later.get("name") or "")) == recovery_key and not later.get("isError")
            for later in tool_calls[index + 1:]
        )
        if not recovered:
            unrecovered.append(item)
    return unrecovered


def tool_recovery_key(name: str) -> str:
    return TOOL_RECOVERY_KEYS.get(name, name)


def manage_goal_actions(transcript: list[dict[str, Any]]) -> list[str]:
    actions: list[str] = []
    for item in transcript:
        if item.get("type") != "tool" or item.get("name") != "manage_goal":
            continue
        args = parse_tool_args(item)
        action = str(args.get("action") or "").strip()
        if action:
            actions.append(action)
    return actions


def extract_run_script_timeouts(transcript: list[dict[str, Any]]) -> list[int | None]:
    values: list[int | None] = []
    for item in transcript:
        if item.get("type") != "tool" or item.get("name") != "run_script":
            continue
        args = parse_tool_args(item)
        raw = args.get("timeout")
        if raw is None:
            raw = args.get("timeoutSeconds")
        if raw is None:
            values.append(None)
            continue
        try:
            values.append(int(raw))
        except Exception:
            values.append(None)
    return values


def tool_args_list(transcript: list[dict[str, Any]], tool_name: str) -> list[dict[str, Any]]:
    return [
        parse_tool_args(item)
        for item in transcript
        if item.get("type") == "tool" and item.get("name") == tool_name
    ]


def tool_items(
    transcript: list[dict[str, Any]],
    tool_name: str,
    *,
    successful_only: bool = False,
) -> list[dict[str, Any]]:
    return [
        item for item in transcript
        if item.get("type") == "tool"
        and item.get("name") == tool_name
        and (not successful_only or not item.get("isError"))
    ]


def tool_result_list(transcript: list[dict[str, Any]], tool_name: str) -> list[dict[str, Any]]:
    return [
        item.get("result") if isinstance(item.get("result"), dict) else {}
        for item in transcript
        if item.get("type") == "tool" and item.get("name") == tool_name
    ]


def flatten_tool_results(transcript: list[dict[str, Any]], tool_name: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for item in tool_items(transcript, tool_name, successful_only=True):
        result = item.get("result")
        if isinstance(result, list):
            out.extend(value for value in result if isinstance(value, dict))
        elif isinstance(result, dict):
            for key in ("items", "rows", "results", "downloads"):
                values = result.get(key)
                if isinstance(values, list):
                    out.extend(value for value in values if isinstance(value, dict))
                    break
            else:
                out.append(result)
    return out


def map_wait_answers(form: dict[str, Any], requested: dict[str, Any]) -> dict[str, Any]:
    fields = form.get("fields") if isinstance(form.get("fields"), list) else []
    field_entries = [
        (str(field.get("id") or "").strip(), field)
        for field in fields
        if isinstance(field, dict) and str(field.get("id") or "").strip()
    ]
    field_ids = [field_id for field_id, _field in field_entries]
    answers: dict[str, Any] = {}
    for key, value in requested.items():
        if key in field_ids:
            answers[key] = value
            continue
        matching = [
            field_id for field_id, field in field_entries
            if str(key).lower() in " ".join([
                field_id,
                str(field.get("label") or ""),
                str(field.get("help") or ""),
            ]).lower()
        ]
        if len(matching) == 1:
            answers[matching[0]] = value
        elif len(field_ids) == 1 and len(requested) == 1:
            answers[field_ids[0]] = value
        else:
            raise RuntimeError(f"unable to map requested wait answer {key!r} to form fields {field_ids}")
    if not answers:
        raise RuntimeError("wait form exposed no answerable fields")
    return answers


def same_instant(left: str, right: str, *, tolerance_seconds: float = 0) -> bool:
    try:
        left_time = datetime.fromisoformat(str(left).strip().replace("Z", "+00:00"))
        right_time = datetime.fromisoformat(str(right).strip().replace("Z", "+00:00"))
    except ValueError:
        return False
    if left_time.tzinfo is None or right_time.tzinfo is None:
        return False
    return abs((left_time - right_time).total_seconds()) <= tolerance_seconds


def tool_page_path(item: dict[str, Any]) -> str:
    result = item.get("result") if isinstance(item.get("result"), dict) else {}
    raw_url = result.get("_pageUrl") or result.get("pageUrl") or result.get("url") or ""
    return urlparse(str(raw_url)).path if raw_url else ""


def tool_effective_tab_id(item: dict[str, Any]) -> int | None:
    args = parse_tool_args(item)
    result = item.get("result") if isinstance(item.get("result"), dict) else {}
    for value in (args.get("tabId"), args.get("_tabId"), result.get("_tabId"), result.get("tabId")):
        tab_id = safe_int(value)
        if tab_id is not None:
            return tab_id
    return None


def tool_page_reference(item: dict[str, Any]) -> str | int | None:
    args = parse_tool_args(item)
    return args.get("tabRef", tool_effective_tab_id(item))


def row_data_list(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for row in rows:
        data = row.get("data")
        if isinstance(data, dict):
            out.append(data)
        elif isinstance(row, dict):
            out.append(row)
    return out


def summarize_image_selections(args: dict[str, Any]) -> dict[str, Any]:
    targets = [str(item).strip() for item in (args.get("targets") or []) if str(item).strip()]
    urls = [str(item).strip() for item in (args.get("urls") or []) if str(item).strip()]
    legacy_fields = sorted(key for key in ("indexes", "selector", "limit", "minWidth", "minHeight", "visibleOnly") if key in args)
    return {
        "targetCount": len(targets),
        "urlCount": len(urls),
        "legacyFields": legacy_fields,
    }


def safe_int(value: Any) -> int | None:
    if value is None:
        return None
    try:
        return int(value)
    except Exception:
        return None


def truthy(value: Any) -> bool:
    if value is True:
        return True
    if isinstance(value, (int, float)) and value:
        return True
    if isinstance(value, str):
        return value.strip().lower() in {"true", "1", "yes", "y", "ok", "matched", "success", "succeeded"}
    return False


def network_evidence(value: Any) -> bool:
    if truthy(value):
        return True
    text = str(value or "").strip().lower()
    return bool(re.search(r"(?:/api/search|matched|success).*(?:2\d\d|ok)|(?:2\d\d|ok).*(?:/api/search|matched|success)", text))


def console_evidence(value: Any) -> bool:
    if truthy(value):
        return True
    text = str(value or "").strip().lower()
    return "fixture search" in text and ("submit" in text or "rendered" in text)


def parse_tool_args(item: dict[str, Any]) -> dict[str, Any]:
    args = item.get("args")
    if isinstance(args, dict):
        return args
    if isinstance(args, str) and args.strip():
        with contextlib.suppress(Exception):
            return json.loads(args)
    args_text = item.get("argsText")
    if isinstance(args_text, str) and args_text.strip():
        with contextlib.suppress(Exception):
            return json.loads(args_text)
    return {}
