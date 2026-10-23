// Copy qz session exports into the website and clear runtime.ownedTabs.
// PNG and JPEG data URLs, in the exchange JSON and in the page around it, are re-encoded
// to WebP when that is smaller. --scale (default 1) or --max-edge (longest side in px, never upscales) and --quality (default 80) tune it. With --webp, existing WebP images are re-encoded too (always lossy again, so use it once).
// Re-encoding needs ffmpeg with libwebp on PATH.
// The script tag stays id-before-type. <, U+2028, and U+2029 stay escaped.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const SCRIPT_OPEN = /<script\s+id=(["'])qingzhou-session-exchange\1\s+type=(["'])application\/json\2>/u;

// A lazy [\s\S]*? over a payload with tens of MB of inline images overflows the regex stack,
// so only the opening tag is matched and the closing tag is found with indexOf.
function findExchange(source) {
  const open = SCRIPT_OPEN.exec(source);
  if (!open) return null;
  const jsonStart = open.index + open[0].length;
  const close = source.indexOf("</script>", jsonStart);
  if (close < 0) return null;
  const match = [source.slice(open.index, close + 9), open[1], open[2], source.slice(jsonStart, close)];
  match.index = open.index;
  return match;
}

export function clearOwnedTabs(html) {
  const source = String(html);
  const match = findExchange(source);
  if (!match) throw new Error("missing qingzhou-session-exchange script");
  const json = match[3];
  const header = json.slice(0, 256);
  if (!/"format"\s*:\s*"qingzhou\.session"/.test(header) || !/"version"\s*:\s*1/.test(header)) {
    throw new Error("exchange JSON does not start with qingzhou.session version 1");
  }
  const span = findLastArrayProperty(json, "ownedTabs");
  if (!span) throw new Error("runtime ownedTabs array was not found");
  const current = JSON.parse(json.slice(span.start, span.end));
  if (!Array.isArray(current)) throw new Error("ownedTabs is not an array");
  if (current.length === 0) return source;

  const nextJson = `${json.slice(0, span.start)}[]${json.slice(span.end)}`;
  const before = JSON.parse(json);
  const after = JSON.parse(nextJson);
  const expected = JSON.parse(json);
  expected.runtime.ownedTabs = [];
  if (JSON.stringify(after) !== JSON.stringify(expected)) {
    throw new Error("clearing ownedTabs would change other exchange data");
  }
  if (JSON.stringify(before.session) !== JSON.stringify(after.session)) {
    throw new Error("session records changed while clearing ownedTabs");
  }
  const nextScript = match[0].replace(json, () => nextJson);
  return `${source.slice(0, match.index)}${nextScript}${source.slice(match.index + match[0].length)}`;
}

function findLastArrayProperty(json, key) {
  let index = 0;
  let last = null;

  function skipSpace() {
    while (json[index] === " " || json[index] === "\n" || json[index] === "\r" || json[index] === "\t") index += 1;
  }

  function parseString() {
    index += 1;
    while (index < json.length) {
      if (json[index] === "\\") {
        index += 2;
        continue;
      }
      if (json[index] === '"') {
        index += 1;
        return;
      }
      index += 1;
    }
    throw new Error("unterminated JSON string");
  }

  function parseValue() {
    skipSpace();
    if (json[index] === "{") return parseObject();
    if (json[index] === "[") return parseArray();
    if (json[index] === '"') return parseString();
    while (index < json.length && !",}]".includes(json[index]) && !/\s/u.test(json[index])) index += 1;
  }

  function parseArray() {
    index += 1;
    skipSpace();
    if (json[index] === "]") {
      index += 1;
      return;
    }
    while (index < json.length) {
      parseValue();
      skipSpace();
      if (json[index] === ",") {
        index += 1;
        continue;
      }
      if (json[index] === "]") {
        index += 1;
        return;
      }
      throw new Error(`bad JSON array at ${index}`);
    }
  }

  function parseObject() {
    index += 1;
    skipSpace();
    if (json[index] === "}") {
      index += 1;
      return;
    }
    while (index < json.length) {
      skipSpace();
      if (json[index] !== '"') throw new Error(`expected JSON key at ${index}`);
      const keyStart = index;
      parseString();
      const name = JSON.parse(json.slice(keyStart, index));
      skipSpace();
      if (json[index] !== ":") throw new Error(`expected colon at ${index}`);
      index += 1;
      skipSpace();
      const valueStart = index;
      if (name === key && json[index] === "[") {
        parseValue();
        last = { start: valueStart, end: index };
      } else {
        parseValue();
      }
      skipSpace();
      if (json[index] === ",") {
        index += 1;
        continue;
      }
      if (json[index] === "}") {
        index += 1;
        return;
      }
      throw new Error(`bad JSON object at ${index}`);
    }
  }

  parseValue();
  return last;
}

