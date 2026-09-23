// Natural voices on the phone: Piper (VITS) models run by sherpa-onnx. A voice
// is downloaded once (a .tar.bz2 from the sherpa-onnx releases, unpacked by the
// native module); after that everything is synthesised on the device.
import { DeviceEventEmitter, NativeModules } from "react-native";
import RNFS from "react-native-fs";

export type PiperVoiceKey = "it-paola" | "it-riccardo" | "en-amy" | "en-ryan" | "en-alan" | "en-alba";

export type PiperVoice = { file: string; bytes: number; label: string; lang: string; note: string };

export const PIPER_VOICES: Record<PiperVoiceKey, PiperVoice> = {
  "it-paola": { file: "vits-piper-it_IT-paola-medium-int8.tar.bz2", bytes: 21143212, label: "Paola", lang: "it-IT", note: "Italian · female · 21 MB" },
  "it-riccardo": { file: "vits-piper-it_IT-riccardo-x_low-int8.tar.bz2", bytes: 13329285, label: "Riccardo", lang: "it-IT", note: "Italian · male · 13 MB, fastest" },
  "en-amy": { file: "vits-piper-en_US-amy-medium-int8.tar.bz2", bytes: 21028122, label: "Amy", lang: "en-US", note: "English (US) · female · 21 MB" },
  "en-ryan": { file: "vits-piper-en_US-ryan-medium-int8.tar.bz2", bytes: 21083446, label: "Ryan", lang: "en-US", note: "English (US) · male · 21 MB" },
  "en-alan": { file: "vits-piper-en_GB-alan-medium-int8.tar.bz2", bytes: 21103831, label: "Alan", lang: "en-GB", note: "English (UK) · male · 21 MB" },
  "en-alba": { file: "vits-piper-en_GB-alba-medium-int8.tar.bz2", bytes: 21104326, label: "Alba", lang: "en-GB", note: "English (UK) · female · 21 MB" },
};
export const PIPER_KEYS = Object.keys(PIPER_VOICES) as PiperVoiceKey[];

const VOICE_URL = (file: string) => `https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/${file}`;
const ROOT = `${RNFS.DocumentDirectoryPath}/piper`;
const voiceDir = (k: PiperVoiceKey) => `${ROOT}/${k}`;
const readyFile = (k: PiperVoiceKey) => `${voiceDir(k)}/ready.txt`;

/** voice ids of the reader look like "piper:it-paola" */
export const PIPER_PREFIX = "piper:";
export const isPiperVoice = (id: string | null | undefined): id is string => !!id && id.startsWith(PIPER_PREFIX);
export const piperKeyOf = (id: string): PiperVoiceKey | null => {
  const k = id.slice(PIPER_PREFIX.length) as PiperVoiceKey;
  return PIPER_VOICES[k] ? k : null;
};

type Native = {
  extract(archive: string, dest: string): Promise<string>;
  load(dir: string): Promise<{ sampleRate: number; numSpeakers: number }>;
  unload(): Promise<boolean>;
  prepare(id: string, text: string, speed: number): void;
  speak(id: string, text: string, speed: number): Promise<boolean>;
  stop(): Promise<boolean>;
  synthesizeToWav(texts: string[], speed: number, out: string): Promise<string>;
  encodeToM4a(wav: string, out: string): Promise<string>;
};
const native = NativeModules.LeggiMiPiper as Native | undefined;

export const piperAvailable = () => !!native;

/** the model folder of a downloaded voice, or null */
export async function piperVoiceFolder(k: PiperVoiceKey): Promise<string | null> {
  try {
    if (!(await RNFS.exists(readyFile(k)))) return null;
    const folder = (await RNFS.readFile(readyFile(k), "utf8")).trim();
    return (await RNFS.exists(`${folder}/tokens.txt`)) ? folder : null;
  } catch {
    return null;
  }
}

export async function hasPiperVoice(k: PiperVoiceKey) {
  return (await piperVoiceFolder(k)) !== null;
}

