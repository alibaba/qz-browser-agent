from __future__ import annotations

import asyncio
import json
import sys
from copy import deepcopy
from dataclasses import replace
from datetime import datetime, timezone
from http.client import HTTPConnection
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "background"))
from agent_behavior import acceptance, capture as case_capture, cases, fixtures, reporting, runner
from agent_behavior.client import QingzhouMcpClient


def test_data_readback_owns_one_drive_session_and_never_reuses_native_authority():
    class RecordingClient(QingzhouMcpClient):
        def __init__(self):
            super().__init__(None)
            self.calls = []
            self.active = 0

        async def call(self, name, args):
            self.calls.append((name, args))
            if name == "qingzhou_create_drive_session":
                await asyncio.sleep(0)
                return {"sessionId": "readback-drive"}
            if name == "qingzhou_execute_tool":
                self.active += 1
                assert self.active == 1, "readbacks sharing a drive session must serialize"
                await asyncio.sleep(0)
                self.active -= 1
                return {"result": {"rows": [{"table": args["args"].get("table")}]}}
            return {}

    async def scenario():
        client = RecordingClient()
        results = await asyncio.gather(
            client.data_store_list("first", session_id="native-one"),
            client.data_store_list("second", session_id="native-two"),
        )
        assert [result["rows"][0]["table"] for result in results] == ["first", "second"]
        assert [name for name, _ in client.calls].count("qingzhou_create_drive_session") == 1
        for name, args in client.calls[1:]:
            assert name == "qingzhou_execute_tool"
            assert args["sessionId"] == "readback-drive"
            assert args["name"] == "data_store" and args["args"]["action"] == "list"
        await client.execute_tool("read_article", {"tabRef": "page"}, session_id="native-one")
        assert client.calls[-1][1]["sessionId"] == "native-one", "generic tool calls retain their caller's authority"
        await client.aclose()
        await client.aclose()
        assert client.calls[-1] == ("qingzhou_stop_session", {"sessionId": "readback-drive", "cascade": True})
        assert [name for name, _ in client.calls].count("qingzhou_stop_session") == 1

    asyncio.run(scenario())


def test_data_readback_failure_releases_the_lock_and_keeps_cleanup_available():
    class FailingClient(QingzhouMcpClient):
        def __init__(self):
            super().__init__(None)
            self.calls = []

        async def call(self, name, args):
            self.calls.append((name, args))
            if name == "qingzhou_create_drive_session":
                return {"sessionId": "readback-drive"}
            if name == "qingzhou_execute_tool":
                raise RuntimeError("readback unavailable")
            return {}

    async def scenario():
        client = FailingClient()
        for _ in range(2):
            try:
                await client.data_store_list("first", session_id="native-one")
            except RuntimeError as error:
                assert str(error) == "readback unavailable"
            else:
                raise AssertionError("readback failure must reach acceptance and capture")
        await client.aclose()
        assert [name for name, _ in client.calls].count("qingzhou_create_drive_session") == 1
        assert client.calls[-1][0] == "qingzhou_stop_session"

    asyncio.run(scenario())


def test_skill_settings_readback_uses_read_only_management_transport():
    class RecordingClient(QingzhouMcpClient):
        def __init__(self):
            super().__init__(None)
            self.calls = []
            self.response = {"type": "skill_settings", "settings": [{"fields": [{"key": "retryCount", "value": 5}]}]}

        async def call(self, name, args):
            self.calls.append((name, args))
            return {"response": self.response}

    async def scenario():
        client = RecordingClient()
        assert await client.list_skill_settings() == client.response
        assert client.calls == [("qingzhou_call", {
            "method": "runtime_message",
            "params": {"message": {"type": "list_skill_settings"}, "expectedType": "skill_settings"},
        })]
        for response in ({"type": "error"}, None):
            client.response = response
            try:
                await client.list_skill_settings()
            except RuntimeError as error:
                assert "not acknowledged" in str(error)
            else:
                raise AssertionError("an absent settings reply must not become successful readback")

    asyncio.run(scenario())


def test_navigation_redirect_preserves_query_values_in_one_header():
    query = "key=first&key=second&empty=&note=a%0D%0AX-QZ-Injected%3A+yes"
    with fixtures.fixture_server() as origin:
        connection = HTTPConnection(urlsplit(origin).netloc, timeout=5)
        try:
            connection.request("GET", f"/navigation/redirect?{query}")
            response = connection.getresponse()
            assert response.status == 302
            location = response.getheader("Location")
            assert response.getheader("X-QZ-Injected") is None
            assert "\r" not in location and "\n" not in location
            assert parse_qsl(urlsplit(location).query, keep_blank_values=True) == parse_qsl(query, keep_blank_values=True)
            response.read()
        finally:
            connection.close()


class FakeClient:
    def __init__(self, rows, *, automations=None, skill=None, resource=None, skill_settings=None, tool_results=None, snapshots=None):
        self.rows = rows
        self.automations = automations or {"automations": [], "runs": {}}
        self.skill = skill or {}
        self.resource = resource or {}
        self.skill_settings = skill_settings or {}
        self.tool_results = tool_results or {}
        self.snapshots = snapshots or {}

    async def data_store_list(self, _table, *, session_id=""):
        return {"rows": self.rows, "totalRows": len(self.rows), "sessionId": session_id}

    async def list_automations(self):
        return self.automations

    async def get_skill(self, _name):
        return self.skill

    async def get_skill_resource(self, _name, _path):
        return self.resource

    async def list_skill_settings(self):
        return self.skill_settings

    async def execute_tool(self, name, args, *, session_id=""):
        return self.tool_results.get((name, args.get("action")), {})

    async def snapshot(self, session_id, *, num=500):
        return self.snapshots.get(session_id, {})


def tool(name, args=None, result=None, *, is_error=False):
    return {
        "type": "tool",
        "name": name,
        "args": args or {},
        "result": {} if result is None else result,
        "phase": "completed",
        "isError": is_error,
    }


def validate(case, rows, transcript):
    return asyncio.run(acceptance.validate_case(
        FakeClient(rows),
        case,
        "test-run",
        "test-session",
        {"status": "completed", "transcript": transcript},
        False,
        "",
    ))