const IMAGE_DATA_URL = /data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+=*/g;

// v1 stores every screenshot inline. Import copies dataUrl through and has no asset id,
// so two identical images stay as two strings.
export function prepareExport(html, options = {}) {
  const cleared = clearOwnedTabs(html);
  const match = findExchange(cleared);
  const payload = JSON.parse(match[3]);
  const stats = { seen: 0, replaced: 0, duplicateStrings: 0 };
  const seenUrls = new Map();
  const settings = { scale: options.scale ?? 1, quality: options.quality ?? 80, maxEdge: options.maxEdge ?? 0, webp: options.webp === true };
  const next = mapStrings(payload, (value) => recompressImages(value, stats, seenUrls, settings));
  if (!Array.isArray(next?.runtime?.ownedTabs) || next.runtime.ownedTabs.length !== 0) {
    throw new Error("runtime.ownedTabs was not empty after prepare");
  }
  const json = minifyExchangeJson(next);
  const open = match[0].slice(0, match[0].indexOf(">") + 1);
  const idAt = open.indexOf("id=");
  const typeAt = open.indexOf("type=");
  if (idAt < 0 || typeAt < 0 || idAt > typeAt) throw new Error("script id must come before type");
  return {
    html: `${recompressImages(cleared.slice(0, match.index), stats, seenUrls, settings)}${open}${json}</script>${recompressImages(cleared.slice(match.index + match[0].length), stats, seenUrls, settings)}`,
    stats,
  };
}

function mapStrings(value, visit) {
  if (typeof value === "string") return visit(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, visit));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = mapStrings(item, visit);
    return out;
  }
  return value;
}

function recompressImages(value, stats, seenUrls, settings) {
  if (!value.includes("data:image/")) return value;
  return value.replace(IMAGE_DATA_URL, (url) => {
    if (!settings.webp && url.startsWith("data:image/webp")) return url;
    stats.seen += 1;
    if (seenUrls.has(url)) {
      stats.duplicateStrings += 1;
      return seenUrls.get(url);
    }
    const next = imageDataUrlToWebp(url, settings);
    seenUrls.set(url, next);
    if (next !== url) stats.replaced += 1;
    return next;
  });
}

function imageDataUrlToWebp(url, { scale, quality, maxEdge }) {
  const image = Buffer.from(url.slice(url.indexOf(",") + 1), "base64");
  const args = ["-v", "error", "-i", "pipe:0"];
  if (maxEdge) args.push("-vf", `scale='if(gt(iw,ih),min(${maxEdge},iw),-2)':'if(gt(iw,ih),-2,min(${maxEdge},ih))':flags=lanczos`);
  else if (scale !== 1) args.push("-vf", `scale=trunc(iw*${scale}/2)*2:trunc(ih*${scale}/2)*2:flags=lanczos`);
  args.push("-frames:v", "1", "-c:v", "libwebp", "-quality", String(quality), "-f", "webp", "pipe:1");
  const result = spawnSync("ffmpeg", args, { input: image, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0 || !result.stdout?.length) {
    throw new Error(`webp encode failed: ${result.stderr?.toString() || "no output"}`);
  }
  const webp = `data:image/webp;base64,${result.stdout.toString("base64")}`;
  return webp.length < url.length ? webp : url;
}

function minifyExchangeJson(payload) {
  const json = JSON.stringify(payload)
    .replace(/</gu, "\\u003c")
    .replace(/\u2028/gu, "\\u2028")
    .replace(/\u2029/gu, "\\u2029");
  const header = json.slice(0, 256);
  if (!header.includes('"format":"qingzhou.session"') || !header.includes('"version":1')) {
    throw new Error("exchange JSON does not start with qingzhou.session version 1");
  }
  if (json.includes("\n")) throw new Error("exchange JSON was not minified");
  return json;
}

function printUsage() {
  console.log("Usage: node website/examples/prepare-exports.mjs --out website-src/sessions [--scale 0.75 | --max-edge 480] [--quality 70] [--webp] <export.html>...");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args[0] === "--self-test") {
    runSelfTest();
  } else {
    const flags = new Map();
    const inputs = [];
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] === "--webp") {
        flags.set("--webp", true);
      } else if (args[index].startsWith("--")) {
        flags.set(args[index], args[index + 1]);
        index += 1;
      } else {
        inputs.push(args[index]);
      }
    }
    if (!flags.has("--out") || !inputs.length) {
      printUsage();
      process.exit(1);
    }
    const outDir = path.resolve(flags.get("--out"));
    const options = {};
    if (flags.has("--scale")) options.scale = Number(flags.get("--scale"));
    if (flags.has("--quality")) options.quality = Number(flags.get("--quality"));
    if (flags.has("--webp")) options.webp = true;
    if (flags.has("--max-edge")) options.maxEdge = Number(flags.get("--max-edge"));
    if (options.maxEdge !== undefined && !(options.maxEdge >= 32)) throw new Error("--max-edge must be at least 32");
    if (!(options.scale ?? 1) || (options.scale ?? 1) > 1 || (options.scale ?? 1) < 0.1) throw new Error("--scale must be between 0.1 and 1");
    fs.mkdirSync(outDir, { recursive: true });
    for (const input of inputs) {
      const before = fs.readFileSync(input);
      const prepared = prepareExport(before.toString("utf8"), options);
      const name = path.basename(input);
      fs.writeFileSync(path.join(outDir, name), prepared.html);
      console.log(`${name}: ${before.length} -> ${Buffer.byteLength(prepared.html)} bytes, images ${prepared.stats.seen}, webp ${prepared.stats.replaced}, repeated ${prepared.stats.duplicateStrings}`);
    }
  }
}

