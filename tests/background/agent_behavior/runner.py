from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import random
import time
from dataclasses import replace
from datetime import datetime
from pathlib import Path
from typing import Any

from .acceptance import map_wait_answers, safe_int, validate_case
from .capture import CaseCapture
from .cases import CaseSpec, build_cases, materialize_runtime_case
from .client import ClientSession, QingzhouMcpClient, streamablehttp_client
from .fixtures import fixture_server
from .localized_cases import localize_case
from .reporting import (
    format_summary,
    summarize_family_coverage,
    summarize_journey_results,
    summarize_snapshot,
    summarize_tool_sequence,
)


DEFAULT_BRIDGE_URL = "http://127.0.0.1:18765/mcp"
DEFAULT_REPORT = "/tmp/qingzhou-agent-behavior-regression.json"
POLL_INTERVAL_SECONDS = 2.0


async def start_case_session(
    client: QingzhouMcpClient,
    case: CaseSpec,
) -> tuple[str, list[str], dict[str, Any]]:
    if not case.expected.get("environmentSetup"):
        return await client.create_session(case), [], {}

    visible_owner_id = await client.create_empty_session(f"{case.title}/visible-owner")
    subject_id = await client.create_empty_session(case.title)
    try:
        visible = case.expected["visible"]
        visible_tab = await client.execute_tool("open_tab", {"url": visible["url"]}, session_id=visible_owner_id)
        visible_tab_id = safe_int((visible_tab or {}).get("id"))
        working_tab_id = None
        if case.expected.get("environmentSetup") != "visibleOnly":
            working = case.expected["working"]
            working_tab = await client.execute_tool("open_tab", {"url": working["url"]}, session_id=subject_id)
            working_tab_id = safe_int((working_tab or {}).get("id"))
            if working_tab_id is None:
                raise RuntimeError(f"environment setup did not return a working tab id: {working_tab}")
        if visible_tab_id is None:
            raise RuntimeError(f"environment setup did not return a visible tab id: {visible_tab}")
        await client.activate_session_working_tab(visible_owner_id)
        await asyncio.sleep(0.25)
        await client.send_message(subject_id, case.prompt)
        return subject_id, [visible_owner_id], {
            "visibleOwnerSessionId": visible_owner_id,
            "visibleTabId": visible_tab_id,
            "workingTabId": working_tab_id,
        }
    except Exception:
        await client.stop_session(subject_id)
        await client.stop_session(visible_owner_id)
        raise


