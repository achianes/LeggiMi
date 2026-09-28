// Natural voices on the phone: Piper (VITS) models run by sherpa-onnx. A voice
// is downloaded once (a .tar.bz2 from the sherpa-onnx releases, unpacked by the
// native module); after that everything is synthesised on the device.
import { DeviceEventEmitter, NativeModules } from "react-native";
import RNFS from "react-native-fs";
import { t } from "../i18n";

export type PiperVoiceKey = string;

export type PiperVoice = {
  file: string;
  bytes: number;
  label: string;
  /** BCP-47, e.g. "it-IT" */
  lang: string;
  gender: "f" | "m" | "";
  quality: "x_low" | "low" | "medium" | "high";
};

// int8 Piper voices from the sherpa-onnx "tts-models" release, a few good ones per language
export const PIPER_VOICES: Record<PiperVoiceKey, PiperVoice> = {
  "it-paola": { file: "vits-piper-it_IT-paola-medium-int8.tar.bz2", bytes: 21143212, label: "Paola", lang: "it-IT", gender: "f", quality: "medium" },
  "it-riccardo": { file: "vits-piper-it_IT-riccardo-x_low-int8.tar.bz2", bytes: 13329285, label: "Riccardo", lang: "it-IT", gender: "m", quality: "x_low" },
  "it-dii": { file: "vits-piper-it_IT-dii-high-int8.tar.bz2", bytes: 20998284, label: "Dii", lang: "it-IT", gender: "", quality: "high" },
  "it-miro": { file: "vits-piper-it_IT-miro-high-int8.tar.bz2", bytes: 21238206, label: "Miro", lang: "it-IT", gender: "", quality: "high" },
  "en-amy": { file: "vits-piper-en_US-amy-medium-int8.tar.bz2", bytes: 21028122, label: "Amy", lang: "en-US", gender: "f", quality: "medium" },
  "en-ryan": { file: "vits-piper-en_US-ryan-medium-int8.tar.bz2", bytes: 21083446, label: "Ryan", lang: "en-US", gender: "m", quality: "medium" },
  "en-lessac": { file: "vits-piper-en_US-lessac-medium-int8.tar.bz2", bytes: 20969179, label: "Lessac", lang: "en-US", gender: "f", quality: "medium" },
  "en-joe": { file: "vits-piper-en_US-joe-medium-int8.tar.bz2", bytes: 21230019, label: "Joe", lang: "en-US", gender: "m", quality: "medium" },
  "en-kristin": { file: "vits-piper-en_US-kristin-medium-int8.tar.bz2", bytes: 20882061, label: "Kristin", lang: "en-US", gender: "f", quality: "medium" },
  "en-alan": { file: "vits-piper-en_GB-alan-medium-int8.tar.bz2", bytes: 21103831, label: "Alan", lang: "en-GB", gender: "m", quality: "medium" },
  "en-alba": { file: "vits-piper-en_GB-alba-medium-int8.tar.bz2", bytes: 21104326, label: "Alba", lang: "en-GB", gender: "f", quality: "medium" },
  "en-cori": { file: "vits-piper-en_GB-cori-medium-int8.tar.bz2", bytes: 20768736, label: "Cori", lang: "en-GB", gender: "f", quality: "medium" },
  "en-jenny": { file: "vits-piper-en_GB-jenny_dioco-medium-int8.tar.bz2", bytes: 20950036, label: "Jenny", lang: "en-GB", gender: "f", quality: "medium" },
  "es-davefx": { file: "vits-piper-es_ES-davefx-medium-int8.tar.bz2", bytes: 21171632, label: "Davefx", lang: "es-ES", gender: "m", quality: "medium" },
  "es-carlfm": { file: "vits-piper-es_ES-carlfm-x_low-int8.tar.bz2", bytes: 13356095, label: "Carlfm", lang: "es-ES", gender: "m", quality: "x_low" },
  "es-miro": { file: "vits-piper-es_ES-miro-high-int8.tar.bz2", bytes: 21273088, label: "Miro", lang: "es-ES", gender: "", quality: "high" },
  "es-ald": { file: "vits-piper-es_MX-ald-medium-int8.tar.bz2", bytes: 21283187, label: "Ald", lang: "es-MX", gender: "m", quality: "medium" },
  "es-claude": { file: "vits-piper-es_MX-claude-high-int8.tar.bz2", bytes: 21216685, label: "Claude", lang: "es-MX", gender: "", quality: "high" },
  "es-daniela": { file: "vits-piper-es_AR-daniela-high-int8.tar.bz2", bytes: 35069782, label: "Daniela", lang: "es-AR", gender: "f", quality: "high" },
  "fr-siwis": { file: "vits-piper-fr_FR-siwis-medium-int8.tar.bz2", bytes: 20914888, label: "Siwis", lang: "fr-FR", gender: "f", quality: "medium" },
  "fr-tom": { file: "vits-piper-fr_FR-tom-medium-int8.tar.bz2", bytes: 21019617, label: "Tom", lang: "fr-FR", gender: "m", quality: "medium" },
  "fr-gilles": { file: "vits-piper-fr_FR-gilles-low-int8.tar.bz2", bytes: 21248965, label: "Gilles", lang: "fr-FR", gender: "m", quality: "low" },
  "fr-miro": { file: "vits-piper-fr_FR-miro-high-int8.tar.bz2", bytes: 21268816, label: "Miro", lang: "fr-FR", gender: "", quality: "high" },
  "de-thorsten": { file: "vits-piper-de_DE-thorsten-medium-int8.tar.bz2", bytes: 20949833, label: "Thorsten", lang: "de-DE", gender: "m", quality: "medium" },
  "de-kerstin": { file: "vits-piper-de_DE-kerstin-low-int8.tar.bz2", bytes: 21174728, label: "Kerstin", lang: "de-DE", gender: "f", quality: "low" },
  "de-ramona": { file: "vits-piper-de_DE-ramona-low-int8.tar.bz2", bytes: 21199380, label: "Ramona", lang: "de-DE", gender: "f", quality: "low" },
  "de-karlsson": { file: "vits-piper-de_DE-karlsson-low-int8.tar.bz2", bytes: 21126670, label: "Karlsson", lang: "de-DE", gender: "m", quality: "low" },
  "de-dii": { file: "vits-piper-de_DE-dii-high-int8.tar.bz2", bytes: 21030921, label: "Dii", lang: "de-DE", gender: "", quality: "high" },
  "de-miro": { file: "vits-piper-de_DE-miro-high-int8.tar.bz2", bytes: 21280966, label: "Miro", lang: "de-DE", gender: "", quality: "high" },
};
export const PIPER_KEYS = Object.keys(PIPER_VOICES) as PiperVoiceKey[];

const REGION_NAMES: Record<string, string> = {
  "it-IT": "Italian", "en-US": "English (US)", "en-GB": "English (UK)", "es-ES": "Spanish (Spain)",
  "es-MX": "Spanish (Mexico)", "es-AR": "Spanish (Argentina)", "fr-FR": "French", "de-DE": "German",
};
const QUALITY: Record<PiperVoice["quality"], string> = { x_low: "fastest", low: "light", medium: "natural", high: "high quality" };

/** "Italian · female · natural · 21 MB", in the app's language */
export function voiceNote(v: PiperVoice, withSize = true) {
  const parts = [t(REGION_NAMES[v.lang] ?? v.lang)];
  if (v.gender) parts.push(t(v.gender === "f" ? "female" : "male"));
  parts.push(t(QUALITY[v.quality]));
  if (withSize) parts.push(`${Math.round(v.bytes / 1048576)} MB`);
  return parts.join(" · ");
}

/** the language part of a voice: "it", "en"… */
export const voiceLang = (v: PiperVoice) => v.lang.slice(0, 2);

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