function runSelfTest() {
  const raw = `<!doctype html><script id="qingzhou-session-exchange" type="application/json">{"format":"qingzhou.session","version":1,"session":{"title":"a \\u003c b \\u2028 \\u2029","ownedTabs":[1]},"runtime":{"ownedTabs":[{"url":"https://example.com"}]}}</script>`;
  const cleared = clearOwnedTabs(raw);
  if (!cleared.includes('"ownedTabs":[]')) throw new Error("ownedTabs was not emptied");
  if (!cleared.includes("\\u003c") || !cleared.includes("\\u2028") || !cleared.includes("\\u2029")) {
    throw new Error("JSON escapes changed");
  }
  if (!cleared.includes('<script id="qingzhou-session-exchange" type="application/json">')) {
    throw new Error("script tag changed");
  }
  const again = clearOwnedTabs(cleared);
  if (again !== cleared) throw new Error("second pass rewrote an empty ownedTabs");
  const payload = JSON.parse(findExchange(cleared)[3]);
  if (payload.runtime.ownedTabs.length !== 0 || payload.session.ownedTabs.length !== 1) {
    throw new Error("the wrong ownedTabs array was replaced");
  }
  const png = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "mandelbrot=s=192x192", "-frames:v", "1", "-f", "image2pipe", "-c:v", "png", "pipe:1"], { maxBuffer: 1024 * 1024 });
  if (png.status !== 0 || !png.stdout?.length) throw new Error("could not build a PNG fixture");
  const dataUrl = `data:image/png;base64,${png.stdout.toString("base64")}`;
  const fixture = {
    format: "qingzhou.session",
    version: 1,
    session: {
      title: "a < b \u2028 \u2029",
      ownedTabs: [1],
      note: `${dataUrl} ${dataUrl}`,
    },
    runtime: { ownedTabs: [{ url: "https://example.com" }] },
  };
  const source = `<!doctype html><script id="qingzhou-session-exchange" type="application/json">${JSON.stringify(fixture, null, 2)}</script><main id="messages"><img src="${dataUrl}"></main>`;
  const first = prepareExport(source);
  const second = prepareExport(first.html);
  if (second.html !== first.html) throw new Error("prepare was not stable");
  const preparedJson = findExchange(first.html)[3];
  const prepared = JSON.parse(preparedJson);
  if (prepared.runtime.ownedTabs.length !== 0 || prepared.session.ownedTabs.length !== 1) {
    throw new Error("prepare cleared the wrong ownedTabs array");
  }
  if (!preparedJson.includes("\\u003c") || !preparedJson.includes("\\u2028") || !preparedJson.includes("\\u2029")) {
    throw new Error("prepare dropped JSON escapes");
  }
  if (!preparedJson.startsWith('{"format":"qingzhou.session","version":1')) {
    throw new Error("prepare moved format or version");
  }
  const urls = prepared.session.note.split(" ");
  if (urls.length !== 2 || urls[0] !== urls[1] || !urls[0].startsWith("data:image/webp;base64,")) {
    throw new Error("duplicate PNG screenshots were not kept as repeated WebP data URLs");
  }
  if (prepared.session.note.includes("\"$ref\"") || prepared.session.note.includes("asset:")) {
    throw new Error("prepare replaced a screenshot with a reference");
  }
  if (first.html.includes("data:image/png") || !first.html.includes('<img src="data:image/webp;base64,')) {
    throw new Error("the screenshot outside the exchange JSON was not re-encoded");
  }
  console.log("prepare-exports self-test passed");
}
