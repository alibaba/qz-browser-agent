from __future__ import annotations

import json
from dataclasses import dataclass, field, replace
from datetime import datetime, timedelta, timezone
from typing import Any


@dataclass(frozen=True)
class CaseSpec:
    name: str
    suite: str
    title: str
    timeout_seconds: int
    table: str
    prompt: str
    min_rows: int = 0
    required_tools: tuple[str, ...] = ()
    journey_ids: tuple[str, ...] = ()
    expected: dict[str, Any] = field(default_factory=dict)
    iteration: int = 1


def build_base_cases(base_url: str, run_tag: str) -> list[CaseSpec]:
    data_table = f"qz_reg_data_{run_tag}"
    news_table = f"qz_reg_news_{run_tag}"
    catalog_table = f"qz_reg_catalog_{run_tag}"
    goal_table = f"qz_reg_goal_{run_tag}"
    document_table = f"qz_reg_document_{run_tag}"
    mcp_table = f"qz_reg_mcp_{run_tag}"
    confirm_table = f"qz_reg_confirm_{run_tag}"
    network_table = f"qz_reg_network_{run_tag}"
    image_table = f"qz_reg_images_{run_tag}"
    image_url_table = f"qz_reg_image_urls_{run_tag}"
    image_selection_table = f"qz_reg_image_selection_{run_tag}"
    image_locality_table = f"qz_reg_image_locality_{run_tag}"
    opaque_image_table = f"qz_reg_image_opaque_{run_tag}"
    article_table = f"qz_reg_article_{run_tag}"
    dynamic_table = f"qz_reg_dynamic_{run_tag}"
    environment_table = f"qz_reg_environment_{run_tag}"
    no_working_table = f"qz_reg_no_working_{run_tag}"
    return [
        *[
            CaseSpec(
                name=f"navigation_readiness_{mode}",
                suite="base",
                title=f"agent-behavior/navigation-readiness-{mode}",
                timeout_seconds=300,
                table=f"qz_reg_navigation_{mode}_{run_tag}",
                min_rows=4,
                required_tools=("open_tab", "navigate", "read_article", "data_store")
                    + (("network_recent",) if watch else ()),
                journey_ids=("A01", "A03", "A04"),
                expected={"watchNetwork": watch},
                prompt=f"""
这是导航后立即采集正文的专项回归。页面会故意延迟响应。
请串行执行以下四步，保留同一个标签页，每次导航工具返回后，紧接着调用 read_article(limit:2000) 读取正文中的 receipt。
1. open_tab 打开 {base_url}/navigation/first?key={run_tag}_{mode}，明确设置 watchNetwork={str(watch).lower()}，读取结果记作 step=open。{"随后立即调用 network_recent 确认首次 /navigation/first 请求已捕获，再进行第 2 步。" if watch else ""}
2. navigate 到 {base_url}/navigation/second?key={run_tag}_{mode}，读取结果记作 step=navigate。
3. 再次 navigate 到完全相同的第 2 步 URL，读取结果记作 step=reload。
4. navigate 到 {base_url}/navigation/redirect?key={run_tag}_{mode}，读取重定向后的正文，记作 step=redirect。
不要加入 wait、wait_for_navigation、脚本、额外截图或预先探测，不要并发执行，也不要遇错重试；出现工具错误就停止并报告。
四步完成后，把四步的 step、receipt 写入 Data 表 qz_reg_navigation_{mode}_{run_tag}，唯一键用 step，最后简短汇报。
""".strip(),
            )
            for mode, watch in (("plain", False), ("watched", True))
        ],
        CaseSpec(
            name="data_store_crud",
            suite="base",
            title="agent-behavior/data-store-crud",
            timeout_seconds=240,
            table=data_table,
            min_rows=1,
            required_tools=("data_store",),
            journey_ids=("A06", "A19"),
            prompt=f"""
请在轻舟 Data 表 {data_table} 完成一次小型数据生命周期验证。
目标数据：alpha/value=100/tag=first，beta/value=200/tag=second，唯一键用 name。
验收标准：表结构可读取；beta 能被读取、更新为 value=999/status=updated 后再删除；最终表里只剩 alpha。
最后用一句话总结数据生命周期是否成功。
""".strip(),
        ),
        CaseSpec(
            name="current_page_environment_handoff",
            suite="base",
            title="agent-behavior/current-page-environment-handoff",
            timeout_seconds=300,
            table=environment_table,
            min_rows=2,
            required_tools=("data_store",),
            journey_ids=("A01", "A03", "A06", "A19"),
            expected={
                "environmentSetup": True,
                "visible": {
                    "pageRole": "user-visible",
                    "marker": "USER-VISIBLE-MARKER-7419",
                    "title": "User Visible Environment",
                    "path": "/environment/visible",
                    "url": f"{base_url}/environment/visible",
                },
                "working": {
                    "pageRole": "session-working",
                    "marker": "SESSION-WORKING-MARKER-2864",
                    "title": "Session Working Environment",
                    "path": "/environment/working",
                    "url": f"{base_url}/environment/working",
                },
            },
            prompt=f"""
我的浏览器里正在看的页面和这个任务自己的工作标签页不是同一页。请分别读取“我当前正在看的页面”和“当前任务工作标签页”，把每页的 pageRole、marker、title、url 写入轻舟 Data 表 {environment_table}，唯一键用 pageRole；保持我正在看的页面不变。完成后简短告诉我两页是否区分正确。
""".strip(),
        ),
        CaseSpec(
            name="no_working_tab_environment",
            suite="base",
            title="agent-behavior/no-working-tab-environment",
            timeout_seconds=240,
            table=no_working_table,
            min_rows=1,
            required_tools=("data_store",),
            journey_ids=("A01", "A03", "A06", "A19"),
            expected={
                "environmentSetup": "visibleOnly",
                "visible": {
                    "pageRole": "user-visible",
                    "marker": "USER-VISIBLE-MARKER-7419",
                    "title": "User Visible Environment",
                    "path": "/environment/visible",
                    "url": f"{base_url}/environment/visible",
                },
            },
            prompt=f"""
请确认当前任务是否已有工作标签页，并读取“我当前正在看的页面”的 pageRole、marker、title、url。把结果写入轻舟 Data 表 {no_working_table}，唯一键用 check，记录 check=no-working-page-context 和 hasWorkingTab；保持我正在看的页面不变，完成后简短汇报。
""".strip(),
        ),
        CaseSpec(
            name="web_explore_click",
            suite="base",
            title="agent-behavior/web-explore-click",
            timeout_seconds=300,
            table=news_table,
            min_rows=3,
            required_tools=("open_tab", "get_ax_tree", "act_on_element", "data_store"),
            journey_ids=("A01", "A02", "A03", "A19"),
            prompt=f"""
打开本地测试页面 {base_url}/news?page=1，像真实网页探索一样先观察页面结构。
找到 Next page/下一页入口并进入第二页，采集第二页 3 条 story 的 title、author、url、page，写入 data_store 表 {news_table}，dedupField 用 url。
完成前 list 验证表里有 3 条记录，然后简短汇报。
""".strip(),
        ),
        CaseSpec(
            name="run_script_collection",
            suite="base",
            title="agent-behavior/run-script-collection",
            timeout_seconds=300,
            table=catalog_table,
            min_rows=6,
            required_tools=("open_tab", "run_script", "data_store"),
            journey_ids=("A05", "A06", "A19"),
            prompt=f"""
打开本地商品页 {base_url}/catalog?page=1。
目标：高效采集第 1 页和第 2 页全部商品，不要逐行手工复制。
这是 run_script 的专项回归：请用 run_script 在页面外编排采集，在脚本内通过 tools.evaluate 执行页面 DOM 读取，并返回采集结果。
每条记录包含 sku、name、price、page、url，写入轻舟 Data 表 {catalog_table}，dedupField 用 sku。
完成前验证共有 6 条商品记录，然后简短汇报。
""".strip(),
        ),
        CaseSpec(
            name="goal_driven_pagination",
            suite="base",
            title="agent-behavior/goal-driven-pagination",
            timeout_seconds=420,
            table=goal_table,
            min_rows=9,
            required_tools=("manage_goal", "data_store"),
            journey_ids=("A09", "A19"),
            prompt=f"""
这是一个长程翻页采集任务，请使用目标追踪。
目标：从 {base_url}/posts?page=1 开始，遍历 3 页 posts，采集全部 9 个 post 的 title、author、url、page，写入 data_store 表 {goal_table}，dedupField 用 url。
要求：开始前 create goal；每次 durable 写入 data_store 后 checkpoint；完成前 list 验证 9 条且去重；最后 complete goal 并简短汇报。
""".strip(),
        ),
        CaseSpec(
            name="document_pipeline",
            suite="base",
            title="agent-behavior/document-pipeline",
            timeout_seconds=300,
            table=document_table,
            min_rows=1,
            required_tools=("load_skill", "qingzhou_documents__document_fetch", "qingzhou_documents__document_parse", "qingzhou_documents__document_read_chunk", "qingzhou_documents__document_create", "data_store"),
            journey_ids=("A08", "A13", "A19"),
            prompt=f"""
请把远程文本 {base_url}/docs/sample.txt 处理成一个轻舟文档摘要产物。
这是 qingzhou-documents 全局 skill 的专项回归：先用 load_skill 加载 qingzhou-documents，再依次使用其中的 document_fetch、document_parse、document_read_chunk、document_create；不要用 open_tab、read_article 或 save_file 替代。
验收标准：能拉取并解析该文本，读取首段内容，生成标题为 Qingzhou regression document summary 的 txt 产物，且不触发下载。
把流程结果写入轻舟 Data 表 {document_table}，dedupField 用 step，至少写入 step=document_pipeline_completed，包含 fileId、docModelId、artifactId。
完成前验证表里至少 1 条记录。
""".strip(),
        ),
        CaseSpec(
            name="mcp_probe",
            suite="base",
            title="agent-behavior/mcp-probe",
            timeout_seconds=300,
            table=mcp_table,
            min_rows=1,
            required_tools=("load_skill", "qingzhou_mcp__mcp_list_tools", "data_store"),
            journey_ids=("A13", "A16", "A19"),
            prompt=f"""
请做一次 MCP registry 的轻量探测，只需要列出少量可用工具和服务器统计，不要调用具体外部 MCP 工具。
把结果摘要写入轻舟 Data 表 {mcp_table}，dedupField 用 check，至少包含 check=mcp_registry_listed、serverCount、toolCount。
完成前验证表里至少 1 条记录。
""".strip(),
        ),
        CaseSpec(
            name="confirm_wait",
            suite="base",
            title="agent-behavior/confirm-wait",
            timeout_seconds=180,
            table=confirm_table,
            min_rows=1,
            required_tools=("wait", "data_store"),
            journey_ids=("A12", "A19"),
            prompt=f"""
目标：在无需用户输入的情况下短暂停顿约 1 秒，然后记录等待完成。
等待结束后写入轻舟 Data 表 {confirm_table}，dedupField 用 check，至少写入 check=wait_completed，包含 waited=true。
完成前验证表里至少 1 条记录。
""".strip(),
        ),
        CaseSpec(
            name="network_form_edge",
            suite="base",
            title="agent-behavior/network-form-edge",
            timeout_seconds=360,
            table=network_table,
            min_rows=1,
            required_tools=(
                "open_tab",
                "act_on_element",
                "read_console_messages",
                "data_store",
            ),
            journey_ids=("A02", "A04", "A19"),
            prompt=f"""
打开本地表单页 {base_url}/forms，完成一次带证据的搜索提交。
目标：填 Query=chair，Category=furniture，勾选 VIP only，提交 Run search。
提交前重新观察表单，确认 Query、Category 和 VIP 三个控件都已处于目标值；若 Category 仍是 all，先修正为 furniture 再提交。
验收标准：页面结果渲染完成；能用网络请求证据确认 /api/search 命中；能用控制台证据确认提交和渲染日志出现。
把结果写入轻舟 Data 表 {network_table}，dedupField 用 check，至少写入 check=form_network_console，包含 query、category、vip、resultCount、networkMatched、consoleSeen。
完成前验证表里至少 1 条记录。
""".strip(),
        ),
        CaseSpec(
            name="image_collection_targets",
            suite="base",
            title="agent-behavior/image-collection-targets",
            timeout_seconds=300,
            table=image_table,
            min_rows=2,
            required_tools=("open_tab", "list_images", "collect_images", "data_store"),
            journey_ids=("A07", "A19"),
            prompt=f"""
打开本地图集页 {base_url}/images。
把图集区域中的第 1 张和第 3 张图片保存进图集 Data 表 {image_table}。
图集表的唯一键用 sourceKey。完成前验证图集表里至少 2 张图，并简短汇报 assetId 数量。
""".strip(),
        ),
        CaseSpec(
            name="image_selection_metadata",
            suite="base",
            title="agent-behavior/image-selection-metadata",
            timeout_seconds=300,
            table=image_selection_table,
            min_rows=2,
            required_tools=("open_tab", "collect_images"),
            journey_ids=("A07", "A19"),
            prompt=f"""
打开本地文章页 {base_url}/image-selection，把《山野咖啡手记》的正文配图采集到图集 {image_selection_table}。
""".strip(),
        ),
        CaseSpec(
            name="image_collection_urls",
            suite="base",
            title="agent-behavior/image-collection-urls",
            timeout_seconds=240,
            table=image_url_table,
            min_rows=2,
            required_tools=("collect_images",),
            journey_ids=("A07", "A19"),
            prompt=f"""
把下面两张图片保存到图集 {image_url_table}：
{base_url}/assets/red.svg
{base_url}/assets/blue.svg
""".strip(),
        ),
        CaseSpec(
            name="image_collection_tab_locality",
            suite="base",
            title="agent-behavior/image-collection-tab-locality",
            timeout_seconds=360,
            table=image_locality_table,
            min_rows=2,
            required_tools=("open_tab", "list_images", "collect_images"),
            journey_ids=("A03", "A07", "A19"),
            prompt=f"""
打开本地资料索引 {base_url}/image-locality，把其中两张 CMU 时期照片采集到图集 {image_locality_table}。
""".strip(),
        ),
        CaseSpec(
            name="image_selection_insufficient_metadata",
            suite="base",
            title="agent-behavior/image-selection-insufficient-metadata",
            timeout_seconds=240,
            table=opaque_image_table,
            required_tools=("open_tab",),
            journey_ids=("A07", "A12", "A19", "A21"),
            prompt=f"""
打开本地图片页 {base_url}/image-selection-opaque，把画面中出现手冲壶的照片保存到图集 {opaque_image_table}。
""".strip(),
        ),
        CaseSpec(
            name="selector_article_fallback",
            suite="base",
            title="agent-behavior/selector-article-fallback",
            timeout_seconds=300,
            table=article_table,
            min_rows=5,
            required_tools=("open_tab", "get_ax_tree", "data_store"),
            journey_ids=("A01", "A19"),
            prompt=f"""
打开噪声正文页 {base_url}/noisy-article，完成一份结构化页面审计。
目标：
- 提取 Alpha/Beta/Gamma 三条正文 insight。
- 记录正文容器的 data-topic。
- 记录正文里的相关文档链接 href。
- 忽略 header/sidebar/footer 等噪声文案。
把结果写入轻舟 Data 表 {article_table}，dedupField 用 topic；topic 使用 insight_alpha、insight_beta、insight_gamma、article_data_topic、related_document_href。
完成前验证表里至少 5 条记录，并简短汇报审计是否干净。
""".strip(),
        ),
        CaseSpec(
            name="dynamic_target_recovery",
            suite="base",
            title="agent-behavior/dynamic-target-recovery",
            timeout_seconds=360,
            table=dynamic_table,
            min_rows=1,
            required_tools=("open_tab", "get_ax_tree", "act_on_element", "data_store"),
            journey_ids=("A02", "A19"),
            prompt=f"""
打开动态元素页 {base_url}/dynamic，完成一次动态控件保存任务。
页面会先展示一些不可用或重名控件，真正可用的输入框和保存按钮会在交互后生成。
目标：把生成出来的 value 设置为 edge-ok，保存后确认页面状态变成 saved:edge-ok。
把验证结果写入轻舟 Data 表 {dynamic_table}，dedupField 用 check，至少写入 check=dynamic_saved、value=edge-ok、saved=true。
完成前验证表里至少 1 条记录。
""".strip(),
        ),
    ]