def case(name, required_tools=(), *, suite="base", table="acceptance_table", expected=None):
    return cases.CaseSpec(
        name=name,
        suite=suite,
        title=f"acceptance/{name}",
        timeout_seconds=1,
        table=table,
        prompt="test",
        min_rows=1,
        required_tools=tuple(required_tools),
        journey_ids=("A19",),
        expected=expected or {},
    )


def validate_journey(case_spec, rows, transcript, *, client=None, snapshot=None):
    client = client or FakeClient(rows)
    value = {"status": "completed", "transcript": transcript}
    value.update(snapshot or {})
    return asyncio.run(acceptance.validate_case(
        client,
        case_spec,
        "test-run",
        "test-session",
        value,
        False,
        "",
    ))


def journey(name, base_url="http://127.0.0.1:9911", run_tag="acceptance"):
    return next(item for item in cases.build_journey_cases(base_url, run_tag) if item.name == name)


def vision_journey(name, base_url="http://127.0.0.1:9911", run_tag="acceptance"):
    return next(item for item in cases.build_vision_cases(base_url, run_tag) if item.name == name)


def test_completed_tools_and_rows_cannot_make_an_unknown_base_case_pass():
    result = validate(
        case("new_unjudged_case", ("data_store",)),
        [{"data": {"anything": "looks successful"}}],
        [tool("data_store", {"action": "list"})],
    )

    assert result["success"] is False
    assert "no task-specific acceptance judge" in result["reason"]


def test_navigation_judge_requires_each_first_read_without_waits_or_recovery():
    for mode, watch in (("plain", False), ("watched", True)):
        spec = next(item for item in cases.build_base_cases("http://fixture.test", "navigation")
                    if item.name == f"navigation_readiness_{mode}")
        receipts = {"open": "QZ-first-1", "navigate": "QZ-second-1", "reload": "QZ-second-2", "redirect": "QZ-landed-1"}
        rows = [{"data": {"step": step, "receipt": receipt}} for step, receipt in receipts.items()]
        transcript = []
        for step, receipt in receipts.items():
            transcript.extend([
                tool("open_tab" if step == "open" else "navigate",
                     {"tabId": 42, "url": "http://fixture.test/second", "watchNetwork": watch}, {"id": 42}),
                tool("read_article", {"tabId": 42}, {"text": receipt}),
            ])
        transcript.extend([
            tool("network_recent", result={"items": [{"url": "http://fixture.test/navigation/first"}]}),
            tool("data_store"),
        ])
        assert validate(spec, rows, transcript)["success"] is True
        for reference in (42, "42", "research"):
            public = deepcopy(transcript)
            public[0]["result"] = {"tabRef": reference}
            for item in public[:8]:
                item["args"].pop("tabId", None)
                if item["name"] != "open_tab":
                    item["args"]["tabRef"] = reference
            assert validate(spec, rows, public)["success"] is True, reference
            public[3]["args"]["tabRef"] = "different-page"
            assert validate(spec, rows, public)["success"] is False, "public refs must still identify one page"
        for fault in ("old_document", "wait", "recovered_error", "wrong_tab", "missed_network"):
            broken = deepcopy(transcript)
            if fault == "old_document":
                broken[5]["result"]["text"] = "QZ-second-1"
            elif fault == "wait":
                broken.insert(1, tool("wait"))
            elif fault == "recovered_error":
                broken.insert(1, tool("read_article", is_error=True))
            elif fault == "wrong_tab":
                broken[3]["args"]["tabId"] = 99
            elif watch:
                broken[8]["result"] = {"items": []}
            else:
                continue
            assert validate(spec, rows, broken)["success"] is False, fault


def test_script_collection_accepts_default_timeout_but_checks_both_pages_business_data():
    spec = next(item for item in cases.build_base_cases("http://fixture.test", "script")
                if item.name == "run_script_collection")
    assert "run_script" in spec.prompt and "tools.evaluate" in spec.prompt
    rows = [{"data": {"sku": sku, "name": name, "price": price, "page": page,
                       "url": f"http://fixture.test/catalog?page={page}"}}
            for page, items in fixtures.CATALOG.items() for sku, name, price in items]
    for args in ({}, {"timeout": 120}, {"timeout": 0.5}):
        transcript = [tool("open_tab"), tool("run_script", args), tool("data_store")]
        assert validate(spec, rows, transcript)["success"] is True
        wrong = deepcopy(rows)
        wrong[-1]["data"]["page"] = 1
        assert validate(spec, wrong, transcript)["success"] is False
        assert validate(spec, rows[:-1], transcript)["success"] is False


def test_web_judge_rejects_three_rows_from_the_wrong_page():
    required = ("open_tab", "get_ax_tree", "act_on_element", "data_store")
    transcript = [tool(name) for name in required]
    wrong_rows = [
        {"data": {"title": title, "author": author, "url": f"/news/{story_id}", "page": 1}}
        for story_id, title, author in fixtures.NEWS[1]
    ]
    result = validate(case("web_explore_click", required), wrong_rows, transcript)

    assert result["success"] is False
    assert "page-2 news titles" in result["reason"]


def test_web_judge_accepts_only_the_exact_second_page_payload():
    required = ("open_tab", "get_ax_tree", "act_on_element", "data_store")
    transcript = [tool(name) for name in required]
    rows = [
        {"data": {"title": title, "author": author, "url": f"https://fixture.test/news/{story_id}", "page": 2}}
        for story_id, title, author in fixtures.NEWS[2]
    ]
    result = validate(case("web_explore_click", required), rows, transcript)

    assert result["success"] is True


