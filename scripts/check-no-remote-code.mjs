#!/usr/bin/env node

import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCANNED_EXTENSIONS = new Set([".js", ".mjs", ".html", ".json", ".map"]);
const REMOTE_HOSTS = [
  "cdn.jsdelivr.net",
  "fastly.jsdelivr.net",
  "unpkg.com",
  "cdnjs.cloudflare.com",
  "cdnjs.com",
  "registry.npmmirror.com",
  "ajax.googleapis.com",
  "esm.sh",
  "cdn.skypack.dev",
  "ga.jspm.io",
  "jspm.dev",
  "raw.githubusercontent.com",
  "cdn.sheetjs.com",
];

// Identifiers and package metadata, not scripts the extension fetches.
// vendor/provenance.json: SheetJS upstream tarball URL on cdn.sheetjs.com.
const ALLOWLIST = [
  { suffix: "vendor/provenance.json", host: "cdn.sheetjs.com" },
];

function posix(path) {
  return path.split(sep).join("/");
}

function allowed(path, host) {
  return ALLOWLIST.some(rule => rule.host === host && path.endsWith(rule.suffix));
}

async function filesIn(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) files.push(...await filesIn(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

/** Scan packaged extension directories for CDN script hosts. */
export async function findRemoteCode(directories) {
  const hits = [];
  for (const directory of directories) {
    const root = resolve(directory);
    const info = await stat(root).catch(error => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!info?.isDirectory()) throw new Error(`extension output is not a directory: ${root}`);
    for (const file of await filesIn(root)) {
      if (!SCANNED_EXTENSIONS.has(extname(file).toLowerCase())) continue;
      const text = await readFile(file, "utf8");
      const lower = text.toLowerCase();
      const rel = posix(relative(root, file));
      // Any remote script host is forbidden, not only the known CDN list.
      for (const match of text.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']\s*((?:https?:|\/\/|data:)[^"']*)/giu)) {
        hits.push({ file: rel, host: match[1], line: text.slice(0, match.index).split("\n").length });
      }
      for (const host of REMOTE_HOSTS) {
        const index = lower.indexOf(host);
        if (index < 0 || allowed(rel, host)) continue;
        const line = text.slice(0, index).split("\n").length;
        hits.push({ file: rel, host, line });
      }
    }
  }
  return hits;
}

export async function assertNoRemoteCode(directories) {
  const hits = await findRemoteCode(directories);
  if (!hits.length) return;
  const details = hits.map(hit => `${hit.file}:${hit.line} ${hit.host}`).join("\n");
  throw new Error(`remotely hosted code in extension output:\n${details}`);
}

async function defaultDirectories() {
  const dist = resolve(ROOT, "dist");
  const entries = await readdir(dist, { withFileTypes: true }).catch(error => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  return entries
    .filter(entry => entry.isDirectory() && (entry.name === "extension" || entry.name.startsWith("extension-")))
    .map(entry => resolve(dist, entry.name))
    .sort();
}

async function main() {
  const directories = process.argv.slice(2);
  const targets = directories.length ? directories.map(path => resolve(path)) : await defaultDirectories();
  if (!targets.length) throw new Error("no dist/extension* output to scan");
  await assertNoRemoteCode(targets);
  console.log(`no remote code in ${targets.length} extension ${targets.length === 1 ? "directory" : "directories"}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}
