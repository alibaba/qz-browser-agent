import { readFileSync } from "node:fs";
import { INSTALL_URL } from "./package-info.mjs";

// The published CLI carries the same sail mark as the browser extension.
export const CONNECT_LOGOS = new Map(["qz-logo.png", "qz-logo-day.png"].map(name =>
  [`/${name}`, readFileSync(new URL(`./${name}`, import.meta.url))]));

export const CONNECT_PAGE = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Connect qz</title>
<style>
:root { color-scheme: light dark; --bg: #f4f4f2; --surface: #fff; --text: #171717; --muted: #5f6368; --border: #e5e5e2; --green: #23815d; --red: #ba3c3c; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100svh; display: grid; place-items: center; padding: 32px 20px; background: var(--bg); color: var(--text); font: 16px/1.6 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
main { width: min(100%, 520px); padding: 44px; background: var(--surface); border: 1px solid var(--border); border-radius: 24px; box-shadow: 0 16px 48px #00000006, 0 2px 6px #00000003; }
.brand { display: flex; align-items: center; gap: 16px; font-size: 24px; font-weight: 650; letter-spacing: -.6px; }
.brand img { display: block; width: 64px; height: 64px; border-radius: 18px; }
h1 { margin: 34px 0 8px; font-size: clamp(25px, 5vw, 30px); line-height: 1.25; font-weight: 620; letter-spacing: -.8px; }
.intro { margin: 0; color: var(--muted); }
[data-qz-connection-status] { position: relative; display: grid; align-content: center; margin: 28px 0 32px; min-height: calc(2lh + 34px); padding: 16px 18px 16px 46px; border: 1px solid var(--border); border-radius: 12px; background: var(--bg); font-size: 14px; overflow-wrap: anywhere; transition: background-color 300ms ease, border-color 300ms ease; }
[data-qz-connection-status]::before { content: ""; position: absolute; inset-inline-start: 18px; top: calc(50% - 6px); width: 12px; height: 12px; border: 1.5px solid var(--border); border-top-color: var(--muted); border-radius: 50%; animation: turn 1s linear infinite; transition: opacity 150ms ease; }
[data-qz-connection-status]::after { content: ""; position: absolute; inset-inline-start: 18px; top: calc(50% - 5px); width: 11px; height: 7px; border: solid var(--green); border-width: 0 0 2px 2px; opacity: 0; transform: rotate(-45deg) scale(.8); transition: opacity 220ms ease 80ms, transform 220ms cubic-bezier(.2,.7,.2,1) 80ms; }
[data-qz-connection-state="connected"] { border-color: color-mix(in srgb, var(--green) 22%, var(--border)); background: color-mix(in srgb, var(--green) 5%, var(--surface)); }
[data-qz-connection-state="connected"]::before { opacity: 0; animation-play-state: paused; }
[data-qz-connection-state="connected"]::after { opacity: 1; transform: rotate(-45deg); }
[data-qz-connection-state="connected"] [data-qz-connection-message] { animation: message-in 240ms ease-out 60ms both; }
[data-qz-connection-state="error"] { border-color: color-mix(in srgb, var(--red) 25%, var(--border)); }
[data-qz-connection-state="error"]::before { border: 0; width: 8px; height: 8px; top: calc(50% - 4px); background: var(--red); animation: none; }
footer { padding-top: 24px; border-top: 1px solid var(--border); color: var(--muted); font-size: 13px; }
footer p { margin: 0 0 6px; }
a { color: var(--text); text-underline-offset: 4px; text-decoration-color: var(--border); }
a:hover { text-decoration-color: currentColor; }
a:focus-visible { outline: 2px solid var(--text); outline-offset: 4px; border-radius: 2px; }
@keyframes turn { to { transform: rotate(360deg); } }
@keyframes message-in { from { opacity: 0; transform: translateY(2px); } to { opacity: 1; transform: translateY(0); } }
@media (prefers-reduced-motion: reduce) { [data-qz-connection-status], [data-qz-connection-status]::before, [data-qz-connection-status]::after, [data-qz-connection-message] { animation: none !important; transition: none !important; } }
@media (max-width: 420px) { body { padding: 20px 16px; } main { padding: 30px 24px; border-radius: 20px; } [data-qz-connection-status] { min-height: calc(3lh + 34px); } }
@media (prefers-color-scheme: dark) { :root { --bg: #171717; --surface: #212121; --text: #f2f2f0; --muted: #a5a5a1; --border: #343434; --green: #6fc6a1; --red: #ec8b8b; } main { box-shadow: 0 16px 48px #00000020; } }
</style>
<main>
  <div class="brand"><picture><source media="(prefers-color-scheme: dark)" srcset="/qz-logo.png"><img src="/qz-logo-day.png" alt="" width="64" height="64"></picture><div>qz</div></div>
  <h1>Connect your browser</h1>
  <p class="intro">Keep this page open while qz connects.</p>
  <p data-qz-connection-status data-qz-connection-state="connecting" role="status" aria-live="polite"><span data-qz-connection-message>Connecting to the qz browser extension…</span></p>
  <footer><p>First time here?</p><a href="${INSTALL_URL}" target="_blank" rel="noopener noreferrer">Install qz from the Chrome Web Store</a></footer>
</main>
</html>`;