def build_realworld_cases(run_tag: str) -> list[CaseSpec]:
    hackernews_table = f"qz_real_hn_{run_tag}"
    wikipedia_table = f"qz_real_wiki_{run_tag}"
    github_table = f"qz_real_github_{run_tag}"
    return [
        CaseSpec(
            name="real_hackernews_frontpage",
            suite="realworld",
            title="agent-behavior/real-hackernews-frontpage",
            timeout_seconds=600,
            table=hackernews_table,
            min_rows=8,
            journey_ids=("A18", "A19"),
            prompt=f"""
真实站点拉练：打开 https://news.ycombinator.com/news，先观察页面结构。
采集首页前 5 条 story 的 title、url、rank、score/comments（可见则填），写入 data_store 表 {hackernews_table}，kind=story，dedupField 用 url。
然后打开第一条 story 的 Hacker News comments 页面，采集前 3 条评论的 author、snippet、commentUrl，写入同一张表，kind=comment。
完成前 list 验证至少 8 条记录。遇到外部站点限制时不要登录、不要高频刷新，尝试用页面内可见信息恢复。
""".strip(),
        ),
        CaseSpec(
            name="real_wikipedia_research",
            suite="realworld",
            title="agent-behavior/real-wikipedia-research",
            timeout_seconds=600,
            table=wikipedia_table,
            min_rows=8,
            journey_ids=("A18", "A19"),
            prompt=f"""
真实站点拉练：打开 https://en.wikipedia.org/wiki/Large_language_model。
围绕 Large language model 页面做结构化阅读，采集至少 8 条可验证信息写入 data_store 表 {wikipedia_table}，dedupField 用 topic。
每条记录包含 topic、value、section、sourceUrl；优先覆盖定义、架构、训练数据、能力、局限、应用、安全风险、相关概念。
不要只自然语言总结；完成前 list 验证至少 8 条记录。
""".strip(),
        ),
        CaseSpec(
            name="real_github_repo_scan",
            suite="realworld",
            title="agent-behavior/real-github-repo-scan",
            timeout_seconds=600,
            table=github_table,
            min_rows=6,
            journey_ids=("A18", "A19"),
            prompt=f"""
真实站点拉练：打开 https://github.com/modelcontextprotocol/python-sdk。
像开发者调研一样探索 repo 页面，采集至少 6 条结构化信息写入 data_store 表 {github_table}，dedupField 用 item。
记录应覆盖 repo 名称/简介、安装或使用入口、README 中的关键概念、主要目录或文件、license/语言/活跃度等可见信息。
每条记录包含 item、value、sourceUrl、evidence。完成前 list 验证至少 6 条记录。
""".strip(),
        ),
    ]