async def run_case(client: QingzhouMcpClient, case: CaseSpec, run_tag: str, capture: CaseCapture | None = None) -> dict[str, Any]:
    case = materialize_runtime_case(case)
    started = time.monotonic()
    session_id = ""
    snapshot: dict[str, Any] = {}
    timed_out = False
    error = ""
    driven_waits: list[dict[str, Any]] = []
    auxiliary_session_ids: list[str] = []
    environment_setup: dict[str, Any] = {}
    try:
        session_id, auxiliary_session_ids, environment_setup = await start_case_session(client, case)
        deadline = time.monotonic() + case.timeout_seconds
        while True:
            snapshot = await client.snapshot(session_id)
            status = str(snapshot.get("status") or (snapshot.get("runtime") or {}).get("status") or "")
            if status == "waiting_user" and case.expected.get("waitAnswers") and not driven_waits:
                runtime = snapshot.get("runtime") if isinstance(snapshot.get("runtime"), dict) else {}
                wait_id = str(runtime.get("waitId") or "").strip()
                form = runtime.get("waitForm") if isinstance(runtime.get("waitForm"), dict) else {}
                if not wait_id:
                    raise RuntimeError("waiting_user snapshot did not expose runtime.waitId")
                answers = map_wait_answers(form, case.expected["waitAnswers"])
                submitted = await client.submit_wait_form(session_id, wait_id, answers)
                driven_waits.append({"waitId": wait_id, "answers": answers, "result": submitted})
                await asyncio.sleep(POLL_INTERVAL_SECONDS)
                continue
            if status in {"completed", "waiting_user", "aborted", "stopped", "error", "failed"}:
                break
            if time.monotonic() >= deadline:
                timed_out = True
                await client.stop_session(session_id)
                snapshot = await client.snapshot(session_id)
                break
            await asyncio.sleep(POLL_INTERVAL_SECONDS)
    except asyncio.CancelledError:
        if session_id:
            await client.stop_session(session_id)
        for auxiliary_session_id in auxiliary_session_ids:
            await client.stop_session(auxiliary_session_id)
        raise
    except Exception as exc:
        error = str(exc)
        if session_id:
            with contextlib.suppress(Exception):
                await asyncio.wait_for(client.stop_session(session_id), timeout=15)
        for auxiliary_session_id in auxiliary_session_ids:
            with contextlib.suppress(Exception):
                await asyncio.wait_for(client.stop_session(auxiliary_session_id), timeout=15)
        auxiliary_session_ids = []

    if snapshot:
        snapshot = {
            **snapshot,
            "_behaviorDriver": {
                "submittedWaits": driven_waits,
                "environmentSetup": environment_setup,
            },
        }

    elapsed = round(time.monotonic() - started, 3)
    metrics = summarize_snapshot(snapshot)
    validation_error = None
    try:
        validation = await validate_case(client, case, run_tag, session_id, snapshot, timed_out, error)
    except Exception as exc:
        if capture is None:
            raise
        validation_error = exc
        validation = {"success": False, "reason": f"Acceptance validation failed: {exc}", "checks": {"errorStage": "validation"}}
    finally:
        for auxiliary_session_id in auxiliary_session_ids:
            await client.stop_session(auxiliary_session_id)
    result = {
        "case": case.name,
        "iteration": case.iteration,
        "suite": case.suite,
        "title": case.title,
        "journeys": list(case.journey_ids),
        "sessionId": session_id,
        "status": snapshot.get("status") or (snapshot.get("runtime") or {}).get("status") or "error",
        "durationSeconds": elapsed,
        "transcriptTotal": snapshot.get("transcriptTotal", metrics["transcriptTotal"]),
        **metrics,
        "toolSequence": summarize_tool_sequence(snapshot),
        "success": bool(validation["success"]),
        "failureReason": validation.get("reason", ""),
        "checks": validation.get("checks", {}),
    }
    if capture is not None:
        await capture.save(client, case, run_tag, session_id, snapshot, result)
        if validation_error is not None:
            raise RuntimeError(capture.redact(f"Acceptance validation failed: {validation_error}")) from None
        result = capture.redact(result)
    return result


async def run_case_with_new_client(
    *,
    bridge_url: str,
    bridge_timeout: int,
    case: CaseSpec,
    run_tag: str,
    capture: CaseCapture | None = None,
) -> dict[str, Any]:
    async with streamablehttp_client(
        bridge_url,
        timeout=bridge_timeout,
        sse_read_timeout=max(300, bridge_timeout),
    ) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()
            client = QingzhouMcpClient(session)
            return await run_case(client, case, run_tag, capture)


async def run_cases(
    *,
    cases: list[CaseSpec],
    bridge_url: str,
    bridge_timeout: int,
    run_tag: str,
    concurrency: int,
    capture: CaseCapture | None = None,
) -> list[dict[str, Any]]:
    semaphore = asyncio.Semaphore(max(1, int(concurrency or 1)))
    results: list[dict[str, Any]] = []

    async def run_one(case: CaseSpec) -> dict[str, Any]:
        async with semaphore:
            suffix = f" #{case.iteration}" if case.iteration > 1 else ""
            print(f"\n== {case.name}{suffix} ==", flush=True)
            result = await run_case_with_new_client(
                bridge_url=bridge_url,
                bridge_timeout=bridge_timeout,
                case=case,
                run_tag=run_tag,
                capture=capture,
            )
            print(format_summary([result]), flush=True)
            return result

    tasks = [
        asyncio.create_task(run_one(case), name=f"case:{case.name}#{case.iteration}")
        for case in cases
    ]
    try:
        for task in asyncio.as_completed(tasks):
            results.append(await task)
    except BaseException:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        raise

    order = {(case.name, case.iteration): index for index, case in enumerate(cases)}
    results.sort(key=lambda item: order.get((item.get("case"), item.get("iteration")), 10_000))
    return results


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run Qingzhou Agent behavior regression cases through an isolated MCP E2E environment.")
    parser.add_argument("--bridge-url", default=DEFAULT_BRIDGE_URL, help="MCP streamable HTTP URL.")
    parser.add_argument(
        "--suite",
        default="base",
        choices=["base", "journeys", "journeys-vision", "realworld", "all"],
        help="Case suite to run. Default: base. journeys-vision requires a vision-capable provider profile.",
    )
    parser.add_argument("--cases", default="", help="Comma-separated case names. Default: all cases in selected suite.")
    parser.add_argument("--language", default="zh-CN", choices=["zh-CN", "en", "ja", "ar"], help="Authored task language; the Node launcher also changes the real panel's language.")
    parser.add_argument("--report", default=DEFAULT_REPORT, help="JSON report output path.")
    parser.add_argument("--capture-dir", default="", help="Write each full redacted case snapshot and Data readback immediately.")
    parser.add_argument("--bridge-timeout", type=int, default=60, help="Per MCP bridge call timeout seconds.")
    parser.add_argument("--concurrency", type=int, default=4, help="Number of cases to run in parallel. Use 1 for serial debugging.")
    parser.add_argument("--run-tag", default="", help="Stable run tag for table names. Defaults to timestamp + random suffix.")
    parser.add_argument("--repetitions", type=int, default=1, help="Repeat each selected case with isolated fixture identifiers. Default: 1.")
    return parser.parse_args()


