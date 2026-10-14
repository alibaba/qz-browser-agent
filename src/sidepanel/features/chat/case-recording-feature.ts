import { requestBrowserPermission, permissionT } from "../../ui/browser-permissions.js";
import { t } from "../../i18n/index.js";
interface RecordingOptions {
  button?: HTMLButtonElement | null;
  showToast?(message: string, options?: { tone: string }): void;
}
interface CaptureSource { streamId: string; options?: { canRequestAudioTrack?: boolean }; error?: string }
interface DesktopTrackConstraints extends MediaTrackConstraints {
  mandatory: { chromeMediaSource: string; chromeMediaSourceId: string; maxFrameRate?: number };
}

export function createCaseRecordingFeature(options: RecordingOptions = {}) {
  const button = options.button || null;
  const showToast = options.showToast || (() => {});
  let caseRecordingStatus = "idle";
  let caseRecorder: MediaRecorder | null = null;
  let caseStream: MediaStream | null = null;
  let caseRecordingChunks: Blob[] = [];
  let caseRecordingStartedAt = 0;

async function toggleCaseRecording() {
  if (!button || button.disabled) return;
  button.disabled = true;
  try {
    if (caseRecordingStatus === "recording") {
      const result = await stopCaseRecording();
      showToast(result.filename ? t("recordingSaved", { filename: result.filename }) : t("recordingStopped"));
    } else {
      if (!await requestBrowserPermission("desktopCapture")) {
        showToast(permissionT("denied", { permission: permissionT("name.desktopCapture") }));
        return;
      }
      const capture = await chooseCaseRecordingSource();
      if (capture.error) {
        showToast(capture.error, { tone: "error" });
        return;
      }
      if (!capture.streamId) {
        showToast(t("recordingCancelled"));
        return;
      }
      await startCaseRecording(capture);
      showToast(t("recordingStarted"));
    }
  } catch (err) {
    showToast(err instanceof Error ? err.message : t("recordingFailed"), { tone: "error" });
  } finally {
    button.disabled = false;
    renderCaseRecordingButton();
  }
}

async function startCaseRecording({ streamId, options = {} }: CaptureSource) {
  if (caseRecorder?.state === "recording") throw new Error("case recording is already running");
  const constraints: { audio: DesktopTrackConstraints | false; video: DesktopTrackConstraints } = {
    audio: options?.canRequestAudioTrack ? {
      mandatory: {
        chromeMediaSource: "desktop",
        chromeMediaSourceId: streamId,
      },
    } : false,
    video: {
      mandatory: {
        chromeMediaSource: "desktop",
        chromeMediaSourceId: streamId,
        maxFrameRate: 30,
      },
    },
  };
  try {
    caseStream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    if (!constraints.audio) throw err;
    caseStream = await navigator.mediaDevices.getUserMedia({ ...constraints, audio: false });
  }
  caseRecordingChunks = [];
  caseRecordingStartedAt = Date.now();
  const mimeType = chooseCaseRecordingMimeType();
  caseRecorder = new MediaRecorder(caseStream, mimeType ? { mimeType } : undefined);
  caseRecorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) caseRecordingChunks.push(event.data);
  };
  caseRecorder.onstop = () => {
    for (const track of caseStream?.getTracks?.() || []) track.stop();
    caseStream = null;
  };
  for (const track of caseStream.getTracks()) {
    track.addEventListener("ended", () => {
      if (caseRecordingStatus === "recording") {
        stopCaseRecording()
          .then((result) => showToast(result.filename ? t("recordingSaved", { filename: result.filename }) : t("recordingStopped")))
          .catch((err) => showToast(err instanceof Error ? err.message : t("recordingSaveFailed"), { tone: "error" }));
      }
    }, { once: true });
  }
  caseRecorder.start(1000);
  updateCaseRecordingState({ status: "recording" });
}

async function stopCaseRecording() {
  if (!caseRecorder || caseRecorder.state === "inactive") {
    updateCaseRecordingState({ status: "idle" });
    return { filename: "" };
  }
  const recorder = caseRecorder;
  caseRecordingStatus = "stopping";
  const stopped = new Promise<void>((resolve) => {
    recorder.addEventListener("stop", () => resolve(), { once: true });
  });
  recorder.stop();
  await stopped;
  const mimeType = recorder.mimeType || "video/webm";
  const blob = new Blob(caseRecordingChunks, { type: mimeType });
  const format = caseRecordingFormatFromMimeType(mimeType);
  const filename = `qingzhou-case-${caseRecordingTimestamp(new Date())}.${format.extension}`;
  downloadCaseRecordingBlob(blob, filename);
  const result = {
    filename,
    mimeType,
    format: format.extension,
    durationMs: Date.now() - caseRecordingStartedAt,
    size: blob.size,
  };
  caseRecorder = null;
  caseRecordingChunks = [];
  caseRecordingStartedAt = 0;
  updateCaseRecordingState({ status: "idle" });
  return result;
}

function chooseCaseRecordingSource(): Promise<CaptureSource> {
  if (!chrome.desktopCapture?.chooseDesktopMedia) {
    return Promise.resolve({ streamId: "", options: {}, error: "desktopCapture is unavailable" });
  }
  return new Promise((resolve) => {
    chrome.desktopCapture.chooseDesktopMedia(["window", "screen", "audio"], (streamId, options: CaptureSource["options"] = {}) => {
      resolve({ streamId, options });
    });
  });
}

function chooseCaseRecordingMimeType() {
  const candidates = [
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/mp4;codecs=h264,aac",
    "video/mp4",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

function caseRecordingFormatFromMimeType(mimeType = "") {
  const type = String(mimeType || "").toLowerCase();
  if (type.includes("mp4")) return { extension: "mp4", mimeType: "video/mp4" };
  return { extension: "webm", mimeType: "video/webm" };
}

function downloadCaseRecordingBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function caseRecordingTimestamp(date: Date) {
  return date.toISOString().replace(/[:.]/g, "-").replace("T", "_").replace("Z", "");
}

function updateCaseRecordingState(event: { status?: string; details?: { status?: string } } = {}) {
  caseRecordingStatus = event.status || event.details?.status || "idle";
  renderCaseRecordingButton();
}

function renderCaseRecordingButton() {
  if (!button) return;
  const recording = caseRecordingStatus === "recording";
  button.classList.toggle("recording", recording);
  button.title = recording ? t("stopSaveRecording") : t("recordCase");
  button.setAttribute("aria-pressed", recording ? "true" : "false");
}

  button?.addEventListener("click", toggleCaseRecording);
  renderCaseRecordingButton();

  return {
    toggle: toggleCaseRecording,
    stop: stopCaseRecording,
    updateState: updateCaseRecordingState,
    getStatus: () => caseRecordingStatus,
  };
}