def test_current_page_environment_judge_requires_real_reads_without_transferring_tab():
    spec = next(
        item for item in cases.build_base_cases("http://fixture.test", "environment")
        if item.name == "current_page_environment_handoff"
    )
    visible_tab_id = 41
    working_tab_id = 42
    owner_session_id = "visible-owner"
    rows = [
        {"data": {
            "pageRole": expected["pageRole"],
            "marker": expected["marker"],
            "title": expected["title"],
            "url": f"http://fixture.test{expected['path']}",
        }}
        for expected in (spec.expected["visible"], spec.expected["working"])
    ]
    transcript = [
        tool("read_article", {"tabId": visible_tab_id}, {
            "_tabId": visible_tab_id,
            "_pageUrl": "http://fixture.test/environment/visible",
        }),
        tool("read_article", {"tabId": working_tab_id}, {
            "_tabId": working_tab_id,
            "_pageUrl": "http://fixture.test/environment/working",
        }),
        tool("data_store", {"action": "upsert"}),
        tool("data_store", {"action": "list"}),
    ]
    snapshot = {
        "status": "completed",
        "runtime": {"workingTabId": working_tab_id, "ownedTabIds": [working_tab_id]},
        "transcript": transcript,
        "_behaviorDriver": {"environmentSetup": {
            "visibleOwnerSessionId": owner_session_id,
            "visibleTabId": visible_tab_id,
            "workingTabId": working_tab_id,
        }},
    }
    client = FakeClient(
        rows,
        snapshots={owner_session_id: {
            "runtime": {"workingTabId": visible_tab_id, "ownedTabIds": [visible_tab_id]},
        }},
        tool_results={("list_tabs", None): [
            {
                "id": visible_tab_id,
                "url": "http://fixture.test/environment/visible",
                "active": True,
                "ownerSessionId": owner_session_id,
            },
            {
                "id": working_tab_id,
                "url": "http://fixture.test/environment/working",
                "active": False,
                "ownedByCurrentTask": True,
                "isWorkingTab": True,
            },
        ]},
    )

    result = asyncio.run(acceptance.validate_case(
        client,
        spec,
        "test-run",
        "subject-session",
        snapshot,
        False,
        "",
    ))

    assert result["success"] is True, result


def test_no_working_tab_environment_accepts_normal_empty_getter_result():
    spec = next(
        item for item in cases.build_base_cases("http://fixture.test", "no-working")
        if item.name == "no_working_tab_environment"
    )
    visible_tab_id = 45
    owner_session_id = "visible-owner"
    expected = spec.expected["visible"]
    rows = [{"data": {
        "check": "no-working-page-context",
        "hasWorkingTab": False,
        "pageRole": expected["pageRole"],
        "marker": expected["marker"],
        "title": expected["title"],
        "url": f"http://fixture.test{expected['path']}",
    }}]
    transcript = [
        tool("get_working_tab", result={"hasWorkingTab": False}),
        tool("read_article", {"tabId": visible_tab_id}, {
            "_tabId": visible_tab_id,
            "_pageUrl": "http://fixture.test/environment/visible",
        }),
        tool("data_store", {"action": "upsert"}),
    ]
    snapshot = {
        "status": "completed",
        "runtime": {"workingTabId": None, "ownedTabIds": []},
        "transcript": transcript,
        "_behaviorDriver": {"environmentSetup": {
            "visibleOwnerSessionId": owner_session_id,
            "visibleTabId": visible_tab_id,
            "workingTabId": None,
        }},
    }
    client = FakeClient(
        rows,
        snapshots={owner_session_id: {
            "runtime": {"workingTabId": visible_tab_id, "ownedTabIds": [visible_tab_id]},
        }},
        tool_results={("list_tabs", None): [{
            "id": visible_tab_id,
            "url": "http://fixture.test/environment/visible",
            "active": True,
            "ownerSessionId": owner_session_id,
        }]},
    )

    result = asyncio.run(acceptance.validate_case(
        client,
        spec,
        "test-run",
        "subject-session",
        snapshot,
        False,
        "",
    ))

    assert result["success"] is True, result


def test_current_page_environment_judge_rejects_page_lifecycle_shortcut():
    spec = next(
        item for item in cases.build_base_cases("http://fixture.test", "environment-shortcut")
        if item.name == "current_page_environment_handoff"
    )
    visible_tab_id = 51
    working_tab_id = 52
    owner_session_id = "visible-owner"
    rows = [
        {"data": {
            "pageRole": expected["pageRole"],
            "marker": expected["marker"],
            "title": expected["title"],
            "url": f"http://fixture.test{expected['path']}",
        }}
        for expected in (spec.expected["visible"], spec.expected["working"])
    ]
    transcript = [
        tool("read_article", {"tabId": visible_tab_id}, {"_tabId": visible_tab_id}),
        tool("use_tab", {"tabId": visible_tab_id}),
        tool("read_article", {"tabId": working_tab_id}, {"_tabId": working_tab_id}),
        tool("data_store", {"action": "list"}),
    ]
    snapshot = {
        "status": "completed",
        "runtime": {"workingTabId": working_tab_id, "ownedTabIds": [working_tab_id]},
        "transcript": transcript,
        "_behaviorDriver": {"environmentSetup": {
            "visibleOwnerSessionId": owner_session_id,
            "visibleTabId": visible_tab_id,
            "workingTabId": working_tab_id,
        }},
    }
    client = FakeClient(rows)

    result = asyncio.run(acceptance.validate_case(
        client,
        spec,
        "test-run",
        "subject-session",
        snapshot,
        False,
        "",
    ))

    assert result["success"] is False
    assert "lifecycle tools" in result["reason"]


def test_document_judge_requires_durable_identifiers_and_tool_order():
    required = (
        "load_skill",
        "qingzhou_documents__document_fetch",
        "qingzhou_documents__document_parse",
        "qingzhou_documents__document_read_chunk",
        "qingzhou_documents__document_create",
        "data_store",
    )
    transcript = [tool(name) for name in required]
    incomplete = validate(
        case("document_pipeline", required),
        [{"data": {"step": "document_pipeline_completed", "fileId": "file", "docModelId": "model"}}],
        transcript,
    )
    complete = validate(
        case("document_pipeline", required),
        [{"data": {
            "step": "document_pipeline_completed",
            "fileId": "file",
            "docModelId": "model",
            "artifactId": "artifact",
        }}],
        transcript,
    )

    assert incomplete["success"] is False
    assert "identifiers are incomplete" in incomplete["reason"]
    assert complete["success"] is True


def test_agent_cases_are_mapped_back_to_product_journeys():
    base = cases.build_base_cases("http://127.0.0.1:1", "mapping")
    realworld = cases.build_realworld_cases("mapping")
    journeys = cases.build_journey_cases("http://127.0.0.1:1", "mapping")
    vision = cases.build_vision_cases("http://127.0.0.1:1", "mapping")

    all_cases = [*base, *journeys, *vision, *realworld]
    assert all(case_spec.journey_ids for case_spec in all_cases)
    assert all(all(journey_id.startswith("A") for journey_id in case_spec.journey_ids) for case_spec in all_cases)
    assert any("A19" in case_spec.journey_ids for case_spec in base)


