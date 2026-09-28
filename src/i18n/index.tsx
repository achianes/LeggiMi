// The app's own words in five languages. English is the source: every other
// language is a dictionary keyed by the English text (built from the sources by
// _r/extract_strings.js). Translation happens where text is drawn: the Text
// component below translates string children, Alert.alert its title, message
// and buttons. Keys may contain {0}, {1}… for the parts that change.
// Document content is drawn with RawText and is never touched.
import React, { useEffect, useState } from "react";
import { Alert, NativeModules, Text as RNText, TextProps } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";

export type UiLang = "en" | "it" | "es" | "fr" | "de";
export const UI_LANGS: { code: UiLang; name: string; flag: string }[] = [
  { code: "en", name: "English", flag: "🇬🇧" },
  { code: "it", name: "Italiano", flag: "🇮🇹" },
  { code: "es", name: "Español", flag: "🇪🇸" },
  { code: "fr", name: "Français", flag: "🇫🇷" },
  { code: "de", name: "Deutsch", flag: "🇩🇪" },
];

const DICTS: Record<Exclude<UiLang, "en">, Record<string, string>> = {
  it: require("./it.json"),
  es: require("./es.json"),
  fr: require("./fr.json"),
  de: require("./de.json"),
};

const SETTING = "settings:uiLang";

function deviceLang(): UiLang {
  try {
    const raw = String(NativeModules?.I18nManager?.localeIdentifier || "").toLowerCase();
    const base = raw.split(/[-_]/)[0];
    return (UI_LANGS.find((l) => l.code === base)?.code ?? "en") as UiLang;
  } catch {
    return "en";
  }
}

/** "auto" follows the phone; otherwise the chosen language */
let choice: UiLang | "auto" = "auto";
let lang: UiLang = deviceLang();
const listeners = new Set<() => void>();

export const getLang = () => lang;
export const getLangChoice = () => choice;

export async function loadLang() {
  try {
    const v = await AsyncStorage.getItem(SETTING);
    if (v && (v === "auto" || UI_LANGS.some((l) => l.code === v))) applyChoice(v as UiLang | "auto");
  } catch {}
}

function applyChoice(c: UiLang | "auto") {
  choice = c;
  lang = c === "auto" ? deviceLang() : c;
  cache.clear();
  patterns = null;
  listeners.forEach((f) => f());
}

export function setLang(c: UiLang | "auto") {
  applyChoice(c);
  AsyncStorage.setItem(SETTING, c).catch(() => {});
  try { NativeModules.LeggiMiPlayback?.setUiLanguage?.(lang); } catch {}
}

/** re-renders the caller when the language changes */
export function useLang(): UiLang {
  const [, bump] = useState(0);
  useEffect(() => {
    const f = () => bump((x) => x + 1);
    listeners.add(f);
    return () => { listeners.delete(f); };
  }, []);
  return lang;
}

// ---- lookup

const cache = new Map<string, string>();
type Pattern = { re: RegExp; to: string; order: number[] };
let patterns: Pattern[] | null = null;
let lowerDict: Map<string, string> | null = null;
let lowerFor: UiLang | null = null;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function buildPatterns(d: Record<string, string>): Pattern[] {
  const out: Pattern[] = [];
  for (const [k, v] of Object.entries(d)) {
    if (!/\{\d\}/.test(k)) continue;
    // a pattern needs some real words, or it would match anything
    if (k.replace(/\{\d\}/g, "").replace(/[^A-Za-z]/g, "").length < 3) continue;
    // plain numbered groups (no named groups: older Hermes builds lack them)
    const order: number[] = [];
    const src = escapeRe(k).replace(/\\\{(\d)\\\}/g, (_m: string, n: string) => { order.push(Number(n)); return "([\\s\\S]*?)"; });
    try { out.push({ re: new RegExp(`^${src}$`), to: v, order }); } catch {}
  }
  // longest keys first: the most specific wins
  return out.sort((a, b) => b.re.source.length - a.re.source.length);
}

function fill(to: string, groups: Record<number, string> | undefined, args?: (string | number)[]) {
  return to.replace(/\{(\d)\}/g, (_, n) => {
    if (args) return String(args[Number(n)] ?? "");
    return tr(groups?.[Number(n)] ?? "");
  });
}

function lookup(s: string): string | null {
  const d = DICTS[lang as Exclude<UiLang, "en">];
  if (!d) return null;
  const hit = d[s];
  if (hit !== undefined) return hit;
  // POSTER TITLES are keyed as written; a title shown in capitals may also be
  // keyed in normal case
  if (s.length > 1 && s === s.toUpperCase() && /[A-Z]/.test(s)) {
    if (lowerFor !== lang) {
      lowerDict = new Map(Object.entries(d).map(([k, v]) => [k.toLowerCase(), v]));
      lowerFor = lang;
    }
    const v = lowerDict!.get(s.toLowerCase());
    if (v !== undefined) return v.toUpperCase();
  }
  if (!patterns) patterns = buildPatterns(d);
  for (const p of patterns) {
    const m = p.re.exec(s);
    if (m) {
      const groups: Record<number, string> = {};
      p.order.forEach((n, i) => { groups[n] = m[i + 1]; });
      return fill(p.to, groups);
    }
  }
  return null;
}

/** translates a piece of UI text (unknown text comes back unchanged) */
export function tr(s: string): string {
  if (lang === "en" || !s || !/[A-Za-z]/.test(s)) return s;
  const c = cache.get(s);
  if (c !== undefined) return c;
  // keep the spaces around a JSX fragment ("block " + n)
  const lead = s.match(/^\s*/)![0];
  const trail = s.match(/\s*$/)![0];
  const core = s.trim();
  let out = s;
  const v = lookup(core) ?? (core.includes("\n") ? core.split("\n").map((l) => lookup(l.trim()) ?? l).join("\n") : null);
  if (v !== null) out = lead + v + trail;
  if (cache.size > 4000) cache.clear();
  cache.set(s, out);
  return out;
}

/** translates a key with explicit values: t("{0} min", 15) */
export function t(key: string, ...args: (string | number)[]): string {
  if (lang === "en") return args.length ? key.replace(/\{(\d)\}/g, (_, n) => String(args[Number(n)] ?? "")) : key;
  const d = DICTS[lang as Exclude<UiLang, "en">];
  const to = d?.[key] ?? key;
  return args.length ? fill(to, undefined, args) : tr(to);
}

function mapChildren(c: React.ReactNode): React.ReactNode {
  if (typeof c === "string") return tr(c);
  if (Array.isArray(c)) return c.map((x) => (typeof x === "string" ? tr(x) : x));
  return c;
}

/** Text that shows the UI in the chosen language */
export const Text = React.forwardRef<RNText, TextProps>(function Text(props, ref) {
  useLang();
  return <RNText ref={ref} {...props}>{mapChildren(props.children)}</RNText>;
});

/** Text that is shown exactly as it is (document content, names, answers) */
export const RawText = RNText;

// Alerts in the chosen language, wherever they are raised
const origAlert = Alert.alert.bind(Alert);
(Alert as any).alert = (title: string, message?: string, buttons?: any[], options?: any) =>
  origAlert(
    typeof title === "string" ? tr(title) : title,
    typeof message === "string" ? tr(message) : message,
    Array.isArray(buttons) ? buttons.map((b) => (b && typeof b.text === "string" ? { ...b, text: tr(b.text) } : b)) : buttons,
    options
  );
