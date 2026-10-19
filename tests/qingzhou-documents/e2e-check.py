#!/usr/bin/env python3
from pathlib import Path
import json
import os
import sys

from playwright.sync_api import sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "support"))
from extension_assets import ExtensionAssetHandler, serve_repository


ROOT = Path(__file__).resolve().parents[2]
SAMPLE_PATH = "/qingzhou-documents-runtime-sample.txt"
SAMPLE_TEXT = "Qingzhou document runtime test\n\nThe document pipeline is complete.\n"


def expect(condition, message):
    if not condition:
        raise AssertionError(message)


class FixtureHandler(ExtensionAssetHandler):
    def log_message(self, _format, *_args):
        return

    def do_GET(self):
        if self.path.split("?", 1)[0] == SAMPLE_PATH:
            body = SAMPLE_TEXT.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()


def serve_repo():
    return serve_repository(FixtureHandler)


def run():
    with serve_repo() as base_url:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(
                headless=True,
                channel=os.environ.get("QINGZHOU_PLAYWRIGHT_CHANNEL", "chromium"),
            )
            page = browser.new_page(locale="zh-CN")
            page_errors = []
            page.on("pageerror", lambda error: page_errors.append(str(error)))
            page.add_init_script(
                """
                globalThis.__qzStorage = {};
                globalThis.__qzPdfBase64 = btoa("%PDF-1.4\\n1 0 obj\\n<< /Type /Catalog >>\\nendobj\\n%%EOF");
                globalThis.__qzTemporaryTabs = new Map();
                globalThis.__qzLastPdfRenderUrl = "";
                globalThis.__qzLastPdfRenderWindowId = null;
                globalThis.__qzLastWindowTargetSource = null;
                globalThis.chrome = {
                  storage: { local: {
                    async get(key) {
                      const data = globalThis.__qzStorage;
                      if (Array.isArray(key)) return Object.fromEntries(key.map(item => [item, data[item]]));
                      if (typeof key === "string") return { [key]: data[key] };
                      if (key && typeof key === "object") {
                        return Object.fromEntries(Object.entries(key).map(([item, fallback]) => [item, data[item] ?? fallback]));
                      }
                      return { ...data };
                    },
                    async set(values) { Object.assign(globalThis.__qzStorage, values); },
                    async remove(key) {
                      for (const item of (Array.isArray(key) ? key : [key])) delete globalThis.__qzStorage[item];
                    }
                  }},
                  debugger: {
                    onDetach: { addListener() {} },
                    async attach() {},
                    async detach() {},
                    async sendCommand(_target, method) {
                      if (method === "Page.printToPDF") return { data: globalThis.__qzPdfBase64 };
                      return {};
                    }
                  },
                  downloads: { async download() { return 701; } },
                  tabs: {
                    onUpdated: { addListener() {}, removeListener() {} },
                    async create(options) {
                      const tab = { id: 901, windowId: options.windowId, status: "complete", title: "PDF render", url: options.url };
                      globalThis.__qzLastPdfRenderUrl = options.url;
                      globalThis.__qzLastPdfRenderWindowId = options.windowId;
                      globalThis.__qzTemporaryTabs.set(tab.id, tab);
                      return tab;
                    },
                    async get(tabId) {
                      return globalThis.__qzTemporaryTabs.get(tabId) || { id: tabId, status: "complete", url: "about:blank" };
                    },
                    async remove(tabId) { globalThis.__qzTemporaryTabs.delete(tabId); }
                  }
                };
                """
            )
            page.goto(f"{base_url}/tests/tool-timeline/visual-test.html")
            result = page.evaluate(
                """async ({ baseUrl, samplePath }) => {
                  const tools = await import("/extension/background/tools/runtime.js");
                  const runtime = await import("/extension/background/skills/skill-tool-runtime.js");
                  const documentUtils = { ...await import("/extension/capabilities/documents/document-utils.js"), ...await import("/extension/shared/documents/document-codecs.js") };
                  const documentStore = await import("/extension/shared/documents/document-store.js");
                  const runScriptRuntime = await import("/extension/background/tools/run-script-bridge.js");
                  const windowTarget = {
                    async resolveForNewTab({ sourceWindowId }) {
                      globalThis.__qzLastWindowTargetSource = sourceWindowId;
                      return 81;
                    },
                  };
                  const toolRuntime = tools.createToolRuntime({ windowTarget });
                  await runtime.commitSkillToolRegistryCandidate(
                    await runtime.prepareSkillToolRegistryFromStorage(),
                    { reason: "document_browser_e2e" },
                  );
                  const context = {
                    source: "test",
                    sessionId: "doc_browser_e2e",
                    runId: "run_1",
                    sourceWindowId: 81,
                    loadedPluginSkillNames: ["qingzhou-documents"],
                  };
                  const call = (name, args, callContext = context) => toolRuntime.execute(
                    `qingzhou_documents__${name}`,
                    { timeout: 30, ...args },
                    null,
                    callContext,
                  );
                  const fetched = await call("document_fetch", { url: `${baseUrl}${samplePath}` });
                  const parsed = await call("document_parse", { fileId: fetched.fileId, chunkSize: 1000 });
                  const chunk = await call("document_read_chunk", { docModelId: parsed.docModelId, chunkIndex: 0 });
                  const created = await call("document_create", {
                    format: "txt",
                    filename: "runtime-summary.txt",
                    title: "Runtime Summary",
                    docModelId: parsed.docModelId,
                    download: false,
                  });
                  const createdPdfFromModel = await call("document_create", {
                    format: "pdf",
                    filename: "runtime-summary.pdf",
                    docModelId: parsed.docModelId,
                    download: false,
                  });
                  const modelPdfRenderHtml = decodeURIComponent(globalThis.__qzLastPdfRenderUrl.split(",").slice(1).join(","));
                  const listed = await call("document_list_artifacts", { limit: 10 });
                  const downloaded = await call("document_download", {
                    artifactId: created.artifactId,
                    filename: "runtime-summary.txt",
                  });
                  const workbookBytes = await documentUtils.createDocumentBytes({
                    format: "xlsx",
                    title: "Runtime workbook",
                    sheets: [{
                      name: "Data",
                      columns: ["id", "value"],
                      rows: Array.from({ length: 120 }, (_, index) => ({ id: String(index + 1), value: `row-${index + 1}` })),
                    }],
                  });
                  const workbookFile = await documentStore.saveDocumentFile({
                    filename: "runtime-workbook.xlsx",
                    mimeType: documentUtils.mimeTypeForFormat("xlsx"),
                    extension: "xlsx",
                    size: workbookBytes.length,
                    base64: documentUtils.bytesToBase64(workbookBytes),
                    sessionId: context.sessionId,
                    runId: context.runId,
                    sourceTool: "test",
                  });
                  const workbookParsed = await call("document_parse", { fileId: workbookFile.fileId });
                  const workbookFirst = await call("document_read_chunk", { docModelId: workbookParsed.docModelId });
                  const workbookSecond = await call("document_read_chunk", {
                    docModelId: workbookParsed.docModelId,
                    ...workbookFirst.next,
                  });
                  const workbookText = await call("document_create", {
                    format: "txt",
                    filename: "runtime-workbook.txt",
                    docModelId: workbookParsed.docModelId,
                    download: false,
                  });
                  const workbookArtifact = await documentStore.getDocumentArtifact(workbookText.artifactId);
                  const workbookTextValue = new TextDecoder().decode(documentUtils.base64ToBytes(workbookArtifact.base64));

                  const directBlocks = [
                    { type: "heading", text: "Direct formats", level: 1 },
                    { type: "paragraph", text: "A < B & C" },
                    { type: "list", ordered: false, items: ["Alpha", { text: "Beta", children: ["Nested"] }] },
                    { type: "table", name: "Scores", columns: ["name", "score"], rows: [["Alice", 98], ["Bob", 87]], header: false },
                    { type: "code", language: "javascript", text: "const answer = 42;" },
                  ];
                  const directSheets = [{
                    name: "Types",
                    columns: ["text", "number", "boolean", "empty"],
                    rows: [["A", 42, true, null], ["B", -3.5, false, ""]],
                    header: false,
                  }];
                  const directCreated = {};
                  for (const format of ["html", "txt", "docx", "pdf"]) {
                    directCreated[format] = await call("document_create", {
                      format,
                      filename: `direct.${format}`,
                      title: "Direct formats",
                      blocks: directBlocks,
                      download: false,
                    });
                  }
                  for (const format of ["xlsx", "csv"]) {
                    directCreated[format] = await call("document_create", {
                      format,
                      filename: `direct.${format}`,
                      title: "Direct types",
                      sheets: directSheets,
                      download: false,
                    });
                  }
                  const directArtifacts = Object.fromEntries(await Promise.all(
                    Object.entries(directCreated).map(async ([format, summary]) => {
                      if (!summary?.artifactId) throw new Error(`direct ${format} result has no artifactId: ${JSON.stringify(summary)}`);
                      return [format, await documentStore.getDocumentArtifact(summary.artifactId)];
                    }),
                  ));
                  const directHtml = new TextDecoder().decode(documentUtils.base64ToBytes(directArtifacts.html.base64));
                  const directTxt = new TextDecoder().decode(documentUtils.base64ToBytes(directArtifacts.txt.base64));
                  const directDocx = await documentUtils.parseDocumentBytes(
                    documentUtils.base64ToBytes(directArtifacts.docx.base64),
                    { filename: "direct.docx" },
                  );
                  const directXlsx = await documentUtils.parseDocumentBytes(
                    documentUtils.base64ToBytes(directArtifacts.xlsx.base64),
                    { filename: "direct.xlsx" },
                  );
                  const directCsv = await documentUtils.parseDocumentBytes(
                    documentUtils.base64ToBytes(directArtifacts.csv.base64),
                    { filename: "direct.csv" },
                  );
                  const directPdfPrefix = atob(directArtifacts.pdf.base64.slice(0, 16));
                  const directPdfRenderHtml = decodeURIComponent(globalThis.__qzLastPdfRenderUrl.split(",").slice(1).join(","));

                  const beforeInvalid = await call("document_list_artifacts", { limit: 100 });
                  const invalidCases = {
                    missingFormat: { filename: "missing.pdf", blocks: directBlocks, download: false },
                    unsupportedFormat: { format: "pptx", filename: "bad.pptx", blocks: directBlocks, download: false },
                    legacyBlocks: { format: "pdf", filename: "legacy.pdf", blocks: [{ heading: "Wrong", level: 1 }], download: false },
                    nestedCell: { format: "xlsx", filename: "nested.xlsx", sheets: [{ name: "Data", columns: ["value"], rows: [[{ nested: true }]] }], download: false },
                    emptyContent: { format: "txt", filename: "empty.txt", blocks: [], download: false },
                    narrativeXlsx: { format: "xlsx", filename: "narrative.xlsx", blocks: [{ type: "paragraph", text: "not tabular" }], download: false },
                    multipleCsvSheets: { format: "csv", filename: "many.csv", sheets: [
                      { name: "One", columns: ["id"], rows: [[1]], header: false },
                      { name: "Two", columns: ["id"], rows: [[2]], header: false },
                    ], download: false },
                    sourceConflict: { format: "txt", filename: "conflict.txt", docModelId: parsed.docModelId, blocks: [{ type: "paragraph", text: "ignored" }], download: false },
                    invalidControlType: { format: "txt", filename: "control.txt", blocks: directBlocks, download: "no" },
                    invalidSheetName: { format: "xlsx", filename: "name.xlsx", sheets: [{ name: "Bad/Name", columns: ["id"], rows: [[1]], header: false }], download: false },
                  };
                  const invalidResults = {};
                  for (const [name, args] of Object.entries(invalidCases)) {
                    try {
                      await call("document_create", args);
                      invalidResults[name] = { code: "NO_ERROR" };
                    } catch (error) {
                      invalidResults[name] = {
                        code: error?.code || "",
                        expectedFormat: error?.details?.expected?.format?.enum || [],
                        retry: error?.details?.retry || null,
                      };
                    }
                  }
                  const afterInvalid = await call("document_list_artifacts", { limit: 100 });

                  const bridge = runScriptRuntime.createRunScriptBridge({
                    supervisor: {
                      isRunCurrent: () => true,
                      hasAgent: () => true,
                      getAbortSignal: () => null,
                    },
                    getRuntime: () => ({ status: "running", loadedPluginSkillNames: ["qingzhou-documents"] }),
                    isTerminalRuntimeForRun: () => false,
                    canManageSessions: async () => true,
                    buildRunProfile: async () => ({}),
                    getRunToolContext: async () => ({
                      dynamicContext: { sourceWindowId: context.sourceWindowId },
                      loadedPluginSkillNames: ["qingzhou-documents"],
                      runProfile: {},
                    }),
                    toolRuntime,
                    collectArtifacts: () => [],
                  });
                  const callFromScript = async (toolName, args = {}) => {
                    const response = await bridge.handleToolCall({
                      toolName,
                      args,
                      sessionId: context.sessionId,
                      runId: context.runId,
                    });
                    if (!response.ok) {
                      throw Object.assign(new Error(response.error || "run_script tool call failed"), {
                        code: response.code,
                        details: response.details,
                      });
                    }
                    return response.result;
                  };
                  const scriptTools = new Proxy(Object.create(null), {
                    get(_target, prop) {
                      if (prop === "then") return undefined;
                      if (prop === "$list") return async () => (await callFromScript("__list_tools__", {})).tools;
                      return args => callFromScript(String(prop), args);
                    },
                  });
                  const listedFromScript = await scriptTools.$list();
                  const documentCreateFromScriptSchema = listedFromScript.find(item => item.name === "qingzhou_documents__document_create");
                  const executeSyntheticInnerScript = new Function("tools", `
                    return (async () => tools.qingzhou_documents__document_create({
                      timeout: 30,
                      format: "html",
                      filename: "from-run-script.html",
                      title: "Run script",
                      blocks: [
                        { type: "heading", text: "Run script", level: 1 },
                        { type: "paragraph", text: "Nested tool call works." },
                        { type: "table", columns: ["id", "ok"], rows: [[1, true]], header: false }
                      ],
                      download: false
                    }))();
                  `);
                  const createdFromScript = await executeSyntheticInnerScript(scriptTools);
                  if (!createdFromScript?.artifactId) throw new Error(`run_script result has no artifactId: ${JSON.stringify(createdFromScript)}`);
                  const artifactFromScript = await documentStore.getDocumentArtifact(createdFromScript.artifactId);
                  const htmlFromScript = new TextDecoder().decode(documentUtils.base64ToBytes(artifactFromScript.base64));
                  const createdFormatsFromScript = { html: createdFromScript };
                  for (const format of ["txt", "docx", "pdf"]) {
                    createdFormatsFromScript[format] = await scriptTools.qingzhou_documents__document_create({
                      timeout: 30,
                      format,
                      filename: `from-run-script.${format}`,
                      title: "Run script formats",
                      blocks: directBlocks,
                      download: false,
                    });
                  }
                  const runScriptPdfRenderHtml = decodeURIComponent(globalThis.__qzLastPdfRenderUrl.split(",").slice(1).join(","));
                  for (const format of ["xlsx", "csv"]) {
                    createdFormatsFromScript[format] = await scriptTools.qingzhou_documents__document_create({
                      timeout: 30,
                      format,
                      filename: `from-run-script.${format}`,
                      title: "Run script types",
                      sheets: directSheets,
                      download: false,
                    });
                  }
                  const beforeInvalidFromScript = await call("document_list_artifacts", { limit: 100 });
                  let invalidFromScript = null;
                  try {
                    await scriptTools.qingzhou_documents__document_create({
                      timeout: 30,
                      format: "pdf",
                      filename: "bad-from-script.pdf",
                      blocks: [{ heading: "Wrong" }],
                      download: false,
                    });
                  } catch (error) {
                    invalidFromScript = { code: error.code, details: error.details };
                  }
                  let missingFormatFromScript = null;
                  try {
                    await scriptTools.qingzhou_documents__document_create({
                      timeout: 30,
                      filename: "missing-format-from-script.pdf",
                      blocks: directBlocks,
                      download: false,
                    });
                  } catch (error) {
                    missingFormatFromScript = { code: error.code, details: error.details };
                  }
                  const afterInvalidFromScript = await call("document_list_artifacts", { limit: 100 });
                  let foreignError = null;
                  try {
                    await call("document_read_chunk", { docModelId: parsed.docModelId }, {
                      ...context,
                      sessionId: "foreign_session",
                    });
                  } catch (error) {
                    foreignError = { code: error?.code || "", message: error?.message || String(error) };
                  }
                  return {
                    fetched, parsed, chunk, created, createdPdfFromModel, modelPdfRenderHtml, listed, downloaded, foreignError,
                    workbookParsed, workbookFirst, workbookSecond, workbookTextValue,
                    directCreated,
                    directHtml,
                    directTxt,
                    directDocx,
                    directXlsx,
                    directCsv,
                    directPdfPrefix,
                    directPdfRenderHtml,
                    directPdfStoredSize: directArtifacts.pdf.size,
                    directPdfActualSize: documentUtils.base64ToBytes(directArtifacts.pdf.base64).length,
                    invalidResults,
                    invalidArtifactCountBefore: beforeInvalid.length,
                    invalidArtifactCountAfter: afterInvalid.length,
                    runScriptSchemaRequired: documentCreateFromScriptSchema?.parameters?.required || [],
                    runScriptTitleDescription: documentCreateFromScriptSchema?.parameters?.properties?.title?.description || "",
                    runScriptBlockRequired: documentCreateFromScriptSchema?.parameters?.properties?.blocks?.items?.required || [],
                    createdFromScript,
                    createdFormatsFromScript,
                    runScriptPdfRenderHtml,
                    htmlFromScript,
                    invalidFromScript,
                    missingFormatFromScript,
                    invalidFromScriptArtifactCountBefore: beforeInvalidFromScript.length,
                    invalidFromScriptArtifactCountAfter: afterInvalidFromScript.length,
                    pdfRenderWindowId: globalThis.__qzLastPdfRenderWindowId,
                    windowTargetSource: globalThis.__qzLastWindowTargetSource,
                  };
                }""",
                {"baseUrl": base_url, "samplePath": SAMPLE_PATH},
            )
            browser.close()

    expect(not page_errors, f"page errors: {page_errors}")
    expect(result["fetched"].get("fileId"), "document_fetch did not return fileId")
    expect(result["parsed"].get("docModelId"), "document_parse did not return docModelId")
    expect("document pipeline is complete" in result["chunk"].get("content", "").lower(), "document_read_chunk lost content")
    expect(result["chunk"].get("contentFormat") == "markdown", "document_read_chunk did not return Markdown")
    expect("text" not in result["chunk"] and "blocks" not in result["chunk"], "document_read_chunk duplicated its content")
    expect(result["created"].get("artifactId"), "document_create did not return artifactId")
    expect(result["createdPdfFromModel"].get("artifactId"), "docModel PDF conversion did not return artifactId")
    expect("document pipeline is complete" in result["modelPdfRenderHtml"].lower(), "docModel PDF conversion lost parsed content")
    expect(result["created"].get("downloaded") is None, "download:false should not auto-download")
    expect(
        any(item.get("artifactId") == result["created"]["artifactId"] for item in result["listed"]),
        "document_list_artifacts did not return the created artifact",
    )
    expect(result["downloaded"].get("downloadId") == 701, "document_download did not reach Chrome downloads")
    expect(result["workbookParsed"].get("blockCount") == 0, "XLSX should not duplicate sheets into blocks")
    expect(result["workbookFirst"].get("mode") == "table", "XLSX did not default to structured table mode")
    expect(result["workbookFirst"].get("tableId") == "sheet:0", "XLSX tableId is unstable")
    expect(len(result["workbookFirst"].get("rows", [])) == 50, "XLSX first page size is incorrect")
    expect(result["workbookSecond"].get("offset") == 50, "XLSX next cursor was not honored")
    expect(result["workbookTextValue"].count("row-1\n") == 1, "XLSX conversion duplicated sheet rows")
    expect(result["fetched"].get("_plugin", {}).get("id") == "qingzhou-documents", "plugin metadata is missing")
    expect("trace" not in result["chunk"], "document result was duplicated into host trace")
    expect(result["foreignError"].get("code") == "DOCUMENT_SESSION_FOREIGN", "foreign session access should be rejected")

    for format_name in ("html", "txt", "docx", "xlsx", "csv", "pdf"):
        created_format = result["directCreated"].get(format_name, {})
        expect(created_format.get("artifactId"), f"direct {format_name} creation did not return artifactId")
        expect(created_format.get("format") == format_name, f"direct {format_name} creation returned the wrong format")
        expect(created_format.get("size", 0) > 0, f"direct {format_name} creation returned an empty artifact")
        expect(created_format.get("contentSummary", {}).get("textChars", 0) > 0, f"direct {format_name} creation omitted content summary")
    expect("A &lt; B &amp; C" in result["directHtml"], "direct HTML did not escape and preserve text")
    expect(result["directHtml"].count("<h1>Direct formats</h1>") == 1, "direct HTML duplicated metadata title and visible heading")
    expect("Alice" in result["directHtml"] and "const answer = 42;" in result["directHtml"], "direct HTML lost structured blocks")
    expect("- Alpha" in result["directTxt"] and "Alice\t98" in result["directTxt"], "direct TXT lost list/table content")
    expect(
        any(block.get("type") == "table" and any(row.get("name") == "Alice" for row in block.get("rows", [])) for block in result["directDocx"].get("blocks", [])),
        "direct DOCX roundtrip lost table rows",
    )
    expected_type_rows = [
        {"text": "A", "number": "42", "boolean": "true", "empty": ""},
        {"text": "B", "number": "-3.5", "boolean": "false", "empty": ""},
    ]
    expect(result["directXlsx"].get("sheets", [{}])[0].get("rows") == expected_type_rows, "direct XLSX changed scalar values")
    expect(result["directCsv"].get("sheets", [{}])[0].get("rows") == expected_type_rows, "direct CSV changed scalar values")
    expect(result["directPdfPrefix"].startswith("%PDF-"), "direct PDF artifact has an invalid header")
    expect("Direct formats" in result["directPdfRenderHtml"] and "Alice" in result["directPdfRenderHtml"], "direct PDF renderer received incomplete HTML")
    expect(result["directPdfRenderHtml"].count("<h1>Direct formats</h1>") == 1, "direct PDF duplicated metadata title and visible heading")
    expect(result["directPdfStoredSize"] == result["directPdfActualSize"], "PDF artifact size ignored Base64 padding")
    expect(result["pdfRenderWindowId"] == 81, "PDF render tab did not use the resolved normal window")
    expect(result["windowTargetSource"] == 81, "PDF window resolution lost the run source window")

    expected_invalid_codes = {
        "missingFormat": "MISSING_REQUIRED_ARGUMENTS",
        "unsupportedFormat": "DOCUMENT_FORMAT_UNSUPPORTED",
        "legacyBlocks": "DOCUMENT_BLOCK_SCHEMA_INVALID",
        "nestedCell": "DOCUMENT_SHEET_SCHEMA_INVALID",
        "emptyContent": "DOCUMENT_CONTENT_EMPTY",
        "narrativeXlsx": "DOCUMENT_TABULAR_CONTENT_REQUIRED",
        "multipleCsvSheets": "DOCUMENT_CSV_MULTIPLE_TABLES",
        "sourceConflict": "DOCUMENT_SOURCE_CONFLICT",
        "invalidControlType": "DOCUMENT_CREATE_SCHEMA_INVALID",
        "invalidSheetName": "DOCUMENT_SHEET_SCHEMA_INVALID",
    }
    expect(
        {name: value.get("code") for name, value in result["invalidResults"].items()} == expected_invalid_codes,
        f"invalid document matrix returned unexpected codes: {result['invalidResults']}",
    )
    expect(result["invalidResults"]["missingFormat"].get("expectedFormat") == ["docx", "xlsx", "pdf", "html", "txt", "csv"], "missing format did not return its enum schema")
    expect(result["invalidArtifactCountBefore"] == result["invalidArtifactCountAfter"], "invalid calls created document artifacts")

    expect(result["runScriptSchemaRequired"] == ["timeout", "format"], "run_script saw a different document_create required schema")
    expect("不会自动写入正文" in result["runScriptTitleDescription"], "run_script did not receive the title metadata contract")
    expect(result["runScriptBlockRequired"] == ["type"], "run_script did not see the block type discriminator")
    expect(result["createdFromScript"].get("artifactId"), "run_script document creation failed")
    expect(result["createdFromScript"].get("contentSummary", {}).get("tableRows") == 1, "run_script creation lost table rows")
    expect("Nested tool call works." in result["htmlFromScript"], "run_script-created HTML lost text")
    expect(result["htmlFromScript"].count("<h1>Run script</h1>") == 1, "run_script duplicated metadata title and visible heading")
    for format_name in ("html", "txt", "docx", "xlsx", "csv", "pdf"):
        script_created = result["createdFormatsFromScript"].get(format_name, {})
        expect(script_created.get("artifactId"), f"run_script {format_name} creation did not return artifactId")
        expect(script_created.get("format") == format_name, f"run_script {format_name} creation returned the wrong format")
        expect(script_created.get("size", 0) > 0, f"run_script {format_name} creation returned an empty artifact")
    expect("Run script formats" in result["runScriptPdfRenderHtml"] and "Alice" in result["runScriptPdfRenderHtml"], "run_script PDF renderer received incomplete HTML")
    expect(result["invalidFromScript"].get("code") == "DOCUMENT_BLOCK_SCHEMA_INVALID", "run_script invalid blocks did not fail at the document boundary")
    expect(
        result["invalidFromScript"].get("details", {}).get("retry", {}).get("preservedArgs", {}).get("timeout") == 30
        and result["invalidFromScript"].get("details", {}).get("retry", {}).get("preservedArgs", {}).get("format") == "pdf",
        "run_script error did not preserve timeout/format for retry",
    )
    expect(result["missingFormatFromScript"].get("code") == "MISSING_REQUIRED_ARGUMENTS", "run_script missing format returned the wrong error")
    expect(
        result["missingFormatFromScript"].get("details", {}).get("expected", {}).get("format", {}).get("enum") == ["docx", "xlsx", "pdf", "html", "txt", "csv"],
        "run_script missing format did not return the format schema",
    )
    expect(
        result["missingFormatFromScript"].get("details", {}).get("retry", {}).get("preservedArgs", {}).get("timeout") == 30,
        "run_script missing format did not preserve timeout for retry",
    )
    expect(
        result["invalidFromScriptArtifactCountBefore"] == result["invalidFromScriptArtifactCountAfter"],
        "invalid run_script calls created document artifacts",
    )
    return {
        "ok": True,
        "fileId": result["fetched"]["fileId"],
        "docModelId": result["parsed"]["docModelId"],
        "artifactId": result["created"]["artifactId"],
        "downloadId": result["downloaded"]["downloadId"],
        "artifactCount": result["invalidArtifactCountAfter"],
        "validatedFormats": ["html", "txt", "docx", "xlsx", "csv", "pdf"],
        "invalidCases": len(expected_invalid_codes),
    }


if __name__ == "__main__":
    try:
        print(json.dumps(run(), ensure_ascii=False, indent=2))
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False, indent=2), file=sys.stderr)
        sys.exit(1)