def test_journey_prompts_express_user_tasks_without_prescribing_tool_calls():
    specs = cases.build_journey_cases("http://127.0.0.1:9911", "prompt")
    forbidden = {
        "manage_sessions(",
        "wait_until(",
        "ask_user(",
        "load_skill(",
        "open_tab(",
        "send_alert(",
        "data_store(",
    }
    for spec in specs:
        assert not any(token in spec.prompt for token in forbidden), spec.name


def test_visual_ui_journeys_require_real_page_receipts_and_expected_screen_actions():
    action_sequences = {
        "visual_ui_form": ({"action": "type"}, {"action": "press", "key": "Enter"}),
        "visual_ui_click": ({"action": "click"}, {"action": "click"}),
        "visual_ui_drag": ({"action": "drag"}, {"action": "click"}),
        "visual_ui_scroll": ({"action": "scroll"}, {"action": "click"}),
    }
    for name, actions in action_sequences.items():
        spec = vision_journey(name)
        expected = spec.expected
        with fixtures.FixtureHandler.visual_ui_lock:
            fixtures.FixtureHandler.visual_ui_states[expected["stateKey"]] = {
                "status": "completed",
                "receipt": expected["receipt"],
            }
        transcript = [tool("open_tab"), tool("screenshot")]
        transcript.extend(tool("act_on_screen", action) for action in actions)
        transcript.append(tool("data_store", {"action": "list"}))
        rows = [{"data": {
            "check": expected["check"],
            "receipt": expected["receipt"],
            "verified": True,
        }}]

        result = validate_journey(spec, rows, transcript)
        assert result["success"] is True, (name, result)


def test_network_form_accepts_both_response_tools_and_requires_actual_evidence():
    spec = next(item for item in cases.build_base_cases("http://127.0.0.1:9911", "network-evidence") if item.name == "network_form_edge")
    rows = [{"data": {
        "check": "form_network_console", "query": "chair", "category": "furniture",
        "vip": True, "resultCount": 2, "networkMatched": True, "consoleSeen": True,
    }}]
    response = {"url": "http://127.0.0.1:9911/api/search?q=chair&category=furniture&vip=1", "status": 200}
    console = tool("read_console_messages", result={"results": [
        {"text": "fixture search submit chair furniture 1"}, {"text": "fixture search rendered 2"},
    ]})
    transcript = [tool("open_tab", {"watchNetwork": True}), tool("act_on_element"), console, tool("data_store")]
    for name, result in (
        ("network_recent", {"results": [response]}),
        ("wait_for_response", {"matched": True, "response": response}),
    ):
        assert validate(spec, rows, [*transcript, tool(name, result=result)])["success"] is True
    for result in (
        {"matched": False, "response": response},
        {"matched": True, "response": {**response, "status": 500}},
        {"matched": True, "response": {**response, "url": "http://127.0.0.1:9911/other"}},
    ):
        assert validate(spec, rows, [*transcript, tool("wait_for_response", result=result)])["success"] is False
    assert validate(spec, rows, transcript)["success"] is False
    without_console = [item for item in transcript if item is not console]
    assert validate(spec, rows, [*without_console, tool("read_console_messages"), tool("network_recent", result={"results": [response]})])["success"] is False


def test_visual_form_allows_confirmation_screenshot_but_rejects_extra_input_screenshot():
    spec = vision_journey("visual_ui_form", run_tag="keyboard-screenshot-order")
    with fixtures.FixtureHandler.visual_ui_lock:
        fixtures.FixtureHandler.visual_ui_states[spec.expected["stateKey"]] = {
            "status": "completed",
            "receipt": spec.expected["receipt"],
        }
    rows = [{"data": {
        "check": spec.expected["check"],
        "receipt": spec.expected["receipt"],
        "verified": True,
    }}]
    before_submit = [tool("open_tab"), tool("screenshot"), tool("act_on_screen", {"action": "type"})]
    press = tool("act_on_screen", {"action": "press", "key": "Enter"})
    readback = tool("data_store", {"action": "list"})
    for earlier_presses in ([], [tool("act_on_screen", {"action": "press", "key": "ArrowLeft"})]):
        accepted = validate_journey(spec, rows, [*before_submit, *earlier_presses, press, tool("screenshot"), readback])
        rejected = validate_journey(spec, rows, [*before_submit, *earlier_presses, tool("screenshot"), press, readback])
        assert accepted["success"] is True
        assert accepted["checks"]["screenshotsBeforePress"] == 1
        assert rejected["success"] is False
        assert rejected["checks"]["screenshotsBeforePress"] == 2
        assert "before press" in rejected["reason"]

    earlier_enter = tool("act_on_screen", {"action": "press", "key": "Enter"})
    repeated = validate_journey(spec, rows, [*before_submit, earlier_enter, tool("screenshot"), press, readback])
    assert repeated["success"] is False, "screenshot and key checks must refer to the same submission"
    assert repeated["checks"]["screenshotsBeforePress"] == 2


def test_visual_ui_journey_rejects_claimed_success_without_browser_completion():
    spec = vision_journey("visual_ui_drag", run_tag="missing-browser-state")
    transcript = [
        tool("open_tab"),
        tool("screenshot"),
        tool("act_on_screen", {"action": "drag"}),
        tool("act_on_screen", {"action": "click"}),
        tool("data_store", {"action": "list"}),
    ]
    rows = [{"data": {
        "check": spec.expected["check"],
        "receipt": spec.expected["receipt"],
        "verified": True,
    }}]

    result = validate_journey(spec, rows, transcript)
    assert result["success"] is False
    assert "browser-side completion state" in result["reason"]


