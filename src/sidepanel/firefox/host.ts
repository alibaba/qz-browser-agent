import { disableSessionAutomations, SESSION_AUTOMATION_CONTROL_SELECTORS } from "../../shared/session-automations.js";
import { installFirefoxTheme, type FirefoxThemeChrome } from "./theme.js";

/** Firefox sidebar recording and extension-page links. Chrome call sites stay on their APIs. */

const STREAM_ID = "firefox-display";

export function installSidepanelFirefoxHost(
  chromeApi: SidepanelChrome = globalThis.chrome as unknown as SidepanelChrome,
  media: MediaHost | undefined = globalThis.navigator?.mediaDevices as MediaHost | undefined,
  root: ParentNode | null | undefined = typeof document === "undefined" ? null : document,
): void {
  if (!chromeApi || chromeApi.qzFirefoxSidepanel) return;
  chromeApi.qzFirefoxSidepanel = true;
  disableSessionAutomations(chromeApi);
  if (root) removeSessionAutomationControls(root);
  rewriteExtensionPages(chromeApi);
  installDisplayCapture(chromeApi, media);
  installSidebarTheme(chromeApi);
}

installSidepanelFirefoxHost();

function removeSessionAutomationControls(root: ParentNode): void {
  for (const selector of SESSION_AUTOMATION_CONTROL_SELECTORS) root.querySelector(selector)?.remove();
}

function installSidebarTheme(chromeApi: SidepanelChrome) {
  if (typeof document === "undefined") return;
  installFirefoxTheme(chromeApi, document.documentElement);
}

function rewriteExtensionPages(chromeApi: SidepanelChrome) {
  const tabs = chromeApi.tabs;
  if (typeof tabs?.create === "function") {
    const original = tabs.create.bind(tabs);
    tabs.create = properties => {
      const url = firefoxPageUrl(properties?.url);
      return original({ ...properties, url });
    };
  }
  const permissions = chromeApi.permissions;
  if (typeof permissions?.request === "function") {
    const original = permissions.request.bind(permissions);
    permissions.request = request => {
      const names = request?.permissions || [];
      if (names.length === 1 && names[0] === "desktopCapture") return Promise.resolve(true);
      return original(request);
    };
  }
}

function installDisplayCapture(chromeApi: SidepanelChrome, media: MediaHost | undefined) {
  if (!media?.getDisplayMedia || chromeApi.desktopCapture?.chooseDesktopMedia) return;
  let held: MediaStream | null = null;
  const hold = (stream: MediaStream) => {
    if (held && held !== stream) stopStream(held);
    held = stream;
  };
  if (typeof media.getUserMedia === "function") {
    const original = media.getUserMedia.bind(media);
    media.getUserMedia = constraints => {
      const video = constraints?.video;
      const source = video && typeof video === "object" ? video.mandatory?.chromeMediaSource : "";
      if (source === "desktop" && held) {
        const stream = held;
        held = null;
        if (!constraints?.audio) for (const track of stream.getAudioTracks()) track.stop();
        return Promise.resolve(stream);
      }
      return original(constraints);
    };
  }
  chromeApi.desktopCapture = {
    chooseDesktopMedia(sources, callback) {
      const audio = sources.includes("audio");
      const deliver = (stream: MediaStream) => {
        hold(stream);
        callback(STREAM_ID, { canRequestAudioTrack: stream.getAudioTracks().length > 0 });
      };
      const cancel = () => {
        held = null;
        callback("", {});
      };
      void media.getDisplayMedia({ video: true, audio }).then(deliver, (error: unknown) => {
        if (!audio || userDismissed(error)) { cancel(); return; }
        void media.getDisplayMedia({ video: true, audio: false }).then(deliver, cancel);
      });
      return 1;
    },
  };
}

function firefoxPageUrl(url: string | undefined): string | undefined {
  if (typeof url !== "string") return url;
  if (url.startsWith("chrome://extensions")) return "about:addons";
  if (url.startsWith("chrome://downloads")) return "about:downloads";
  return url;
}

function userDismissed(error: unknown): boolean {
  const name = error && typeof error === "object" && "name" in error ? String(error.name) : "";
  return name === "NotAllowedError" || name === "AbortError";
}

function stopStream(stream: MediaStream) {
  const tracks = typeof stream.getTracks === "function" ? stream.getTracks() : stream.getAudioTracks();
  for (const track of tracks) track.stop();
}

interface TabProperties { url?: string }
interface PermissionRequest { permissions?: string[] }
interface MediaConstraints { audio?: boolean | object; video?: boolean | { mandatory?: { chromeMediaSource?: string; chromeMediaSourceId?: string } } }
interface MediaHost {
  getDisplayMedia(constraints: { video?: boolean; audio?: boolean }): Promise<MediaStream>;
  getUserMedia?(constraints?: MediaConstraints): Promise<MediaStream>;
}
interface SidepanelChrome extends FirefoxThemeChrome {
  qzFirefoxSidepanel?: boolean;
  qzSessionAutomationsEnabled?: boolean;
  tabs?: { create(properties?: TabProperties): unknown };
  permissions?: { request(request?: PermissionRequest): Promise<boolean> };
  desktopCapture?: { chooseDesktopMedia?(sources: string[], callback: (streamId: string, options?: { canRequestAudioTrack?: boolean }) => void): number };
}
