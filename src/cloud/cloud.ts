// Cloud accounts (metadata only: passwords and tokens are kept encrypted by the
// native LeggiMiCloud module) and the list of supported providers.
import { NativeModules } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";

export type CloudProvider = "gdrive" | "dropbox" | "nextcloud" | "owncloud" | "pcloud" | "koofr" | "yandex" | "fourshared" | "webdav";

export type CloudAccount = {
  id: string;
  provider: CloudProvider;
  label: string; // e-mail or user name
  addedAt: number;
  free: number; // bytes, -1 = unknown
  total: number;
  used: number;
  checkedAt: number;
};

export type ProviderInfo = {
  name: string;
  icon: string;
  color: string;
  auth: "google" | "dropbox" | "webdav";
  /** WebDAV: how the address is built */
  server?: "ask" | "fixed" | "full";
  urls?: { label: string; url: string }[];
  buildUrl?: (server: string, user: string) => string;
  userLabel?: string;
  passLabel?: string;
  hint: string;
};

const trimSlash = (s: string) => s.trim().replace(/\/+$/, "");
const withScheme = (s: string) => (/^https?:\/\//i.test(s.trim()) ? s.trim() : `https://${s.trim()}`);

export const PROVIDERS: Record<CloudProvider, ProviderInfo> = {
  gdrive: {
    name: "Google Drive",
    icon: "🟢",
    color: "#6BCB77",
    auth: "google",
    hint: "Sign in with your Google account. LeggiMi only sees the files it creates (the LeggiMi folder).",
  },
  dropbox: {
    name: "Dropbox",
    icon: "📦",
    color: "#4D96FF",
    auth: "dropbox",
    hint: "Dropbox only allows apps to sign in through its own page. Create a free Dropbox app once (see below), paste its App key and sign in.",
  },
  nextcloud: {
    name: "Nextcloud",
    icon: "☁️",
    color: "#4ECDC4",
    auth: "webdav",
    server: "ask",
    buildUrl: (server, user) => `${trimSlash(withScheme(server))}/remote.php/dav/files/${encodeURIComponent(user)}/`,
    userLabel: "User name",
    passLabel: "Password or app password",
    hint: "Your server address, e.g. cloud.example.com. With two-factor login create an app password in Settings › Security.",
  },
  owncloud: {
    name: "ownCloud",
    icon: "☁️",
    color: "#B983FF",
    auth: "webdav",
    server: "ask",
    buildUrl: (server) => `${trimSlash(withScheme(server))}/remote.php/webdav/`,
    userLabel: "User name",
    passLabel: "Password or app password",
    hint: "Your server address, e.g. owncloud.example.com.",
  },
  pcloud: {
    name: "pCloud",
    icon: "🌥️",
    color: "#FFD93D",
    auth: "webdav",
    server: "fixed",
    urls: [
      { label: "Europe", url: "https://ewebdav.pcloud.com/" },
      { label: "United States", url: "https://webdav.pcloud.com/" },
    ],
    userLabel: "E-mail",
    passLabel: "pCloud password",
    hint: "Pick the region where your pCloud account was created.",
  },
  koofr: {
    name: "Koofr",
    icon: "🌤️",
    color: "#FF9F45",
    auth: "webdav",
    server: "fixed",
    urls: [{ label: "Koofr", url: "https://app.koofr.net/dav/Koofr/" }],
    userLabel: "E-mail",
    passLabel: "App password",
    hint: "Koofr needs an app password: Preferences › Password › App passwords.",
  },
  yandex: {
    name: "Yandex Disk",
    icon: "💾",
    color: "#FF6B6B",
    auth: "webdav",
    server: "fixed",
    urls: [{ label: "Yandex Disk", url: "https://webdav.yandex.com/" }],
    userLabel: "Login",
    passLabel: "App password",
    hint: "Create an app password for “Files (WebDAV)” in your Yandex ID security settings.",
  },
  fourshared: {
    name: "4shared",
    icon: "🗂️",
    color: "#4D96FF",
    auth: "webdav",
    server: "fixed",
    urls: [{ label: "4shared", url: "https://webdav.4shared.com/" }],
    userLabel: "E-mail",
    passLabel: "Password",
    hint: "Use your 4shared e-mail and password.",
  },
  webdav: {
    name: "Other WebDAV",
    icon: "🗄️",
    color: "#C9C4BC",
    auth: "webdav",
    server: "full",
    userLabel: "User name",
    passLabel: "Password",
    hint: "Full WebDAV address of a NAS (Synology, QNAP), MagentaCLOUD, GMX, Web.de, Infomaniak kDrive and many more.",
  },
};

export const PROVIDER_ORDER: CloudProvider[] = ["gdrive", "dropbox", "nextcloud", "pcloud", "koofr", "yandex", "owncloud", "fourshared", "webdav"];

const KEY = "cloud:accounts";

export async function loadAccounts(): Promise<CloudAccount[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    const l = raw ? JSON.parse(raw) : [];
    return Array.isArray(l) ? l : [];
  } catch {
    return [];
  }
}

export async function saveAccounts(list: CloudAccount[]) {
  await AsyncStorage.setItem(KEY, JSON.stringify(list));
}

type SpaceResult = { id: string; label: string; used: number; total: number; free: number };

const N: any = (NativeModules as any).LeggiMiCloud;

export const cloudNative = {
  available: () => !!N,
  webdavConnect: (url: string, user: string, pass: string, label: string): Promise<SpaceResult> =>
    N.webdavConnect(url, user, pass, label),
  googleConnect: (): Promise<SpaceResult> => N.googleConnect(),
  dropboxConnect: (appKey: string): Promise<SpaceResult> => N.dropboxConnect(appKey),
  info: (id: string): Promise<SpaceResult> => N.info(id),
  upload: (id: string, src: string, name: string, mime: string): Promise<SpaceResult & { path: string; bytes: number }> =>
    N.upload(id, src, name, mime),
  remove: (id: string): Promise<boolean> => N.remove(id),
};

export function fmtSpace(a: { free: number; total: number }) {
  const f = (n: number) =>
    n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(0)} MB` : `${Math.max(0, Math.round(n / 1024))} KB`;
  if (a.free < 0) return "free space not reported";
  return a.total > 0 ? `${f(a.free)} free of ${f(a.total)}` : `${f(a.free)} free`;
}