def test_visual_ui_journey_rejects_missing_required_gesture():
    spec = vision_journey("visual_ui_scroll", run_tag="missing-gesture")
    with fixtures.FixtureHandler.visual_ui_lock:
        fixtures.FixtureHandler.visual_ui_states[spec.expected["stateKey"]] = {
            "status": "completed",
            "receipt": spec.expected["receipt"],
        }
    transcript = [
        tool("open_tab"),
        tool("screenshot"),
        tool("act_on_screen", {"action": "click"}),
        tool("data_store", {"action": "list"}),
    ]
    rows = [{"data": {
        "check": spec.expected["check"],
        "receipt": spec.expected["receipt"],
        "verified": True,
    }}]

    result = validate_journey(spec, rows, transcript)
    assert result["success"] is False
    assert "did not perform scroll" in result["reason"]


def test_parallel_journey_requires_any_then_all_and_exact_branch_truth():
    spec = journey("parallel_subtasks")
    creates = [
        tool("manage_sessions", {"action": "create", "title": name, "firstMessage": f"check {name}"})
        for name in ("Alpha", "Beta", "Gamma")
    ]
    waits = [
        tool("manage_sessions", {"action": "wait", "waitFor": "any", "sessionIds": ["a", "b", "c"]}),
        tool("manage_sessions", {"action": "wait", "waitFor": "all", "sessionIds": ["a", "b", "c"]}),
    ]
    rows = [
        {"data": {"branch": "alpha", "code": "alpha-17", "status": "ready"}},
        {"data": {"branch": "beta", "code": "beta-29", "status": "ready"}},
        {"data": {"branch": "gamma", "code": "", "status": "unavailable"}},
    ]
    accepted = validate_journey(spec, rows, [*creates, *waits, tool("data_store", {"action": "list"})])
    rejected = validate_journey(spec, rows, [*creates, *reversed(waits), tool("data_store", {"action": "list"})])

    assert accepted["success"] is True
    assert rejected["success"] is False
    assert "waitFor:any" in rejected["reason"]


def test_absolute_wait_journey_rejects_relative_or_premature_writes():
    spec = journey("absolute_time_alignment")
    row = [{"data": {"check": "exact-ready", "reached": True}}]
    wait = tool("wait_until", {"until": spec.expected["targetIso"]}, {"pastDue": False, "waitedSeconds": 60})
    write = tool("data_store", {"action": "upsert"})

    assert validate_journey(spec, row, [wait, write, tool("data_store", {"action": "list"})])["success"] is True
    premature = validate_journey(spec, row, [write, wait, tool("data_store", {"action": "list"})])
    relative = validate_journey(spec, row, [wait, tool("wait", {"seconds": 60}), write])
    assert premature["success"] is False
    assert relative["success"] is False


def test_absolute_wait_target_is_materialized_when_each_repetition_starts():
    spec = journey("absolute_time_alignment")
    stale = spec.expected["targetIso"]
    spec = replace(
        spec,
        prompt=spec.prompt.replace(stale, "2000-01-01T00:00:00+08:00"),
        expected={**spec.expected, "targetIso": "2000-01-01T00:00:00+08:00", "targetEpochMs": 0},
    )
    materialized = cases.materialize_runtime_case(spec)
    target = datetime.fromisoformat(materialized.expected["targetIso"])

    assert materialized.expected["targetIso"] != "2000-01-01T00:00:00+08:00"
    assert spec.expected["targetIso"] not in materialized.prompt
    assert materialized.expected["targetIso"] in materialized.prompt
    assert 55 <= (target - datetime.now(timezone.utc)).total_seconds() <= 61


def test_automation_journey_compares_tool_request_with_persisted_rule():
    spec = journey("automation_schedule_creation")
    args = {
        "action": "create_automation",
        "title": spec.expected["titleMarker"],
        "instruction": f"read {spec.expected['probeUrl']}; wait until 12:00; write {spec.expected['outputTable']}",
        "schedule": {"type": "daily", "time": "11:55"},
        "missedPolicy": "latest_only",
        "notifyPolicy": "failure",
    }
    persisted = {
        "id": "auto-1",
        **args,
        "schedule": {**args["schedule"], "intervalHours": 1, "intervalMinutes": 60, "weekday": 1},
    }
    client = FakeClient([], automations={"automations": [persisted], "runs": {}})
    result = validate_journey(spec, [], [tool("manage_sessions", args)], client=client)
    assert result["success"] is True

    drifted = FakeClient([], automations={"automations": [{**persisted, "notifyPolicy": "always"}], "runs": {}})
    assert validate_journey(spec, [], [tool("manage_sessions", args)], client=drifted)["success"] is False


def test_clarification_journey_requires_one_form_resume_before_write():
    spec = journey("human_clarification_resume")
    ask = tool("ask_user", {"message": "请选择币种", "fields": [{"id": "currency", "label": "币种"}]}, {"answers": {"currency": "CNY"}})
    write = tool("data_store", {"action": "upsert"})
    rows = [{"data": {"project": "journey", "amount": 1000, "currency": "CNY"}}]
    snapshot = {"_behaviorDriver": {"submittedWaits": [{"waitId": "wait-1", "answers": {"currency": "CNY"}}]}}
    assert validate_journey(spec, rows, [ask, write], snapshot=snapshot)["success"] is True
    assert validate_journey(spec, rows, [ask, write])["success"] is False