def build_journey_cases(base_url: str, run_tag: str) -> list[CaseSpec]:
    parallel_table = f"qz_journey_parallel_{run_tag}"
    wait_table = f"qz_journey_wait_{run_tag}"
    clarification_table = f"qz_journey_clarify_{run_tag}"
    target = datetime.now(timezone(timedelta(hours=8))) + timedelta(seconds=60)
    target_iso = target.strftime("%Y-%m-%dT%H:%M:%S+08:00")
    skill_name = f"qz-reg-settings-{run_tag.replace('_', '-')}"
    plugin_manifest = {
        "format": "qingzhou.plugin",
        "schemaVersion": 1,
        "id": f"qz-reg-settings-{run_tag.replace('_', '-')}",
        "displayName": "回归偏好设置",
        "version": "0.1.0",
        "description": "行为回归使用的隔离设置样例",
        "settings": {
            "title": "回归偏好",
            "fields": [
                {
                    "key": "retryCount",
                    "type": "number",
                    "label": "重试次数",
                    "min": 1,
                    "max": 5,
                    "default": 1,
                    "required": True,
                },
                {
                    "key": "apiToken",
                    "type": "secret",
                    "label": "测试密钥",
                    "required": True,
                },
            ],
        },
        "tools": [],
    }
    plugin_json = json.dumps(plugin_manifest, ensure_ascii=False, indent=2)
    library_url = f"{base_url}/library"
    report_url = f"{base_url}/files/journey-report.txt"
    # Keep live-model identity markers compact and punctuation-based.
    bookmark_title = f"Journey-Library-{run_tag}"
    return [
        CaseSpec(
            name="parallel_subtasks",
            suite="journeys",
            title="agent-journey/parallel-subtasks",
            timeout_seconds=600,
            table=parallel_table,
            min_rows=3,
            required_tools=("manage_sessions", "data_store"),
            journey_ids=("A10", "A19"),
            expected={"codes": {"alpha": "alpha-17", "beta": "beta-29"}},
            prompt=f"""
请并行核对三个彼此独立的本地分支，并在最先完成一项时先检查其结果，随后等待全部分支结束再汇总：
- Alpha：{base_url}/parallel/alpha
- Beta：{base_url}/parallel/beta
- Gamma：{base_url}/parallel/gamma

输出字段固定为 branch、code、status、url。可用分支的 code 和 status 必须原样保留页面中的实际值；不可用分支的 status 写 unavailable，code 留空字符串，不能猜测 code。
把最终三项写入轻舟 Data 表 {parallel_table}，唯一键使用 branch，完成前核对恰好三行。
""".strip(),
        ),
        CaseSpec(
            name="absolute_time_alignment",
            suite="journeys",
            title="agent-journey/absolute-time-alignment",
            timeout_seconds=300,
            table=wait_table,
            min_rows=1,
            required_tools=("wait_until", "data_store"),
            journey_ids=("A11", "A19"),
            expected={"targetIso": target_iso, "targetEpochMs": int(target.timestamp() * 1000)},
            prompt=f"""
请在北京时间 {target_iso} 到达后，才把一条 check=exact-ready、reached=true 的记录写入轻舟 Data 表 {wait_table}。
不能提前写入，也不要用估算时长替代这个绝对时间点；完成后核对表中只有这一条记录。
""".strip(),
        ),
        CaseSpec(
            name="automation_schedule_creation",
            suite="journeys",
            title="agent-journey/automation-schedule-creation",
            timeout_seconds=300,
            table="",
            required_tools=("manage_sessions",),
            journey_ids=("A11", "A19"),
            expected={
                "titleMarker": f"Journey-schedule-{run_tag}",
                "probeUrl": f"{base_url}/schedule/probe",
                "outputTable": f"qz_journey_schedule_{run_tag}",
            },
            prompt=f"""
请把下面的长期工作安排好并保存：标题包含“Journey-schedule-{run_tag}”；每天北京时间 11:55 开始读取
{base_url}/schedule/probe 做准备，到 12:00 整才把 status、code、checkedAt 写入轻舟 Data 表
qz_journey_schedule_{run_tag}。设备离线漏跑时只处理最新一次，只有失败才提醒我。
保存后重新核对规则，告诉我下一次会何时运行。
""".strip(),
        ),
        CaseSpec(
            name="human_clarification_resume",
            suite="journeys",
            title="agent-journey/human-clarification-resume",
            timeout_seconds=300,
            table=clarification_table,
            min_rows=1,
            required_tools=("ask_user", "data_store"),
            journey_ids=("A12", "A19"),
            expected={"waitAnswers": {"currency": "CNY"}},
            prompt=f"""
为项目记录预算 1000，但币种必须由我决定，不能根据上下文猜测。得到我的选择后，把 project=journey、
amount=1000 和实际币种写入轻舟 Data 表 {clarification_table}，唯一键使用 project，并在完成前读取确认。
""".strip(),
        ),
        CaseSpec(
            name="skill_settings_validation_recovery",
            suite="journeys",
            title="agent-journey/skill-settings-validation-recovery",
            timeout_seconds=600,
            table="",
            required_tools=(
                "load_skill",
                "qingzhou_skill_author__create_skill",
                "qingzhou_skill_author__edit_skill_resource",
                "qingzhou_management__manage_skill_settings",
            ),
            journey_ids=("A14", "A15", "A19"),
            expected={
                "skillName": skill_name,
                "pluginManifest": plugin_manifest,
                "secret": f"journey-token-{run_tag}",
            },
            prompt=f"""
请在这个隔离环境中创建一个全局 Skill，名称为 {skill_name}，展示名为“回归偏好设置”，正文说明它用于验证
Skill 自带配置的校验与恢复，并包含标记 harbor-42。它需要下面这份 plugin.json：

{plugin_json}

创建完成并确认配置可见后，先尝试把 retryCount 设为 99；系统应拒绝越界值。根据返回的约束把它修正为允许的
最大值，同时把 apiToken 设置为 journey-token-{run_tag}。最后重新读取配置，汇报 retryCount 的实际值以及密钥
是否已配置；不要回显密钥内容。
""".strip(),
        ),
        CaseSpec(
            name="browser_library_workflow",
            suite="journeys",
            title="agent-journey/browser-library-workflow",
            timeout_seconds=420,
            table="",
            required_tools=("open_tab", "browse_history", "manage_bookmarks", "download_url", "list_downloads"),
            journey_ids=("A17", "A19"),
            expected={
                "libraryUrl": library_url,
                "reportUrl": report_url,
                "bookmarkTitle": bookmark_title,
                "downloadFilename": f"journey-report-{run_tag}.txt",
            },
            prompt=f"""
打开本地资料页 {library_url}，确认它已经进入浏览历史；把该页面以“{bookmark_title}”收藏到一个新建的临时文件夹
“Journey-Regression-{run_tag}”中。随后下载页面提供的核验报告，保存名为 journey-report-{run_tag}.txt，并确认下载完成。
不要创建重复书签或重复下载；完成后告诉我收藏位置、下载状态，以及这个下载文件是否成为当前任务可继续使用的产物。
""".strip(),
        ),
        CaseSpec(
            name="foreground_alert_decision",
            suite="journeys",
            title="agent-journey/foreground-alert-decision",
            timeout_seconds=240,
            table="",
            required_tools=("open_tab",),
            journey_ids=("A20", "A19"),
            expected={"alertCount": 0},
            prompt=f"""
我正在前台等结果。请读取 {base_url}/schedule/probe，把 status 和 code 直接回复给我；这是即时检查，不需要额外提醒。
""".strip(),
        ),
        CaseSpec(
            name="background_alert_decision",
            suite="journeys",
            title="agent-journey/background-alert-decision",
            timeout_seconds=300,
            table="",
            required_tools=("open_tab", "send_alert"),
            journey_ids=("A20", "A19"),
            expected={"alertCount": 1, "marker": f"journey-alert-{run_tag}"},
            prompt=f"""
我要离开浏览器。请检查 {base_url}/schedule/probe；确认状态后用一条本地提醒把我叫回来，提醒内容包含
journey-alert-{run_tag}。同一结果只提醒一次，完成后也在对话中简短汇报。
""".strip(),
        ),
    ]