export async function deletePiperVoice(k: PiperVoiceKey) {
  if (loadedDir && loadedDir.startsWith(voiceDir(k))) {
    loadedDir = null;
    await native?.unload().catch(() => {});
  }
  await RNFS.unlink(voiceDir(k)).catch(() => {});
}

let currentJob: number | null = null;

export function cancelPiperDownload() {
  if (currentJob !== null) {
    try { RNFS.stopDownload(currentJob); } catch {}
  }
}

/** Downloads and unpacks a voice. `onStage` gets the download fraction, then "unpacking". */
export async function downloadPiperVoice(k: PiperVoiceKey, onStage: (s: number | "unpacking") => void) {
  if (!native) throw new Error("Neural voices are not available in this build.");
  const v = PIPER_VOICES[k];
  const dir = voiceDir(k);
  await RNFS.mkdir(dir).catch(() => {});
  const tmp = `${dir}/voice.tar.bz2`;
  await RNFS.unlink(tmp).catch(() => {});
  const job = RNFS.downloadFile({
    fromUrl: VOICE_URL(v.file),
    toFile: tmp,
    background: true,
    progressDivider: 2,
    connectionTimeout: 15000,
    readTimeout: 30000,
    progress: (r) => {
      const total = r.contentLength > 0 ? r.contentLength : v.bytes;
      onStage(Math.min(1, r.bytesWritten / total));
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
  onStage("unpacking");
  try {
    const folder = await native.extract(tmp, dir);
    await RNFS.writeFile(readyFile(k), folder, "utf8");
  } finally {
    await RNFS.unlink(tmp).catch(() => {});
  }
}

let loadedDir: string | null = null;

/** Loads the voice into the engine (fast when it is already the loaded one). */
export async function loadPiperVoice(k: PiperVoiceKey) {
  if (!native) throw new Error("Neural voices are not available in this build.");
  const folder = await piperVoiceFolder(k);
  if (!folder) throw new Error("This voice is not downloaded yet.");
  if (loadedDir === folder) return;
  await native.load(folder);
  loadedDir = folder;
}

export const piper = {
  prepare(id: string, text: string, speed: number) {
    try { native?.prepare(id, text, speed); } catch {}
  },
  async speak(id: string, text: string, speed: number) {
    if (!native) throw new Error("Neural voices are not available in this build.");
    await native.speak(id, text, speed);
  },
  async stop() {
    try { await native?.stop(); } catch {}
  },
  async synthesizeToWav(texts: string[], speed: number, out: string) {
    if (!native) throw new Error("Neural voices are not available in this build.");
    return native.synthesizeToWav(texts, speed, out);
  },
  async encodeToM4a(wav: string, out: string) {
    if (!native) throw new Error("Neural voices are not available in this build.");
    return native.encodeToM4a(wav, out);
  },
  /** finish / cancel / error of the utterance being played */
  onDone(cb: (kind: "finish" | "cancel" | "error", id: string, message?: string) => void) {
    const a = DeviceEventEmitter.addListener("piper-finish", (id: string) => cb("finish", id));
    const b = DeviceEventEmitter.addListener("piper-cancel", (id: string) => cb("cancel", id));
    const c = DeviceEventEmitter.addListener("piper-error", (e: any) => cb("error", String(e?.id ?? ""), String(e?.message ?? "")));
    return () => { a.remove(); b.remove(); c.remove(); };
  },
  onProgress(cb: (id: string, location: number, length: number) => void) {
    const s = DeviceEventEmitter.addListener("piper-progress", (e: any) => cb(String(e?.id ?? ""), Number(e?.location ?? -1), Number(e?.length ?? 0)));
    return () => s.remove();
  },
  /** loudness (0..~0.5 RMS) of the voice while it plays, ~20 times a second */
  onLevel(cb: (level: number) => void) {
    const s = DeviceEventEmitter.addListener("piper-level", (v: number) => cb(Number(v) || 0));
    return () => s.remove();
  },
  onFileProgress(cb: (done: number, total: number) => void) {
    const s = DeviceEventEmitter.addListener("piper-file-progress", (e: any) => cb(Number(e?.done ?? 0), Number(e?.total ?? 0)));
    return () => s.remove();
  },
};