def test_skill_settings_journey_proves_validation_recovery_and_secret_redaction():
    spec = journey("skill_settings_validation_recovery")
    setting_id = f"{spec.expected['pluginManifest']['id']}::{spec.expected['skillName']}"
    client = FakeClient(
        [],
        skill={"name": spec.expected["skillName"], "content": "# Skill\nmarker harbor-42"},
        resource={"path": "plugin.json", "content": json.dumps(spec.expected["pluginManifest"], ensure_ascii=False)},
        skill_settings={
            "settings": [{"id": setting_id, "skillName": spec.expected["skillName"], "fields": [
                {"key": "retryCount", "value": 5},
                {"key": "apiToken", "hasValue": True},
            ]}],
        },
    )
    transcript = [
        tool("load_skill", {"name": "skill-workbench"}),
        tool("qingzhou_skill_author__create_skill", {"name": spec.expected["skillName"]}),
        tool("qingzhou_skill_author__edit_skill_resource", {"name": spec.expected["skillName"], "path": "plugin.json"}),
        tool("qingzhou_management__manage_skill_settings", {"action": "update", "settingId": setting_id, "values": {"retryCount": 99}}, is_error=True),
        tool("qingzhou_management__manage_skill_settings", {"action": "update", "settingId": setting_id, "values": {"retryCount": 5, "apiToken": spec.expected["secret"]}}),
        tool("qingzhou_management__manage_skill_settings", {"action": "get", "settingId": setting_id}, {"setting": deepcopy(client.skill_settings["settings"][0])}),
    ]
    assert validate_journey(spec, [], transcript, client=client)["success"] is True
    no_recovery = [item for item in transcript if item.get("args", {}).get("values", {}).get("retryCount") != 5]
    assert validate_journey(spec, [], no_recovery, client=client)["success"] is False
    secret = spec.expected["secret"]
    client.skill_settings["settings"][0]["fields"][1]["value"] = secret
    private_inputs = [{"type": "user", "text": secret}, {"type": "thinking", "text": secret}]
    assert validate_journey(spec, [], [*private_inputs, *transcript, {"type": "assistant", "content": "retryCount=5; secret configured"}], client=client)["success"] is True
    for echo in (f"Saved {secret}", [{"type": "text", "text": secret}]):
        leaked = validate_journey(spec, [], [*transcript, {"type": "assistant", "content": echo}, {"type": "assistant", "content": "Done"}], client=client)
        assert leaked["success"] is False
        assert leaked["checks"]["secretEchoedByAssistant"] is True
    exposed_read = deepcopy(transcript[-1])
    exposed_read["result"]["setting"]["fields"][1]["value"] = secret
    exposed = validate_journey(spec, [], [*transcript[:-1], exposed_read], client=client)
    assert exposed["success"] is False and "public settings read tool" in exposed["reason"]
    assert exposed["checks"]["secretExposedBySettingsRead"] is True


def test_browser_library_journey_requires_history_folder_download_and_artifact():
    spec = journey("browser_library_workflow")
    expected = spec.expected
    transcript = [
        tool("open_tab", {"url": expected["libraryUrl"]}),
        tool("browse_history", {"action": "search", "query": "Journey"}, [{"url": expected["libraryUrl"]}]),
        tool("manage_bookmarks", {"action": "create", "title": "Journey Regression acceptance"}, {"created": {"id": "folder"}}),
        tool("manage_bookmarks", {"action": "create", "title": expected["bookmarkTitle"], "url": expected["libraryUrl"], "parentId": "folder"}),
        tool("list_downloads", {"query": expected["downloadFilename"]}, []),
        tool(
            "download_url",
            {"url": expected["reportUrl"], "filename": expected["downloadFilename"]},
            {"downloadId": 7, "artifactRecorded": True},
        ),
        # Chrome may expose an isolated physical filename. Identity comes from the
        # download id returned by download_url, while the task artifact keeps the
        # user-requested logical filename.
        tool("list_downloads", {"id": 7}, [{"id": 7, "filename": "isolated-uuid", "state": "complete"}]),
    ]
    snapshot = {"artifacts": {"files": [{"filename": expected["downloadFilename"], "downloadId": "7"}]}}
    assert validate_journey(spec, [], transcript, snapshot=snapshot)["success"] is True
    assert validate_journey(spec, [], transcript)["success"] is False


def test_alert_journeys_distinguish_foreground_silence_from_background_attention():
    foreground = journey("foreground_alert_decision")
    background = journey("background_alert_decision")
    open_page = tool("open_tab", {"url": "http://127.0.0.1:9911/schedule/probe"})
    alert = tool(
        "send_alert",
        {"message": f"done {background.expected['marker']}"},
        {"sent": True},
    )
    assert validate_journey(foreground, [], [open_page])["success"] is True
    assert validate_journey(foreground, [], [open_page, alert])["success"] is False
    assert validate_journey(background, [], [open_page, alert])["success"] is True


def test_visual_journey_requires_screenshot_evidence_and_exact_conclusion():
    spec = cases.build_vision_cases("http://127.0.0.1:9911", "acceptance")[0]
    row = [{"data": {"check": "canvas-layout", "answer": "circle-left-line-right", "verified": True}}]
    transcript = [tool("open_tab"), tool("screenshot", {"selector": "#scene"}), tool("data_store", {"action": "upsert"})]
    assert validate_journey(spec, row, transcript)["success"] is True
    assert validate_journey(spec, row, [tool("open_tab"), tool("data_store", {"action": "upsert"})])["success"] is False


def test_journey_summary_fails_when_any_mapped_case_fails():
    summary = reporting.summarize_journey_results([
        {"case": "one", "journeys": ["A19"], "success": True},
        {"case": "two", "journeys": ["A19", "A07"], "success": False},
    ])

    assert summary["A19"] == {
        "success": False,
        "passedCases": ["one"],
        "failedCases": ["two"],
    }
    assert summary["A07"]["success"] is False


def test_repeated_agent_journey_keeps_each_iteration_and_fails_on_any_flake():
    summary = reporting.summarize_journey_results([
        {"case": "clarify", "iteration": 1, "journeys": ["A12"], "success": True},
        {"case": "clarify", "iteration": 2, "journeys": ["A12"], "success": False},
        {"case": "clarify", "iteration": 3, "journeys": ["A12"], "success": True},
    ])

    assert summary["A12"] == {
        "success": False,
        "passedCases": ["clarify", "clarify#3"],
        "failedCases": ["clarify#2"],
    }


def test_capture_redacts_real_secrets_inside_nested_strings_without_losing_usage(tmp_path, monkeypatch):
    monkeypatch.delenv("QINGZHOU_CAPTURE_API_KEY", raising=False)
    key_file = tmp_path / "fixture-key"
    key_file.write_text("fixture-api-secret", encoding="utf-8")
    monkeypatch.setenv("QINGZHOU_CAPTURE_API_KEY_FILE", str(key_file))
    monkeypatch.setenv("QINGZHOU_MCP_BRIDGE_TOKEN", "fixture-bridge-secret")
    capture = case_capture.CaseCapture.from_environment(str(tmp_path / "captures"))
    source = {
        "nested": [{"text": "prefix fixture-api-secret / fixture-bridge-secret suffix"}],
        "args": json.dumps({"authorization": "unknown-credential", "message": "fixture-api-secret"}),
        "apiKey": "another-credential",
        "credentials": {name: f"{name}-fixture-value" for name in (
            "apiToken", "auth_token", "API_SECRET", "secretKey", "private-key", "accessKeySecret",
        )},
        "usage": {"input_tokens": 123, "output_tokens": 45, "tokens": 168},
        "toolCallId": "call-1", "runId": "run-1", "timestamp": 123456,
    }
    clean = capture.redact(source)
    serialized = json.dumps(clean)
    for secret in ("fixture-api-secret", "fixture-bridge-secret", "unknown-credential", "another-credential"):
        assert secret not in serialized
    assert clean["nested"][0]["text"] == "prefix [redacted] / [redacted] suffix"
    assert clean["usage"] == source["usage"]
    assert set(clean["credentials"]) == set(source["credentials"])
    assert all(value == "[redacted]" for value in clean["credentials"].values())
    for key in ("toolCallId", "runId", "timestamp"):
        assert clean[key] == source[key]
    assert source["apiKey"] == "another-credential", "redaction must not mutate the live snapshot"


