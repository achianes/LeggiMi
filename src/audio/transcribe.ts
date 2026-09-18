// Offline speech-to-text for shared audio files: the native decoder turns any
// audio into 16 kHz mono WAV, whisper.cpp (whisper.rn) transcribes it on the
// phone. Only the model is downloaded once; the audio never leaves the device.
import { NativeModules } from "react-native";
import RNFS from "react-native-fs";
import AsyncStorage from "@react-native-async-storage/async-storage";
// the package exports map has no "." entry: import the index subpath explicitly
import { initWhisper, WhisperContext } from "whisper.rn/index";

export type WhisperModelKey = "tiny" | "base" | "small";

export const WHISPER_MODELS: Record<WhisperModelKey, { file: string; bytes: number; label: string; note: string }> = {
  tiny: { file: "ggml-tiny-q5_1.bin", bytes: 32152673, label: "Fast", note: "32 MB · quickest, rougher text" },
  base: { file: "ggml-base-q5_1.bin", bytes: 59707625, label: "Balanced", note: "60 MB · good for most recordings" },
  small: { file: "ggml-small-q5_1.bin", bytes: 190085487, label: "Accurate", note: "190 MB · best text, slower" },
};

const MODEL_URL = (file: string) => `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${file}`;
const MODEL_DIR = `${RNFS.DocumentDirectoryPath}/whisper`;
const MODEL_KEY_SETTING = "settings:whisperModel";

export const AUDIO_EXTS = ["mp3", "m4a", "aac", "wav", "ogg", "oga", "opus", "flac", "amr", "3gp", "3gpp", "wma", "mka", "weba", "webm", "mp4", "m4b"];

export function isAudio(name: string, mime?: string | null) {
  const m = (mime ?? "").toLowerCase();
  if (m.startsWith("audio/")) return true;
  if (m.startsWith("video/") || m.startsWith("image/") || m.startsWith("text/") || m.includes("pdf")) return false;
  const ext = (name.toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || "";
  return AUDIO_EXTS.includes(ext);
}

export async function getModelKey(): Promise<WhisperModelKey> {
  const v = await AsyncStorage.getItem(MODEL_KEY_SETTING).catch(() => null);
  return v === "tiny" || v === "small" || v === "base" ? v : "base";
}

export async function setModelKey(k: WhisperModelKey) {
  await AsyncStorage.setItem(MODEL_KEY_SETTING, k);
}

export const modelPath = (k: WhisperModelKey) => `${MODEL_DIR}/${WHISPER_MODELS[k].file}`;

export async function hasModel(k: WhisperModelKey) {
  try {
    const p = modelPath(k);
    if (!(await RNFS.exists(p))) return false;
    const st = await RNFS.stat(p);
    return Number(st.size) >= WHISPER_MODELS[k].bytes * 0.98;
  } catch {
    return false;
  }
}

export async function deleteModel(k: WhisperModelKey) {
  await RNFS.unlink(modelPath(k)).catch(() => {});
}

let currentJob: number | null = null;

/** Stops a model download in progress (the partial file is removed). */
export function cancelModelDownload() {
  if (currentJob !== null) {
    try { RNFS.stopDownload(currentJob); } catch {}
  }
}

/** Downloads the model once (resumes are not supported: a failed download is removed). */
export async function downloadModel(k: WhisperModelKey, onProgress: (fraction: number) => void) {
  await RNFS.mkdir(MODEL_DIR).catch(() => {});
  const tmp = `${modelPath(k)}.part`;
  await RNFS.unlink(tmp).catch(() => {});
  const job = RNFS.downloadFile({
    fromUrl: MODEL_URL(WHISPER_MODELS[k].file),
    toFile: tmp,
    background: true,
    progressDivider: 2,
    // fail instead of waiting forever when the connection drops
    connectionTimeout: 15000,
    readTimeout: 30000,
    progress: (r) => {
      const total = r.contentLength > 0 ? r.contentLength : WHISPER_MODELS[k].bytes;
      onProgress(Math.min(1, r.bytesWritten / total));
    },
  });
  currentJob = job.jobId;
  let res;
  try {
    res = await job.promise;
  } catch (e: any) {
    await RNFS.unlink(tmp).catch(() => {});
    const msg = String(e?.message ?? e);
    throw new Error(/abort|cancel/i.test(msg) ? "Cancelled" : `Download failed: ${msg}. Check the connection and try again.`);
  } finally {
    currentJob = null;
  }
  if (res.statusCode !== 200) {
    await RNFS.unlink(tmp).catch(() => {});
    throw new Error(`Download failed (HTTP ${res.statusCode})`);
  }
  await RNFS.unlink(modelPath(k)).catch(() => {});
  await RNFS.moveFile(tmp, modelPath(k));
}

let cached: { key: WhisperModelKey; ctx: WhisperContext } | null = null;

async function contextFor(k: WhisperModelKey) {
  if (cached && cached.key === k) return cached.ctx;
  if (cached) {
    await cached.ctx.release().catch(() => {});
    cached = null;
  }
  const ctx = await initWhisper({ filePath: modelPath(k) });
  cached = { key: k, ctx };
  return ctx;
}

export type Transcript = { text: string; language: string; durationMs: number };

/**
 * Decodes and transcribes an audio file. Segments separated by a pause of more
 * than ~1.2 s start a new paragraph, so the reader gets readable blocks.
 */
export async function transcribeAudio(
  src: string,
  k: WhisperModelKey,
  onStage: (stage: "decoding" | "loading" | "transcribing", progress?: number) => void
): Promise<Transcript> {
  const N: any = (NativeModules as any).LeggiMiScan;
  if (!N?.decodeAudio) throw new Error("This build has no audio decoder. Install the latest LeggiMi build.");
  onStage("decoding");
  const wav = `${RNFS.CachesDirectoryPath}/transcribe_${Date.now()}.wav`;
  const dec: { path: string; durationMs: number } = await N.decodeAudio(src, wav);
  try {
    if (dec.durationMs < 300) throw new Error("The recording is empty or too short.");
    onStage("loading");
    const ctx = await contextFor(k);
    onStage("transcribing", 0);
    const { promise } = ctx.transcribe(`file://${dec.path}`, {
      language: "auto",
      maxLen: 0,
      onProgress: (p: number) => onStage("transcribing", p / 100),
    } as any);
    const r = await promise;
    const segs = (r.segments || []).filter((s: { text: string }) => s.text && s.text.trim());
    let text = "";
    let prevEnd = -1;
    for (const s of segs) {
      const t = s.text.trim();
      // t0/t1 are in 10 ms units
      const gap = prevEnd >= 0 ? (s.t0 - prevEnd) * 10 : 0;
      if (!text) text = t;
      else if (gap > 1200) text += `\n\n${t}`;
      else text += ` ${t}`;
      prevEnd = s.t1;
    }
    if (!text) text = (r.result || "").trim();
    return { text, language: r.language || "", durationMs: dec.durationMs };
  } finally {
    RNFS.unlink(dec.path).catch(() => {});
  }
}

export function fmtDuration(ms: number) {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const p = (n: number) => `${n}`.padStart(2, "0");
  return h ? `${h}:${p(m % 60)}:${p(s % 60)}` : `${m}:${p(s % 60)}`;
}
