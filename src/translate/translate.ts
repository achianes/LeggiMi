// On-device translation of whole documents (ML Kit). The Markdown shape is
// kept: headings stay headings, list items stay list items, paragraphs stay
// paragraphs, so the translated document has the same chapters as the original.
import { DeviceEventEmitter, NativeModules } from "react-native";

export type Lang = { code: string; name: string; flag: string };

/** the languages offered in the picker (ML Kit supports these on the phone) */
export const LANGS: Lang[] = [
  { code: "it", name: "Italian", flag: "🇮🇹" },
  { code: "en", name: "English", flag: "🇬🇧" },
  { code: "es", name: "Spanish", flag: "🇪🇸" },
  { code: "fr", name: "French", flag: "🇫🇷" },
  { code: "de", name: "German", flag: "🇩🇪" },
  { code: "pt", name: "Portuguese", flag: "🇵🇹" },
  { code: "nl", name: "Dutch", flag: "🇳🇱" },
  { code: "ro", name: "Romanian", flag: "🇷🇴" },
  { code: "pl", name: "Polish", flag: "🇵🇱" },
  { code: "el", name: "Greek", flag: "🇬🇷" },
  { code: "ru", name: "Russian", flag: "🇷🇺" },
  { code: "uk", name: "Ukrainian", flag: "🇺🇦" },
  { code: "tr", name: "Turkish", flag: "🇹🇷" },
  { code: "ar", name: "Arabic", flag: "🇸🇦" },
  { code: "zh", name: "Chinese", flag: "🇨🇳" },
  { code: "ja", name: "Japanese", flag: "🇯🇵" },
  { code: "hi", name: "Hindi", flag: "🇮🇳" },
  { code: "sq", name: "Albanian", flag: "🇦🇱" },
];
export const langName = (code: string) => LANGS.find((l) => l.code === code)?.name ?? code.toUpperCase();

type Native = {
  identify(text: string): Promise<string>;
  downloaded(): Promise<string[]>;
  ensure(from: string, to: string): Promise<boolean>;
  deletePack(lang: string): Promise<boolean>;
  cancel(): Promise<boolean>;
  translate(from: string, to: string, texts: string[]): Promise<string[]>;
};
const native = NativeModules.LeggiMiTranslate as Native | undefined;

export const translateAvailable = () => !!native;

export async function detectLanguage(text: string): Promise<string | null> {
  if (!native) return null;
  try {
    const tag = (await native.identify(text)).toLowerCase().split("-")[0];
    return tag && tag !== "und" ? tag : null;
  } catch {
    return null;
  }
}

export const downloadedPacks = async () => (native ? native.downloaded().catch(() => [] as string[]) : []);
export const cancelTranslation = () => native?.cancel().catch(() => {});

/** a Markdown line split into its marker and the text to translate */
function splitMarker(line: string): { marker: string; text: string } {
  const m = line.match(/^(\s*(?:#{1,6}\s+|[-*+•]\s+|\d{1,3}[.)]\s+|>\s*))(.*)$/);
  return m ? { marker: m[1], text: m[2] } : { marker: "", text: line };
}

/**
 * Translates a segmented document. `segs` are the reader's blocks (one sentence
 * or one heading/list item each), `starts[i]` says whether block i opens a new
 * paragraph. Returns the translated blocks and the translated text as Markdown.
 */
export async function translateDocument(
  segs: string[],
  starts: boolean[],
  from: string,
  to: string,
  onProgress: (done: number, total: number) => void
): Promise<{ segs: string[]; text: string }> {
  if (!native) throw new Error("Translation is not available in this build.");
  // every line of every block is translated on its own, markers kept aside
  const jobs: { seg: number; line: number; marker: string; text: string }[] = [];
  const shape = segs.map((s, i) => s.split("\n").map((l, j) => { const p = splitMarker(l); jobs.push({ seg: i, line: j, ...p }); return p; }));
  const inputs = jobs.map((j) => j.text.trim() || " ");
  const sub = DeviceEventEmitter.addListener("translate-progress", (e: any) => onProgress(Number(e?.done ?? 0), Number(e?.total ?? inputs.length)));
  let out: string[];
  try {
    out = await native.translate(from, to, inputs);
  } finally {
    sub.remove();
  }
  jobs.forEach((j, k) => { shape[j.seg][j.line].text = j.text.trim() ? (out[k] ?? j.text).trim() : j.text; });
  const tsegs = shape.map((lines) => lines.map((l) => `${l.marker}${l.text}`).join("\n"));
  // back to Markdown: blank line between paragraphs, sentences of a paragraph on one line
  const parts: string[] = [];
  tsegs.forEach((s, i) => {
    const standalone = /^\s*(#{1,6}\s|[-*+•]\s|\d{1,3}[.)]\s|>)/.test(s) || s.includes("\n");
    if (i === 0 || starts[i] || standalone || (i > 0 && /^\s*(#{1,6}\s|[-*+•]\s|\d{1,3}[.)]\s|>)/.test(tsegs[i - 1]))) parts.push(s);
    else parts[parts.length - 1] += ` ${s}`;
  });
  return { segs: tsegs, text: parts.join("\n\n") };
}