def test_capture_accepts_selected_environment_key_without_reading_other_credentials(tmp_path, monkeypatch):
    monkeypatch.setenv("QINGZHOU_CAPTURE_API_KEY", "fixture-selected-secret")
    monkeypatch.setenv("QINGZHOU_CAPTURE_API_KEY_FILE", str(tmp_path / "unused-key-file"))
    capture = case_capture.CaseCapture.from_environment(str(tmp_path / "captures"))
    assert capture.redact({"text": "prefix fixture-selected-secret suffix"}) == {
        "text": "prefix [redacted] suffix",
    }


def test_capture_requires_a_nonempty_redaction_credential(tmp_path, monkeypatch):
    import pytest

    monkeypatch.delenv("QINGZHOU_CAPTURE_API_KEY", raising=False)
    monkeypatch.delenv("QINGZHOU_CAPTURE_API_KEY_FILE", raising=False)
    with pytest.raises(ValueError, match="requires QINGZHOU_CAPTURE_API_KEY"):
        case_capture.CaseCapture.from_environment(str(tmp_path / "captures"))
    assert not (tmp_path / "captures").exists()
    key_file = tmp_path / "empty-key"
    key_file.write_text("\n", encoding="utf-8")
    monkeypatch.setenv("QINGZHOU_CAPTURE_API_KEY_FILE", str(key_file))
    with pytest.raises(ValueError, match="requires QINGZHOU_CAPTURE_API_KEY"):
        case_capture.CaseCapture.from_environment(str(tmp_path / "captures"))


class CaptureClient(FakeClient):
    def __init__(self, rows):
        super().__init__(rows)
        self.data_reads = 0
        self.value = {
            "sessionId": "capture-session", "status": "completed", "transcriptTotal": 2,
            "transcript": [{"type": "user", "text": "user prompt"}, {
                "type": "assistant", "content": "full output " * 500,
                "runId": "run-1", "timestamp": 123456,
            }],
        }

    async def create_session(self, _case):
        return "capture-session"

    async def snapshot(self, _session_id, *, num=500):
        return self.value

    async def data_store_list(self, table, *, session_id=""):
        self.data_reads += 1
        return await super().data_store_list(table, session_id=session_id)


def test_capture_is_opt_in_and_does_not_read_a_key_when_disabled(tmp_path, monkeypatch):
    monkeypatch.setenv("QINGZHOU_CAPTURE_API_KEY_FILE", str(tmp_path / "missing-key"))
    assert case_capture.CaseCapture.from_environment("") is None
    client = CaptureClient([{"data": {"actual": "stored"}}])
    result = asyncio.run(runner.run_case(client, case("capture", suite="realworld"), "run"))
    assert result["success"] is True
    assert client.data_reads == 1, "disabled capture must not add a Data readback"
    assert not list(tmp_path.iterdir())


def test_capture_writes_full_snapshots_and_actual_rows_for_success_and_business_failure(tmp_path):
    capture = case_capture.CaseCapture(str(tmp_path), ("fixture-api-secret",))
    for iteration, rows in enumerate(([{"data": {"actual": "stored"}}], []), 1):
        client = CaptureClient(rows)
        spec = replace(case("capture", suite="realworld"), iteration=iteration, prompt="fixture-api-secret prompt")
        result = asyncio.run(runner.run_case(client, spec, "run", capture))
        saved = json.loads((tmp_path / f"run-capture-{iteration}.json").read_text())
        assert saved["result"] == result
        assert result["success"] is (iteration == 1)
        assert saved["prompt"] == "[redacted] prompt"
        assert saved["snapshot"]["transcript"] == client.value["transcript"]
        assert len(saved["snapshot"]["transcript"][1]["content"]) > 1200
        assert saved["data"]["response"]["rows"] == rows
        assert saved["iteration"] == iteration
        assert client.data_reads == 2


def test_capture_preserves_snapshot_before_validation_exception(tmp_path, monkeypatch):
    import pytest

    async def reject(*_args):
        raise RuntimeError("validation fixture-api-secret")

    monkeypatch.setattr(runner, "validate_case", reject)
    capture = case_capture.CaseCapture(str(tmp_path), ("fixture-api-secret",))
    client = CaptureClient([])
    with pytest.raises(RuntimeError, match=r"Acceptance validation failed: validation \[redacted\]"):
        asyncio.run(runner.run_case(client, case("capture", suite="realworld"), "run", capture))
    saved = json.loads((tmp_path / "run-capture-1.json").read_text())
    assert saved["snapshot"]["transcript"] == client.value["transcript"]
    assert saved["result"]["checks"]["errorStage"] == "validation"
    assert "fixture-api-secret" not in json.dumps(saved)


def test_capture_readback_and_write_errors_are_explicit_infrastructure_failures(tmp_path):
    import pytest

    class ReadbackFailure(CaptureClient):
        async def data_store_list(self, table, *, session_id=""):
            if self.data_reads:
                raise RuntimeError("fixture-api-secret readback failure")
            return await super().data_store_list(table, session_id=session_id)

    capture = case_capture.CaseCapture(str(tmp_path), ("fixture-api-secret",))
    client = ReadbackFailure([{"data": {"actual": "stored"}}])
    with pytest.raises(RuntimeError, match=r"Case capture failed: Data readback failed: \[redacted\]"):
        asyncio.run(runner.run_case(client, case("capture", suite="realworld"), "run", capture))
    saved = json.loads((tmp_path / "run-capture-1.json").read_text())
    assert saved["result"]["success"] is True, "capture failure must not be relabeled as Agent failure"
    assert saved["captureError"] == "Data readback failed: [redacted] readback failure"
    with pytest.raises(RuntimeError, match="Case capture failed:"):
        asyncio.run(capture.save(client, case("capture", suite="realworld"), "run", "capture-session", {}, {}))


