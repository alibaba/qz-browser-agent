import { build } from "esbuild";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test, expect } from "@playwright/test";
import { openFirefoxSidebar } from "./launch.mjs";

test("Firefox saves tool, document artifact and MCP downloads with intact bytes", async ({}, testInfo) => {
  const extensionDir = testInfo.outputPath("extension");
  const downloadDir = testInfo.outputPath("downloads");
  await mkdir(downloadDir, { recursive: true });
  await cp(process.env.QINGZHOU_FIREFOX_EXTENSION_DIR, extensionDir, { recursive: true });
  // The regular tool harness exercises the packaged runtime. This small probe also
  // exposes the MCP download producer in the same real Firefox background realm.
  await build({ stdin: { contents: `
    import { downloadMcpFile } from "./src/background/mcp/file-download.ts";
    globalThis.__qzDownloadMcpFile = downloadMcpFile;
  `, resolveDir: resolve(".") }, bundle: true, format: "iife", target: "es2022", outfile: join(extensionDir, "download-probe.js") });
  const manifestPath = join(extensionDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.background.scripts.push("download-probe.js");
  await writeFile(manifestPath, JSON.stringify(manifest));
  const session = await openFirefoxSidebar({ extensionDir, firefoxUserPrefs: {
    "browser.download.folderList": 2, "browser.download.dir": downloadDir,
    "browser.download.useDownloadDir": true, "browser.download.alwaysOpenPanel": false,
  } });
  const call = (name, args) => session.extension("background", `
    return await view.__qzFirefoxPageTools.execute(${JSON.stringify(name)},
      Cu.cloneInto(${JSON.stringify(args)}, content), undefined,
      Cu.cloneInto({sessionId:"firefox-downloads",runId:"run",source:"agent"}, content));
  `);
  const completed = async id => {
    await expect.poll(() => session.extension("background", `
      return (await view.chrome.downloads.search(Cu.cloneInto({id:${id}}, content)))[0]?.state;
    `)).toBe("complete");
    const item = await session.extension("background", `
      const [item] = await view.chrome.downloads.search(Cu.cloneInto({id:${id}}, content));
      return {url:item.url,filename:item.filename};
    `);
    expect(item.url).toMatch(/^blob:moz-extension:/);
    expect(item.filename.startsWith(downloadDir)).toBe(true);
    return readFile(item.filename);
  };
  try {
    await expect.poll(() => session.extension("background", "return !!view.__qzFirefoxPageTools && !!view.__qzDownloadMcpFile;")).toBe(true);
    for (const size of [1024, 150 * 1024, 600 * 1024]) {
      const text = "轻舟 🌿\n" + "x".repeat(size);
      const saved = await call("save_file", { content: text, filename: `text-${size}.md` });
      expect((await completed(saved.downloadId)).toString("utf8")).toBe(text);
      const downloaded = await session.extension("background", `
        return await view.__qzDownloadMcpFile(Cu.cloneInto({
          bytes:Uint8Array.from({length:${size}}, (_, index) => index % 256),
          filename:"binary-${size}.bin",mimeType:"application/octet-stream"
        }, content));
      `);
      expect(downloaded.state).toBe("complete");
      expect(await completed(downloaded.downloadId)).toEqual(Buffer.from(Array.from({ length: size }, (_, index) => index % 256)));
    }
    const created = await call("document_create", { format: "html", title: "轻舟下载", filename: "document.html", blocks: [{ type: "paragraph", text: "Firefox artifact 🌿" }] });
    const original = await completed(created.downloaded.downloadId);
    expect(original.toString("utf8")).toContain("Firefox artifact 🌿");
    const downloaded = await call("document_download", { artifactId: created.artifactId, filename: "document-copy.html" });
    expect(await completed(downloaded.downloadId)).toEqual(original);
  } finally { await session.close(); }
});