def build_vision_cases(base_url: str, run_tag: str) -> list[CaseSpec]:
    table = f"qz_journey_visual_{run_tag}"
    ui_specs = [
        (
            "visual_ui_form",
            "form",
            "visual-form",
            "form-kimi-visual-73",
            {"type": 1, "press": 1},
            "把视觉表单中的现有内容替换为 Kimi Visual 73，然后直接按 Enter 提交，不要点击 SUBMIT 按钮，也不要为按键额外截图",
        ),
        (
            "visual_ui_click",
            "click",
            "visual-click",
            "click-amber-triangle",
            {"click": 2},
            "在视觉选择器中选择 Amber triangle 并确认",
        ),
        (
            "visual_ui_drag",
            "drag",
            "visual-drag",
            "drag-qz27-archive",
            {"drag": 1, "click": 1},
            "把 QZ-27 卡片拖入 ARCHIVE 区域并应用",
        ),
        (
            "visual_ui_scroll",
            "scroll",
            "visual-scroll",
            "scroll-alpha-73",
            {"scroll": 1, "click": 1},
            "在视觉卡片列表中找到 ALPHA-73 并激活",
        ),
    ]
    return [
        CaseSpec(
            name="visual_canvas_inspection",
            suite="journeys-vision",
            title="agent-journey/visual-canvas-inspection",
            timeout_seconds=300,
            table=table,
            min_rows=1,
            required_tools=("open_tab", "screenshot", "data_store"),
            journey_ids=("A21", "A19"),
            expected={"answer": "circle-left-line-right"},
            prompt=f"""
打开 {base_url}/visual/canvas，判断画布中的深色圆形位于横线的哪一侧。页面结构没有答案文本，不要猜测。
把 check=canvas-layout、answer=circle-left-line-right、verified=true 写入轻舟 Data 表 {table}，完成前读取确认。
""".strip(),
        ),
        *[
            CaseSpec(
                name=name,
                suite="journeys-vision",
                title=f"agent-journey/{name.replace('_', '-')}",
                timeout_seconds=360,
                table=f"qz_journey_{check.replace('-', '_')}_{run_tag}",
                min_rows=1,
                required_tools=("open_tab", "screenshot", "act_on_screen", "data_store"),
                journey_ids=("A21", "A19"),
                expected={
                    "check": check,
                    "receipt": receipt,
                    "stateKey": f"{run_tag}:{mode}",
                    "requiredActionCounts": action_counts,
                },
                prompt=f"""
打开 {base_url}/visual/ui?mode={mode}&key={run_tag}:{mode}，{instruction}。
页面显示 SUCCESS 回执后，把 check={check}、receipt={receipt}、verified=true 写入轻舟 Data 表 qz_journey_{check.replace('-', '_')}_{run_tag}，完成前读取确认。
""".strip(),
            )
            for name, mode, check, receipt, action_counts, instruction in ui_specs
        ],
    ]


def build_cases(base_url: str, run_tag: str, suite: str) -> list[CaseSpec]:
    base = build_base_cases(base_url, run_tag)
    realworld = build_realworld_cases(run_tag)
    journeys = build_journey_cases(base_url, run_tag)
    vision = build_vision_cases(base_url, run_tag)
    if suite == "base":
        return base
    if suite == "realworld":
        return realworld
    if suite == "journeys":
        return journeys
    if suite == "journeys-vision":
        return vision
    if suite == "all":
        return [*base, *journeys, *realworld]
    raise ValueError(f"Unknown suite: {suite}")


def materialize_runtime_case(case: CaseSpec) -> CaseSpec:
    if case.name != "absolute_time_alignment":
        return case
    previous_target = str(case.expected.get("targetIso") or "")
    target = datetime.now(timezone(timedelta(hours=8))) + timedelta(seconds=60)
    target_iso = target.strftime("%Y-%m-%dT%H:%M:%S+08:00")
    prompt = case.prompt.replace(previous_target, target_iso) if previous_target else case.prompt
    return replace(case, prompt=prompt, expected={
        **case.expected,
        "targetIso": target_iso,
        "targetEpochMs": int(target.timestamp() * 1000),
    })