def test_localized_live_prompts_preserve_all_nine_task_acceptance_contracts():
    from agent_behavior.localized_cases import localize_case

    base_url = "http://127.0.0.1:19375"
    specs = {
        spec.name: spec
        for spec in [*cases.build_base_cases(base_url, "locale-contract"), *cases.build_journey_cases(base_url, "locale-contract")]
    }
    required_literals = {
        "goal_driven_pagination": (
            "/posts?page=1", "3", "9", "title", "author", "url", "page",
            "data_store", "dedupField", "create", "checkpoint", "list", "complete",
        ),
        "document_pipeline": (
            "/docs/sample.txt", "qingzhou-documents", "load_skill", "document_fetch",
            "document_parse", "document_read_chunk", "document_create", "open_tab",
            "read_article", "save_file", "Qingzhou regression document summary", "txt",
            "dedupField", "step=document_pipeline_completed", "fileId", "docModelId", "artifactId", "1",
        ),
        "parallel_subtasks": (
            "/parallel/alpha", "/parallel/beta", "/parallel/gamma",
            "Alpha", "Beta", "Gamma", "branch", "code", "status", "url",
            "status=unavailable", 'code=""', "3",
        ),
    }
    response_language = {"en": "in English", "ja": "日本語", "ar": "بالعربية"}
    for language, instruction in response_language.items():
        for name, literals in required_literals.items():
            original = specs[name]
            localized = localize_case(original, language, base_url)
            assert localized.prompt != original.prompt
            assert replace(localized, prompt=original.prompt) == original
            assert localized.expected is original.expected, "localization must not replace the acceptance oracle"
            assert original.table in localized.prompt
            assert base_url in localized.prompt
            assert instruction in localized.prompt
            for literal in literals:
                assert literal in localized.prompt, (language, name, literal)
            for code in original.expected.get("codes", {}).values():
                assert code not in localized.prompt, "fixture answers must not leak into the Agent request"


def test_localized_live_prompts_use_the_selected_run_table_and_fixture_origin():
    from agent_behavior.localized_cases import localize_case

    original = next(spec for spec in cases.build_base_cases("http://old.fixture", "old") if spec.name == "document_pipeline")
    selected = replace(original, table="independent-{run}-table", iteration=7)
    for language in ("en", "ja", "ar"):
        localized = localize_case(selected, language, "http://new.fixture:19876")
        assert "http://new.fixture:19876/docs/sample.txt" in localized.prompt
        assert "independent-{run}-table" in localized.prompt
        assert "http://old.fixture" not in localized.prompt
        assert original.table not in localized.prompt
        assert localized.iteration == 7


def test_simplified_chinese_live_prompts_remain_exactly_unchanged():
    from agent_behavior.localized_cases import localize_case

    for original in cases.build_cases("http://fixture.test", "unchanged", "all"):
        assert localize_case(original, "zh-CN", "http://unused.fixture") is original


def test_live_prompt_localization_rejects_unsupported_languages_and_cases():
    import pytest
    from agent_behavior.localized_cases import localize_case

    original = next(spec for spec in cases.build_base_cases("http://fixture.test", "reject") if spec.name == "document_pipeline")
    for language in ("", "system", "fr", "ja-JP"):
        with pytest.raises(ValueError, match="Unsupported live task language"):
            localize_case(original, language, "http://fixture.test")
    unsupported = replace(original, name="new_untranslated_workflow")
    for language in ("en", "ja", "ar"):
        with pytest.raises(ValueError, match="live task prompt for case"):
            localize_case(unsupported, language, "http://fixture.test")


def test_family_summary_uses_recorded_tool_metadata_before_name_fallback():
    snapshot = {"transcript": [
        {**tool("qingzhou_documents__document_fetch"), "familyId": "document"},
        {**tool("qingzhou_documents__document_create"), "familyId": "artifact"},
        {**tool("qingzhou_mcp__mcp_list_tools"), "familyId": "mcp"},
        {**tool("custom_extension__read_file"), "familyId": "document"},
    ]}
    assert reporting.summarize_snapshot(snapshot)["familyCounts"] == {
        "artifact": 1, "document": 2, "mcp": 1,
    }


def test_legacy_family_fallback_keeps_explicit_namespaced_tool_mappings():
    for name in ("document_fetch", "document_parse", "document_read_chunk"):
        assert reporting.timeline_family_for_tool(name) == "document"
        assert reporting.timeline_family_for_tool(f"qingzhou_documents__{name}") == "document"
    for name in ("document_create", "document_download", "document_list_artifacts"):
        assert reporting.timeline_family_for_tool(f"qingzhou_documents__{name}") == "artifact"
    for name in ("mcp_inspect_server", "mcp_list_tools", "mcp_search_tools", "mcp_call_tool"):
        assert reporting.timeline_family_for_tool(f"qingzhou_mcp__{name}") == "mcp"
    assert reporting.timeline_family_for_tool("custom_extension__execute") == "process"
    assert reporting.timeline_family_for_tool("unrecognized_tool") == "other"


def test_base_family_gate_counts_document_and_mcp_without_relaxing_coverage():
    names = ["open_tab", "get_ax_tree", "act_on_element", "data_store", "save_file",
             "qingzhou_documents__document_fetch", "qingzhou_mcp__mcp_list_tools", "wait"]
    result = reporting.summarize_snapshot({"transcript": [tool(name) for name in names]})
    coverage = reporting.summarize_family_coverage([result], require_base_families=True)
    assert coverage["missingFamilies"] == []
    assert "document" in coverage["requiredFamilies"]
    assert "mcp" in coverage["requiredFamilies"]
    without_mcp = reporting.summarize_snapshot({"transcript": [tool(name) for name in names if "mcp" not in name]})
    assert reporting.summarize_family_coverage([without_mcp], require_base_families=True)["missingFamilies"] == ["mcp"]
