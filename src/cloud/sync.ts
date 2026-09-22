// Reading positions shared between the user's devices through their own cloud:
// one small JSON file, LeggiMi/leggimi-progress.json, keyed by document id.
// Every device merges by "latest wins" per document, so two phones can both
// write it without stepping on each other.
import AsyncStorage from "@react-native-async-storage/async-storage";
import { cloudNative, loadAccounts } from "./cloud";

export const SYNC_FILE = "leggimi-progress.json";
const SETTING = "settings:cloudSync";

export type RemoteDoc = { name: string; index: number; total: number; at: number; device?: string };
export type RemoteProgress = Record<string, RemoteDoc>;

export async function isSyncOn(): Promise<boolean> {
  const v = await AsyncStorage.getItem(SETTING).catch(() => null);
  return v !== "0";
}
export async function setSyncOn(on: boolean) {
  await AsyncStorage.setItem(SETTING, on ? "1" : "0");
}

/** the account used for sync: the first one configured */
export async function syncAccountId(): Promise<string | null> {
  const list = await loadAccounts();
  return list.length ? list[0].id : null;
}

function parse(raw: string | null): RemoteProgress {
  if (!raw) return {};
  try {
    const j = JSON.parse(raw);
    const docs = j && typeof j === "object" ? j.docs : null;
    return docs && typeof docs === "object" ? docs : {};
  } catch {
    return {};
  }
}

export function mergeProgress(a: RemoteProgress, b: RemoteProgress): RemoteProgress {
  const out: RemoteProgress = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const cur = out[k];
    if (!cur || (v.at ?? 0) > (cur.at ?? 0)) out[k] = v;
  }
  return out;
}

export async function pullProgress(accountId: string): Promise<RemoteProgress> {
  return parse(await cloudNative.readText(accountId, SYNC_FILE));
}

/** merges `docs` into the remote file (latest per document wins) and writes it back */
export async function pushProgress(accountId: string, docs: RemoteProgress, device: string): Promise<RemoteProgress> {
  const remote = await pullProgress(accountId).catch(() => ({} as RemoteProgress));
  const stamped: RemoteProgress = {};
  for (const [k, v] of Object.entries(docs)) stamped[k] = { ...v, device };
  const merged = mergeProgress(remote, stamped);
  // keep the file small: the 200 most recent documents
  const keys = Object.keys(merged).sort((x, y) => (merged[y].at ?? 0) - (merged[x].at ?? 0)).slice(0, 200);
  const trimmed: RemoteProgress = {};
  for (const k of keys) trimmed[k] = merged[k];
  await cloudNative.writeText(accountId, SYNC_FILE, JSON.stringify({ v: 1, updated: Date.now(), docs: trimmed }));
  return trimmed;
}
