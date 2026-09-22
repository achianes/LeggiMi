// A small language model on the phone (llama.cpp through llama.rn): explains,
// summarises and simplifies what is being read. The model is downloaded once;
// after that nothing leaves the device.
import RNFS from "react-native-fs";
import { initLlama, LlamaContext, releaseAllLlama } from "llama.rn";

export type LlmKey = "gemma1b";
export const LLM_MODELS: Record<LlmKey, { file: string; url: string; bytes: number; label: string; note: string }> = {
  gemma1b: {
    file: "google_gemma-3-1b-it-Q4_K_M.gguf",
    url: "https://huggingface.co/bartowski/google_gemma-3-1b-it-GGUF/resolve/main/google_gemma-3-1b-it-Q4_K_M.gguf",
    bytes: 806058496,
    label: "Gemma 3 1B",
    note: "806 MB · Google's small open model, many languages",
  },
};
export const LLM_DEFAULT: LlmKey = "gemma1b";
const DIR = `${RNFS.DocumentDirectoryPath}/llm`;
export const llmPath = (k: LlmKey) => `${DIR}/${LLM_MODELS[k].file}`;

export async function hasLlm(k: LlmKey = LLM_DEFAULT) {
  try {
    const p = llmPath(k);
    if (!(await RNFS.exists(p))) return false;
    return Number((await RNFS.stat(p)).size) >= LLM_MODELS[k].bytes * 0.98;
  } catch {
    return false;
  }
}

export async function deleteLlm(k: LlmKey = LLM_DEFAULT) {
  await releaseLlm();
  await RNFS.unlink(llmPath(k)).catch(() => {});
}

let job: number | null = null;
export function cancelLlmDownload() {
  if (job !== null) { try { RNFS.stopDownload(job); } catch {} }
}

export async function downloadLlm(k: LlmKey, onProgress: (f: number) => void) {
  await RNFS.mkdir(DIR).catch(() => {});
  const tmp = `${llmPath(k)}.part`;
  await RNFS.unlink(tmp).catch(() => {});
  const d = RNFS.downloadFile({
    fromUrl: LLM_MODELS[k].url,
    toFile: tmp,
    background: true,
    progressDivider: 1,
    connectionTimeout: 15000,
    readTimeout: 60000,
    progress: (r) => onProgress(Math.min(1, r.bytesWritten / (r.contentLength > 0 ? r.contentLength : LLM_MODELS[k].bytes))),
  });
  job = d.jobId;
  let res;
  try {
    res = await d.promise;
  } catch (e: any) {
    await RNFS.unlink(tmp).catch(() => {});
    const msg = String(e?.message ?? e);
    throw new Error(/abort|cancel/i.test(msg) ? "Cancelled" : `Download failed: ${msg}. Check the connection and try again.`);
  } finally {
    job = null;
  }
  if (res.statusCode !== 200) {
    await RNFS.unlink(tmp).catch(() => {});
    throw new Error(`Download failed (HTTP ${res.statusCode})`);
  }
  await RNFS.unlink(llmPath(k)).catch(() => {});
  await RNFS.moveFile(tmp, llmPath(k));
}

let ctx: LlamaContext | null = null;
let ctxKey: LlmKey | null = null;

export async function loadLlm(k: LlmKey = LLM_DEFAULT, onProgress?: (f: number) => void): Promise<LlamaContext> {
  if (ctx && ctxKey === k) return ctx;
  await releaseLlm();
  const c = await initLlama(
    { model: llmPath(k), n_ctx: 4096, n_batch: 256, n_threads: 4, use_mlock: false, n_gpu_layers: 0 },
    (p) => onProgress?.(p / 100)
  );
  ctx = c;
  ctxKey = k;
  return c;
}

export async function releaseLlm() {
  try { await releaseAllLlama(); } catch {}
  ctx = null;
  ctxKey = null;
}

export async function stopLlm() {
  try { await ctx?.stopCompletion(); } catch {}
}

export type AskKind = "explain" | "summary" | "simple" | "meaning";

/** the instruction for each kind; the answer is asked in the language of the text */
export function buildMessages(kind: AskKind, text: string, langName: string) {
  const system =
    `You are a patient reading companion inside an app that reads documents aloud. Answer in ${langName}, ` +
    `in plain words, in 3 to 6 short sentences. Start directly with the substance: no greeting, no preamble, no closing question or offer. ` +
    `Never mention that you are an AI. Do not use Markdown, lists or headings: just sentences.`;
  const ask =
    kind === "summary" ? "Summarise this passage: what happens and what matters." :
    kind === "simple" ? "Rewrite this passage with very simple words, keeping every idea, so that a child or a tired reader understands it." :
    kind === "meaning" ? "Explain what this sentence means and why it is said here. If there are difficult words or names, explain them." :
    "Explain this passage: its meaning, the context, and anything a reader might miss.";
  // Gemma's chat template has no system turn: the instructions open the user turn
  return [{ role: "user", content: `${system}\n\n${ask}\n\n"""\n${text}\n"""` }];
}

/** streams the answer; resolves with the full text */
export async function askLlm(kind: AskKind, text: string, langName: string, onToken: (partial: string) => void): Promise<string> {
  const c = await loadLlm();
  let out = "";
  const res = await c.completion(
    {
      messages: buildMessages(kind, text.slice(0, 6000), langName),
      n_predict: 320,
      temperature: 0.4,
      top_p: 0.9,
      penalty_repeat: 1.1,
      stop: ["<end_of_turn>", "<|im_end|>", "</s>"],
    },
    (d) => { out += d.token; onToken(out); }
  );
  return (res.text || out).trim();
}