async def amain() -> int:
    args = parse_args()
    capture = CaseCapture.from_environment(args.capture_dir)
    if args.repetitions < 1 or args.repetitions > 10:
        raise SystemExit("--repetitions must be between 1 and 10")
    run_tag = args.run_tag or datetime.now().strftime("%Y%m%d%H%M%S") + f"_{random.randint(1000, 9999)}"
    with fixture_server() as base_url:
        cases = [
            replace(case, iteration=iteration)
            for iteration in range(1, args.repetitions + 1)
            for case in build_cases(
                base_url,
                run_tag if args.repetitions == 1 else f"{run_tag}_r{iteration}",
                args.suite,
            )
        ]
        if args.cases:
            selected = {item.strip() for item in args.cases.split(",") if item.strip()}
            all_names = {
                case.name
                for suite in ("all", "journeys-vision")
                for case in build_cases(base_url, run_tag, suite)
            }
            unknown = selected - all_names
            if unknown:
                raise SystemExit(f"Unknown cases: {', '.join(sorted(unknown))}")
            cases = [case for case in cases if case.name in selected]
            missing_in_suite = selected - {case.name for case in cases}
            if missing_in_suite:
                raise SystemExit(
                    f"Cases not in --suite {args.suite}: {', '.join(sorted(missing_in_suite))}. "
                    "Use --suite all or the matching suite."
                )

        cases = [localize_case(case, args.language, base_url) for case in cases]

        async with streamablehttp_client(args.bridge_url, timeout=args.bridge_timeout, sse_read_timeout=max(300, args.bridge_timeout)) as (read, write, _):
            async with ClientSession(read, write) as session:
                await session.initialize()
                client = QingzhouMcpClient(session)
                status = await client.call("qingzhou_bridge_status", {})
                if int(status.get("clientCount") or 0) <= 0:
                    raise SystemExit("No Qingzhou extension client is connected to the MCP bridge.")
        results = await run_cases(
            cases=cases,
            bridge_url=args.bridge_url,
            bridge_timeout=args.bridge_timeout,
            run_tag=run_tag,
            concurrency=args.concurrency,
            capture=capture,
        )

    report = {
        "schema": "qingzhou.agent_behavior_regression.v2",
        "createdAt": datetime.now().isoformat(timespec="seconds"),
        "bridgeUrl": args.bridge_url,
        "suite": args.suite,
        "language": args.language,
        "concurrency": args.concurrency,
        "repetitions": args.repetitions,
        "runTag": run_tag,
        "results": results,
        "summary": {
            "total": len(results),
            "passed": sum(1 for item in results if item["success"]),
            "failed": sum(1 for item in results if not item["success"]),
            "durationSeconds": round(sum(float(item["durationSeconds"]) for item in results), 3),
            "toolCalls": sum(int(item["toolCallCount"]) for item in results),
            "failedToolCalls": sum(int(item["failedToolCallCount"]) for item in results),
            "recoveredToolCalls": sum(int(item["recoveredToolCallCount"]) for item in results),
            "unrecoveredToolCalls": sum(int(item["unrecoveredToolCallCount"]) for item in results),
        },
    }
    report["journeys"] = summarize_journey_results(results)
    coverage = summarize_family_coverage(results, require_base_families=not args.cases and args.suite in {"base", "all"})
    report["summary"].update(coverage)
    report_path = Path(args.report)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("\n== summary ==")
    print(format_summary(results))
    print(f"\nReport written to {report_path}")
    return 0 if report["summary"]["failed"] == 0 and not report["summary"].get("missingFamilies") else 1


def main() -> int:
    return asyncio.run(amain())
