import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  Alert,
  Pressable,
  FlatList,
  Modal,
  ActivityIndicator,
  StatusBar,
  ScrollView,
  useColorScheme,
  NativeModules,
  AppState,
  StyleProp,
  ViewStyle,
  TextStyle,
} from "react-native";

import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";

import { pick, keepLocalCopy, types } from "@react-native-documents/picker";
import RNFS from "react-native-fs";
import Tts from "react-native-tts";
import JSZip from "jszip";
import { WebView } from "react-native-webview";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Slider from "@react-native-community/slider";

type Picked = { name: string; uri: string; type?: string | null };
type Chapter = { title: string; startIndex: number; endIndex: number };
type ThemeName = "dark" | "light" | "sepia";
type Voice = { id: string; name?: string; language?: string; quality?: number; latency?: number; networkConnectionRequired?: boolean; notInstalled?: boolean };

const SETTINGS_RATE_KEY = "settings:ttsRate";
const SETTINGS_THEME_KEY = "settings:theme";
const SETTINGS_FONT_KEY = "settings:fontIndex";
const SETTINGS_VOICE_KEY = "settings:ttsVoice";

const FONT_SIZES = [15, 17, 19, 21, 24, 27, 31];
const SPEED_PRESETS = [0.75, 1.0, 1.25, 1.5, 1.75, 2.0];

// ---- the comic palette (shared with Pay & Plan) ---------------------------
const INK = "#17161A";
const CREAM = "#FFF6E5";
const PAPER = "#FFFDF7";
const YELLOW = "#FFD93D";
const CORAL = "#FF6B6B";
const MINT = "#6BCB77";
const SKY = "#4D96FF";
const GRAPE = "#B983FF";
const TANGERINE = "#FF9F45";
const AQUA = "#4ECDC4";
const BUBBLEGUM = "#FF9CEE";

// Font files live in android/app/src/main/assets/fonts; on Android the family
// name is the file name without extension.
const FONT_POSTER = "LuckiestGuy-Regular";
const FONT_BODY = "ComicNeue-Regular";
const FONT_BOLD = "ComicNeue-Bold";

type Palette = {
  bg: string;
  surface: string;
  surface2: string;
  text: string;
  dim: string;
  ink: string; // outline colour
  shadow: string; // hard offset shadow colour
  hlBg: string;
  hlText: string;
  statusBar: "light-content" | "dark-content";
};

const THEMES: Record<ThemeName, Palette> = {
  light: {
    bg: CREAM,
    surface: PAPER,
    surface2: "#FFEFCB",
    text: INK,
    dim: "#6F6862",
    ink: INK,
    shadow: INK,
    hlBg: YELLOW,
    hlText: INK,
    statusBar: "dark-content",
  },
  sepia: {
    bg: "#F1E2C4",
    surface: "#FBF2DE",
    surface2: "#EBD9B3",
    text: "#2B2216",
    dim: "#7D6B4C",
    ink: "#2B2216",
    shadow: "#2B2216",
    hlBg: "#FFD06B",
    hlText: "#2B2216",
    statusBar: "dark-content",
  },
  dark: {
    bg: "#1E1C22",
    surface: "#2C2A32",
    surface2: "#3A3741",
    text: CREAM,
    dim: "#B8B1A5",
    ink: CREAM,
    shadow: "#08070A",
    hlBg: YELLOW,
    hlText: INK,
    statusBar: "light-content",
  },
};

function extOf(name: string) {
  const m = name.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : "";
}
function isTextLikeExt(ext: string) {
  return [
    "txt","rtf","md","markdown","csv","json","log","xml","html","htm","js","ts","css","yml","yaml","ini","conf","properties",
  ].includes(ext);
}
async function copySharedUriToCache(sharedUri: string, fileName: string) {
  const safeName = (fileName || "shared").replace(/[^\w.\-() ]+/g, "_");
  const destPath = `${RNFS.CachesDirectoryPath}/${Date.now()}_${safeName}`;
  await RNFS.copyFile(sharedUri, destPath);
  return destPath;
}

function stripRtf(rtf: string) {
  return rtf
    .replace(/\\par[d]?/g, "\n")
    .replace(/\\tab/g, " ")
    .replace(/\\'[0-9a-fA-F]{2}/g, (m) => String.fromCharCode(parseInt(m.slice(2), 16)))
    .replace(/\{\\\*[^}]*\}/g, "")
    .replace(/\\[a-zA-Z]+\d* ?/g, "")
    .replace(/[{}]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeXmlEntities(s: string) {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function xmlToText(xml: string) {
  return decodeXmlEntities(
    xml
      .replace(/<w:br\/>/g, "\n")
      .replace(/<\/w:p>/g, "\n\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim()
  );
}

function postCleanExtractedText(raw: string) {
  let t = raw
    .replace(/\r/g, "")
    .replace(/\u00A0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");

  // unisci parole spezzate a fine riga (PDF/Word)
  t = t.replace(/(\p{L}{2,})-\n(\p{L}{2,})/gu, "$1$2");
  t = t.replace(/[ \t]{2,}/g, " ");

  const lines = t.split("\n").map((l) => l.trim());
  const counts = new Map<string, number>();
  for (const l of lines) {
    const key = l.toLowerCase();
    if (key.length >= 12 && key.length <= 80) counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const cleanedLines: string[] = [];
  for (const l of lines) {
    const low = l.toLowerCase();
    if (!l) { cleanedLines.push(""); continue; }
    if (/^\d{1,4}(\s*\/\s*\d{1,4})?$/.test(l)) continue; // numeri pagina
    if (/^(https?:\/\/|www\.)\S+$/i.test(l)) continue; // url isolate
    if (l.length <= 1) continue;

    const c = counts.get(low) ?? 0;
    if (c >= 3 && low.length >= 12 && low.length <= 80) continue; // header/footer ripetuti
    if (/copyright|all rights reserved|powered by/i.test(l) && c >= 2) continue;

    cleanedLines.push(l);
  }

  let out = cleanedLines.join("\n");
  out = out.replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();
  return out;
}

async function extractDocxText(localPath: string) {
  const b64 = await RNFS.readFile(localPath, "base64");
  const zip = await JSZip.loadAsync(b64, { base64: true });

  const docXmlFile = zip.file("word/document.xml");
  if (!docXmlFile) throw new Error("Invalid DOCX: word/document.xml is missing");

  const xml = await docXmlFile.async("text");
  let text = xmlToText(xml);

  const foot = zip.file("word/footnotes.xml");
  if (foot) {
    const footXml = await foot.async("text");
    const footText = xmlToText(footXml);
    if (footText && footText.length > 50) text += "\n\n" + footText;
  }

  text = postCleanExtractedText(text);
  if (!text) throw new Error("No text found in this DOCX.");
  return text;
}

function normalizeText(t: string) {
  return t.replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\u00A0/g, " ").trim();
}

function sanitizeForTts(s: string) {
  return s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ")
    .replace(/\u200B|\u200C|\u200D|\uFEFF/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
function sanitizeForTtsStrong(s: string) {
  return s
    .replace(/[\u0000-\u001F]/g, " ")
    .replace(/[•●◦▪■□◆▶►➤➔➣➢]/g, " ")
    .replace(/[^\p{L}\p{N}\p{P}\p{Zs}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Divide un paragrafo in frasi. La voce TTS suona meglio per frase
// e l'evidenziazione segue il testo molto piu' da vicino.
function splitSentences(paragraph: string): string[] {
  const parts = paragraph.split(/(?<=[.!?…])\s+(?=[«"'(\[\d\p{Lu}])/u);
  return parts.map((s) => s.trim()).filter(Boolean);
}

/**
 * Split a block into Markdown-aware chunks: every heading line and every list
 * item becomes its own chunk, consecutive plain lines stay together.
 */
function splitMdBlock(block: string): string[] {
  const lines = block.split("\n");
  const out: string[] = [];
  let acc: string[] = [];
  const flush = () => { if (acc.length) { out.push(acc.join("\n")); acc = []; } };
  for (const line of lines) {
    if (!line.trim()) { flush(); continue; }
    if (isMdHeadingLine(line) || isMdListLine(line) || /^\s*([-*_]\s*){3,}$/.test(line)) {
      flush();
      out.push(line.trim());
    } else if (/^\s*>/.test(line)) {
      // quote lines stick together
      if (acc.length && !/^\s*>/.test(acc[acc.length - 1])) flush();
      acc.push(line.trim());
    } else {
      if (acc.length && /^\s*>/.test(acc[acc.length - 1])) flush();
      acc.push(line.trim());
    }
  }
  flush();
  return out;
}

function segmentIntoSentences(raw: string, opts: { markdown?: boolean } = {}, maxChars = 280, minMerge = 45): string[] {
  const t = normalizeText(raw);
  if (!t) return [];
  const markdown = !!opts.markdown;

  let blocks = t.split(/\n\s*\n+/g).map((x) => x.trim()).filter(Boolean);
  if (blocks.length <= 1) {
    const lines = t.split("\n").map((x) => x.trim()).filter(Boolean);
    if (lines.length >= 8) blocks = lines;
  }
  blocks = blocks.flatMap(splitMdBlock);

  const out: string[] = [];
  for (const block of blocks) {
    const firstLine = block.split("\n")[0] ?? block;
    if (isMdHeadingLine(firstLine) || isMdListLine(firstLine) || /^([-*_]\s*){3,}$/.test(block)) {
      out.push(block);
      continue;
    }
    // Plain sources (PDF, DOCX, TXT): promote detected titles to Markdown headings
    // so the reader shows them as such. In Markdown files only "#" counts.
    if (!markdown && isChapterHeading(firstLine) && block.length <= 90 && !block.includes("\n")) {
      out.push(`## ${block}`);
      continue;
    }

    const sentences = splitSentences(block);
    let acc = "";
    const flush = () => { if (acc) { out.push(acc); acc = ""; } };

    for (const s of sentences) {
      if (s.length > maxChars) {
        flush();
        let rest = s;
        while (rest.length > maxChars) {
          let cut = rest.lastIndexOf(", ", maxChars);
          if (cut < maxChars * 0.5) cut = rest.lastIndexOf(" ", maxChars);
          if (cut <= 0) cut = maxChars;
          out.push(rest.slice(0, cut).trim());
          rest = rest.slice(cut).trim();
        }
        acc = rest;
        continue;
      }
      if (!acc) acc = s;
      else if (acc.length < minMerge) acc += " " + s; // unisci frasi troppo corte
      else { flush(); acc = s; }
    }
    flush();
  }
  return out.filter(Boolean);
}

function isChapterHeading(line: string) {
  const s = (line || "").trim();
  if (s.length < 3) return false;
  if (/^#{1,6}\s+/.test(s)) return true;
  if (/^(capitolo|parte|sezione|articolo|chapter|section)\s+([0-9]+|[ivxlcdm]+)/i.test(s)) return true;
  if (/^(\d+(\.\d+)*|[IVXLCDM]+)\.\s+/.test(s)) return true;

  const letters = s.replace(/[^A-Za-zÀ-ÿ]/g, "");
  const upper = letters.replace(/[^A-ZÀ-Ý]/g, "");
  if (letters.length >= 6 && upper.length / letters.length > 0.85 && s.length <= 70) return true;
  return false;
}
function cleanHeadingTitle(s: string) {
  return mdToPlain(s.replace(/^#{1,6}\s+/, "")).trim();
}
function buildChapters(segs: string[], groupSize = 40): Chapter[] {
  const heads: { idx: number; title: string }[] = [];
  segs.forEach((seg, i) => {
    const firstLine = seg.split("\n")[0] ?? seg;
    // only real headings (#, ##, ###) open a chapter; deeper levels stay inline
    const m = firstLine.match(/^(#{1,6})\s+/);
    if (m && m[1].length <= 3) heads.push({ idx: i, title: cleanHeadingTitle(firstLine) });
  });

  if (heads.length >= 2) {
    const chapters: Chapter[] = [];
    for (let i = 0; i < heads.length; i++) {
      const start = heads[i].idx;
      const end = i < heads.length - 1 ? heads[i + 1].idx - 1 : segs.length - 1;
      chapters.push({ title: heads[i].title || `Chapter ${i + 1}`, startIndex: start, endIndex: Math.max(start, end) });
    }
    return chapters;
  }

  if (segs.length <= groupSize) {
    return [{ title: "Document", startIndex: 0, endIndex: Math.max(0, segs.length - 1) }];
  }

  const chapters: Chapter[] = [];
  for (let i = 0, part = 1; i < segs.length; i += groupSize, part++) {
    chapters.push({ title: `Part ${part}`, startIndex: i, endIndex: Math.min(segs.length - 1, i + groupSize - 1) });
  }
  return chapters;
}

function makeFileId(name: string, type?: string | null) {
  return `${name}::${type ?? ""}`.toLowerCase();
}
async function loadProgress(fid: string) {
  const saved = await AsyncStorage.getItem(`progress:${fid}`);
  const n = Number(saved);
  return Number.isFinite(n) ? n : 0;
}
async function saveProgress(fid: string, idx: number) {
  await AsyncStorage.setItem(`progress:${fid}`, String(idx));
}

/**
 * PDF extraction offline: pdf.js letto da assets (android/app/src/main/assets/pdfjs/pdf.min.mjs)
 */
const pdfJsHtmlOffline = (pdfBase64: string) => {
  const safeB64 = JSON.stringify(pdfBase64);
  return `
<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
</head>
<body style="margin:0;background:#000;">
<script type="module">
  try {
    const pdfjsLib = await import("file:///android_asset/pdfjs/pdf.min.mjs");
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      "file:///android_asset/pdfjs/pdf.worker.min.mjs";

    const BASE64 = ${safeB64};
    const bin = atob(BASE64);
    const uint8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      uint8[i] = bin.charCodeAt(i);
    }

    const pdf = await pdfjsLib.getDocument({
      data: uint8,
      disableWorker: true,
    }).promise;

    let full = "";
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      const strings = content.items.map(it => it.str || "").filter(Boolean);
      full += strings.join(" ") + "\\n\\n";
    }

    window.ReactNativeWebView.postMessage(
      JSON.stringify({ ok: true, text: full.trim() })
    );
  } catch (e) {
    window.ReactNativeWebView.postMessage(
      JSON.stringify({ ok: false, error: String(e) })
    );
  }
</script>
</body>
</html>
`;
};

// Device locale, e.g. "it-IT": the default language of the speech engine.
const DEVICE_LANG: string = (() => {
  try {
    const raw = String(NativeModules?.I18nManager?.localeIdentifier || "");
    return raw ? raw.replace("_", "-") : "it-IT";
  } catch { return "it-IT"; }
})();

const LANG_NAMES: Record<string, string> = {
  it: "Italian", en: "English", fr: "French", de: "German", es: "Spanish", pt: "Portuguese",
  nl: "Dutch", ru: "Russian", pl: "Polish", tr: "Turkish", ja: "Japanese", zh: "Chinese",
  ko: "Korean", ar: "Arabic", hi: "Hindi", sv: "Swedish", da: "Danish", nb: "Norwegian",
  fi: "Finnish", el: "Greek", cs: "Czech", hu: "Hungarian", ro: "Romanian", uk: "Ukrainian",
};
function langName(code?: string) {
  const c = String(code || "").toLowerCase();
  const base = c.split(/[-_]/)[0];
  const region = c.split(/[-_]/)[1];
  const name = LANG_NAMES[base] || (base ? base.toUpperCase() : "Unknown");
  return region && base === "en" ? `${name} (${region.toUpperCase()})` : name;
}

// Engine voice ids are cryptic (e.g. "it-it-x-kda-local"): derive a readable,
// stable label such as "Italian · KDA".
function voiceLabel(v: Voice, index: number) {
  const raw = String(v.name || v.id || "");
  const m = raw.match(/x-([a-z0-9]+)/i);
  const code = m ? m[1].toUpperCase() : raw.replace(/^[a-z]{2,3}[-_][a-z]{2,3}[-_]?/i, "").replace(/-(local|network)$/i, "").toUpperCase();
  const tag = code && code.length >= 2 && code.length <= 12 ? code : `Voice ${index + 1}`;
  return `${langName(v.language)} · ${tag}`;
}

// ---- Markdown helpers -------------------------------------------------------
// Blocks are kept as (light) Markdown so the reader can render headings,
// lists and emphasis; the voice gets the plain text.

const MD_INLINE_RE = /(\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`|~~[^~\n]+~~|!\[[^\]]*\]\([^)]*\)|\[[^\]\n]+\]\([^)\n]*\)|\*[^*\n]+\*|_[^_\n]+_)/g;

type MdLine =
  | { kind: "heading"; level: number; text: string }
  | { kind: "bullet"; text: string }
  | { kind: "number"; marker: string; text: string }
  | { kind: "quote"; text: string }
  | { kind: "rule" }
  | { kind: "text"; text: string };

function parseMdLine(line: string): MdLine {
  const l = line.trim();
  let m: RegExpMatchArray | null;
  if ((m = l.match(/^(#{1,6})\s+(.*)$/))) return { kind: "heading", level: m[1].length, text: m[2].replace(/\s#+$/, "") };
  if (/^([-*_]\s*){3,}$/.test(l)) return { kind: "rule" };
  if ((m = l.match(/^[-*+•]\s+(.*)$/))) return { kind: "bullet", text: m[1] };
  if ((m = l.match(/^(\d{1,3}[.)])\s+(.*)$/))) return { kind: "number", marker: m[1], text: m[2] };
  if ((m = l.match(/^>\s?(.*)$/))) return { kind: "quote", text: m[1] };
  return { kind: "text", text: l };
}

function isMdListLine(line: string) {
  return /^\s*([-*+•]|\d{1,3}[.)])\s+\S/.test(line);
}
function isMdHeadingLine(line: string) {
  return /^\s*#{1,6}\s+\S/.test(line);
}

/** Strip Markdown syntax: what the voice should actually say. */
function mdToPlain(s: string) {
  return s
    .split("\n")
    .map((line) => {
      const p = parseMdLine(line);
      if (p.kind === "rule") return "";
      if (p.kind === "number") return `${p.marker} ${p.text}`;
      return p.text;
    })
    .join("\n")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)([^*_]+)\1/g, "$2")
    .replace(/(^|[^\w*])\*([^*\n]+)\*(?!\w)/g, "$1$2")
    .replace(/(^|[^\w_])_([^_\n]+)_(?!\w)/g, "$1$2")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/<[^>\n]{1,40}>/g, " ")
    .replace(/\|/g, " · ")
    .trim();
}

// =====================================================================
// COMIC UI: flat fill + fat ink outline + hard offset shadow.
// Same recipe as Pay & Plan's ComicUi.kt, rebuilt with React Native views.
// =====================================================================

type ComicBoxProps = {
  children?: React.ReactNode;
  palette: Palette;
  color?: string;
  radius?: number;
  stroke?: number;
  shadow?: number;
  style?: StyleProp<ViewStyle>;
  contentStyle?: StyleProp<ViewStyle>;
  onPress?: () => void;
  disabled?: boolean;
  hitSlop?: number;
};

function ComicBox({
  children, palette, color, radius = 20, stroke = 3, shadow = 5, style, contentStyle, onPress, disabled, hitSlop,
}: ComicBoxProps) {
  const bg = color ?? palette.surface;
  const render = (pressed: boolean) => {
    const drop = pressed && onPress && !disabled ? 1 : shadow;
    return (
      <>
        {shadow > 0 && (
          <View
            pointerEvents="none"
            style={{
              position: "absolute",
              top: drop,
              left: drop,
              right: -drop,
              bottom: -drop,
              backgroundColor: palette.shadow,
              borderRadius: radius,
            }}
          />
        )}
        <View
          style={[
            { backgroundColor: bg, borderWidth: stroke, borderColor: palette.ink, borderRadius: radius, overflow: "hidden" },
            contentStyle,
          ]}
        >
          {children}
        </View>
      </>
    );
  };

  if (!onPress) {
    return <View style={[style, disabled && { opacity: 0.45 }]}>{render(false)}</View>;
  }
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={hitSlop}
      style={({ pressed }) => [
        style,
        disabled && { opacity: 0.45 },
        pressed && !disabled ? { transform: [{ translateX: shadow - 1 }, { translateY: shadow - 1 }] } : null,
      ]}
    >
      {({ pressed }) => render(pressed)}
    </Pressable>
  );
}

type ComicButtonProps = {
  text: string;
  onPress: () => void;
  palette: Palette;
  color?: string;
  icon?: string;
  disabled?: boolean;
  compact?: boolean;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
};

function ComicButton({ text, onPress, palette, color = CORAL, icon, disabled, compact, style, textStyle }: ComicButtonProps) {
  return (
    <ComicBox
      palette={palette}
      color={color}
      radius={compact ? 14 : 18}
      shadow={compact ? 4 : 5}
      onPress={onPress}
      disabled={disabled}
      style={style}
      contentStyle={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        paddingHorizontal: compact ? 12 : 18,
        paddingVertical: compact ? 8 : 12,
      }}
    >
      {icon ? <Text style={{ fontSize: compact ? 15 : 18, marginRight: 6 }}>{icon}</Text> : null}
      <Text
        numberOfLines={1}
        style={[
          { fontFamily: FONT_BOLD, fontSize: compact ? 13 : 16, color: INK, letterSpacing: 0.5 },
          textStyle,
        ]}
      >
        {text}
      </Text>
    </ComicBox>
  );
}

type ComicIconButtonProps = {
  icon: string;
  onPress: () => void;
  palette: Palette;
  color?: string;
  size?: number;
  disabled?: boolean;
  fontSize?: number;
  iconColor?: string;
  style?: StyleProp<ViewStyle>;
};

function ComicIconButton({ icon, onPress, palette, color, size = 46, disabled, fontSize, iconColor, style }: ComicIconButtonProps) {
  return (
    <ComicBox
      palette={palette}
      color={color ?? palette.surface}
      radius={size / 2}
      shadow={4}
      onPress={onPress}
      disabled={disabled}
      style={style}
      contentStyle={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}
    >
      <Text style={{ fontSize: fontSize ?? size * 0.44, color: iconColor ?? (color ? INK : palette.text), fontFamily: FONT_BOLD, includeFontPadding: false }}>
        {icon}
      </Text>
    </ComicBox>
  );
}

type ComicChipProps = { text: string; selected: boolean; onPress: () => void; palette: Palette; color?: string; style?: StyleProp<ViewStyle> };

function ComicChip({ text, selected, onPress, palette, color = SKY, style }: ComicChipProps) {
  return (
    <ComicBox
      palette={palette}
      color={selected ? color : palette.surface}
      radius={14}
      stroke={selected ? 3 : 2}
      shadow={selected ? 4 : 2}
      onPress={onPress}
      style={style}
      contentStyle={{ paddingHorizontal: 14, paddingVertical: 8 }}
    >
      <Text numberOfLines={1} style={{ fontFamily: FONT_BOLD, fontSize: 14, color: selected ? INK : palette.text, letterSpacing: 0.3 }}>
        {text}
      </Text>
    </ComicBox>
  );
}

function PosterTitle({ text, palette, size = 28, color, style }: { text: string; palette: Palette; size?: number; color?: string; style?: StyleProp<TextStyle> }) {
  return (
    <Text
      numberOfLines={1}
      style={[
        { fontFamily: FONT_POSTER, fontSize: size, lineHeight: Math.round(size * 1.15), color: color ?? palette.text, letterSpacing: 1, includeFontPadding: false },
        style,
      ]}
    >
      {text}
    </Text>
  );
}

// =====================================================================

type RowProps = {
  text: string;
  index: number;
  active: boolean;
  fontSize: number;
  palette: Palette;
  onPress: (i: number) => void;
};
/** Inline Markdown (bold, italic, code, strike, links) as nested Text spans. */
function renderInline(text: string, base: TextStyle, palette: Palette, strong: boolean): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let last = 0;
  let k = 0;
  const re = new RegExp(MD_INLINE_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const tok = m[0];
    let inner = tok;
    let style: TextStyle = {};
    if (tok.startsWith("**") || tok.startsWith("__")) {
      inner = tok.slice(2, -2);
      style = { fontFamily: FONT_BOLD };
    } else if (tok.startsWith("`")) {
      inner = tok.slice(1, -1);
      style = { fontFamily: "monospace", fontSize: (base.fontSize ?? 17) * 0.9, backgroundColor: palette.surface2, color: palette.text };
    } else if (tok.startsWith("~~")) {
      inner = tok.slice(2, -2);
      style = { textDecorationLine: "line-through" };
    } else if (tok.startsWith("![")) {
      const mm = tok.match(/^!\[([^\]]*)\]/);
      inner = mm && mm[1] ? `🖼 ${mm[1]}` : "🖼";
      style = { color: palette.dim, fontStyle: "italic" };
    } else if (tok.startsWith("[")) {
      const mm = tok.match(/^\[([^\]]+)\]/);
      inner = mm ? mm[1] : tok;
      style = { textDecorationLine: "underline", color: strong ? INK : SKY, fontFamily: FONT_BOLD };
    } else {
      inner = tok.slice(1, -1);
      style = { fontStyle: "italic" };
    }
    nodes.push(<Text key={k++} style={style}>{inner}</Text>);
    last = m.index + tok.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

type MdBlockProps = { text: string; fontSize: number; color: string; palette: Palette; strong: boolean };

/** One reading block rendered as light Markdown. */
function MdBlock({ text, fontSize, color, palette, strong }: MdBlockProps) {
  const lineHeight = Math.round(fontSize * 1.5);
  const body: TextStyle = { color, fontSize, lineHeight, fontFamily: strong ? FONT_BOLD : FONT_BODY };
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  return (
    <View>
      {lines.map((line, i) => {
        const p = parseMdLine(line);
        if (p.kind === "heading") {
          const scale = p.level === 1 ? 1.55 : p.level === 2 ? 1.35 : p.level === 3 ? 1.18 : 1.05;
          const size = Math.round(fontSize * scale);
          const poster = p.level <= 2;
          return (
            <Text
              key={i}
              style={{
                color,
                fontSize: size,
                lineHeight: Math.round(size * 1.25),
                fontFamily: poster ? FONT_POSTER : FONT_BOLD,
                letterSpacing: poster ? 0.8 : 0,
                marginTop: i === 0 ? 6 : 10,
                marginBottom: 2,
                includeFontPadding: false,
              }}
            >
              {renderInline(poster ? p.text.toUpperCase() : p.text, body, palette, strong)}
            </Text>
          );
        }
        if (p.kind === "rule") {
          return <View key={i} style={{ height: 3, backgroundColor: palette.ink, borderRadius: 2, marginVertical: 10, opacity: 0.5 }} />;
        }
        if (p.kind === "bullet" || p.kind === "number") {
          return (
            <View key={i} style={{ flexDirection: "row", alignItems: "flex-start", paddingLeft: 6 }}>
              <Text style={[body, { fontFamily: FONT_BOLD, width: p.kind === "bullet" ? 20 : 30 }]}>
                {p.kind === "bullet" ? "•" : p.marker}
              </Text>
              <Text style={[body, { flex: 1 }]}>{renderInline(p.text, body, palette, strong)}</Text>
            </View>
          );
        }
        if (p.kind === "quote") {
          return (
            <View key={i} style={{ flexDirection: "row", alignItems: "stretch" }}>
              <View style={{ width: 4, borderRadius: 2, backgroundColor: strong ? INK : palette.ink, marginRight: 10, opacity: 0.7 }} />
              <Text style={[body, { flex: 1, fontStyle: "italic" }]}>{renderInline(p.text, body, palette, strong)}</Text>
            </View>
          );
        }
        return (
          <Text key={i} style={body}>{renderInline(p.text, body, palette, strong)}</Text>
        );
      })}
    </View>
  );
}

const SegmentRow = React.memo(function SegmentRow({
  text, index, active, fontSize, palette, onPress,
}: RowProps) {
  if (active) {
    // the block being read becomes a yellow sticker
    return (
      <Pressable onPress={() => onPress(index)} style={rowStyles.activeWrap}>
        <View pointerEvents="none" style={[rowStyles.activeShadow, { backgroundColor: palette.shadow }]} />
        <View style={[rowStyles.activeCard, { backgroundColor: palette.hlBg, borderColor: palette.ink }]}>
          <MdBlock text={text} fontSize={fontSize} color={palette.hlText} palette={palette} strong />
        </View>
      </Pressable>
    );
  }
  return (
    <Pressable onPress={() => onPress(index)} style={rowStyles.row}>
      <MdBlock text={text} fontSize={fontSize} color={palette.text} palette={palette} strong={false} />
    </Pressable>
  );
});

const rowStyles = StyleSheet.create({
  row: {
    paddingVertical: 6,
    paddingHorizontal: 16,
    marginVertical: 1,
  },
  activeWrap: { marginHorizontal: 10, marginVertical: 6 },
  activeShadow: { position: "absolute", top: 4, left: 4, right: -4, bottom: -4, borderRadius: 16 },
  activeCard: { borderWidth: 3, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 8 },
});

function AppInner() {
  const insets = useSafeAreaInsets();
  const systemScheme = useColorScheme();

  const [picked, setPicked] = useState<Picked | null>(null);

  const [rawText, setRawText] = useState("");
  const [segments, setSegments] = useState<string[]>([]);
  const segmentsRef = useRef<string[]>([]);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [currentIdx, setCurrentIdx] = useState(0);

  const [isExtracting, setIsExtracting] = useState(false);
  const [isReading, setIsReading] = useState(false);
  const [isPaused, setIsPaused] = useState(false);

  const [rate, setRate] = useState(1.0);
  const [fileId, setFileId] = useState<string | null>(null);

  const [pdfBase64, setPdfBase64] = useState<string | null>(null);
  const pendingAutoStartRef = useRef(false);

  const [themeName, setThemeName] = useState<ThemeName>("light");
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [fontIndex, setFontIndex] = useState(2);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [chaptersOpen, setChaptersOpen] = useState(false);
  const [voicesOpen, setVoicesOpen] = useState(false);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [voiceId, setVoiceId] = useState<string | null>(null);

  const stopRef = useRef(false);
  const [ttsReady, setTtsReady] = useState(false);
  const ttsErrorShownRef = useRef(false);
  const sessionRef = useRef(0);

  const isReadingRef = useRef(false);
  useEffect(() => { isReadingRef.current = isReading; }, [isReading]);
  const isPausedRef = useRef(false);
  useEffect(() => { isPausedRef.current = isPaused; }, [isPaused]);
  const fileIdRef = useRef<string | null>(null);
  useEffect(() => { fileIdRef.current = fileId; }, [fileId]);
  const rateRef = useRef(rate);
  useEffect(() => { rateRef.current = rate; }, [rate]);
  const voiceIdRef = useRef<string | null>(null);
  useEffect(() => { voiceIdRef.current = voiceId; }, [voiceId]);

  const listRef = useRef<FlatList<string> | null>(null);
  const processingShareRef = useRef(false);

  const palette = THEMES[themeName];
  const fontSize = FONT_SIZES[fontIndex] ?? 19;
  const s = useMemo(() => makeStyles(palette), [palette]);

  const pct = segments.length ? Math.round(((currentIdx + 1) / segments.length) * 100) : 0;
  const canRead = useMemo(
    () => segments.length > 0 && (segments[currentIdx]?.trim().length ?? 0) > 0,
    [segments, currentIdx]
  );

  const currentChapterIdx = useMemo(() => {
    if (!chapters.length) return -1;
    for (let i = 0; i < chapters.length; i++) {
      if (currentIdx >= chapters[i].startIndex && currentIdx <= chapters[i].endIndex) return i;
    }
    return -1;
  }, [chapters, currentIdx]);

  const currentVoiceLabel = useMemo(() => {
    if (!voiceId) return "System default";
    const i = voices.findIndex((v) => v.id === voiceId);
    return i >= 0 ? voiceLabel(voices[i], i) : "Selected voice";
  }, [voiceId, voices]);

  // ====== AUTOSCROLL: tieni la frase in lettura in vista ======
  const scrollToIndexSafe = useCallback((index: number, viewPosition = 0.32) => {
    const list = listRef.current;
    if (!list || index < 0 || index >= segmentsRef.current.length) return;
    try {
      list.scrollToIndex({ index, viewPosition, animated: true });
    } catch {}
  }, []);

  useEffect(() => {
    if (!segments.length) return;
    scrollToIndexSafe(currentIdx);
  }, [currentIdx, segments.length, scrollToIndexSafe]);

  // ====== SETTINGS ======
  useEffect(() => {
    (async () => {
      try {
        const [savedRate, savedTheme, savedFont, savedVoice] = await Promise.all([
          AsyncStorage.getItem(SETTINGS_RATE_KEY),
          AsyncStorage.getItem(SETTINGS_THEME_KEY),
          AsyncStorage.getItem(SETTINGS_FONT_KEY),
          AsyncStorage.getItem(SETTINGS_VOICE_KEY),
        ]);
        if (savedVoice) setVoiceId(savedVoice);
        if (savedRate) { const v = Number(savedRate); if (!Number.isNaN(v)) setRate(v); }
        if (savedTheme === "dark" || savedTheme === "light" || savedTheme === "sepia") {
          setThemeName(savedTheme);
        } else {
          // the comic look is bright by default; dark only when the system asks for it
          setThemeName(systemScheme === "dark" ? "dark" : "light");
        }
        if (savedFont != null) {
          const fi = Number(savedFont);
          if (Number.isInteger(fi) && fi >= 0 && fi < FONT_SIZES.length) setFontIndex(fi);
        }
      } catch {}
      setSettingsLoaded(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!settingsLoaded) return;
    AsyncStorage.setItem(SETTINGS_THEME_KEY, themeName).catch(() => {});
  }, [themeName, settingsLoaded]);
  useEffect(() => {
    if (!settingsLoaded) return;
    AsyncStorage.setItem(SETTINGS_FONT_KEY, String(fontIndex)).catch(() => {});
  }, [fontIndex, settingsLoaded]);

  // ====== TTS INIT ======
  useEffect(() => {
    let subErr: any = null;
    (async () => {
      try {
        await Tts.getInitStatus();
        try { await Tts.setDefaultLanguage(DEVICE_LANG); } catch {}
        try { await Tts.setDefaultPitch(1.0); } catch {}
        try { await Tts.setDefaultRate(rate, true); } catch {}
        setTtsReady(true);
      } catch {
        setTtsReady(false);
      }
    })();

    subErr = Tts.addEventListener("tts-error", () => {
      if (!ttsErrorShownRef.current) {
        ttsErrorShownRef.current = true;
        Alert.alert("Text to speech", "Some text contains characters the voice cannot handle. If it happens often, try a lower speed.");
      }
    });

    return () => {
      try { subErr?.remove?.(); } catch {}
      try { Tts.stop(); } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!settingsLoaded) return;
    AsyncStorage.setItem(SETTINGS_RATE_KEY, String(rate)).catch(() => {});
    if (!ttsReady) return;
    Tts.setDefaultRate(rate, true).catch(() => {});
  }, [rate, ttsReady, settingsLoaded]);

  // load the installed voices once the engine is ready
  useEffect(() => {
    if (!ttsReady) return;
    (async () => {
      try {
        const all: Voice[] = await Tts.voices();
        const dev = DEVICE_LANG.toLowerCase().split("-")[0];
        const list = (all || []).filter((v) => v && !v.notInstalled && typeof v.language === "string");
        // device language first, then offline voices, then by language and name
        list.sort(
          (a, b) =>
            (String(a.language).toLowerCase().startsWith(dev) ? 0 : 1) - (String(b.language).toLowerCase().startsWith(dev) ? 0 : 1) ||
            langName(a.language).localeCompare(langName(b.language)) ||
            (a.networkConnectionRequired ? 1 : 0) - (b.networkConnectionRequired ? 1 : 0) ||
            String(a.name || a.id).localeCompare(String(b.name || b.id))
        );
        setVoices(list);
      } catch {}
    })();
  }, [ttsReady]);

  // applica la voce scelta e salvala
  useEffect(() => {
    if (ttsReady && voiceId) Tts.setDefaultVoice(voiceId).catch(() => {});
  }, [ttsReady, voiceId]);
  useEffect(() => {
    if (!settingsLoaded) return;
    if (voiceId) AsyncStorage.setItem(SETTINGS_VOICE_KEY, voiceId).catch(() => {});
    else AsyncStorage.removeItem(SETTINGS_VOICE_KEY).catch(() => {});
  }, [voiceId, settingsLoaded]);

  // ====== CONTROLLI TTS ======
  const safeStop = async () => { try { await Tts.stop(); } catch {} };

  // getInitStatus() si risolve quando il motore e' pronto. All'avvio "a freddo"
  // (tipico dell'apertura via Condividi) puo' non esserlo ancora: attendiamo.
  const ensureTtsReady = async (timeoutMs = 10000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try { await Tts.getInitStatus(); return true; }
      catch { await new Promise((r) => setTimeout(r, 300)); }
    }
    return false;
  };

  const hardStop = async () => {
    stopRef.current = true;
    sessionRef.current += 1;
    setIsPaused(false);
    await safeStop();
    setIsReading(false);
  };

  const pause = async () => {
    if (!isReading) return;
    stopRef.current = true;
    sessionRef.current += 1;
    await safeStop();
    setIsReading(false);
    setIsPaused(true);
  };

  const speakOne = async (text: string) => {
    const plain = mdToPlain(text);
    const a = sanitizeForTts(plain);
    if (!a) return true;
    try {
      await Tts.speak(a);
      return true;
    } catch {
      const b = sanitizeForTtsStrong(plain);
      if (!b) return true;
      try { await Tts.speak(b); return true; } catch { return false; }
    }
  };

  const waitTtsDone = async (sessionToken: number, timeoutMs = 60000) => {
    return await new Promise<void>((resolve) => {
      let done = false;
      let subFinish: any = null;
      let subCancel: any = null;
      let subError: any = null;

      const cleanupAndResolve = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearInterval(interval);
        try { subFinish?.remove?.(); } catch {}
        try { subCancel?.remove?.(); } catch {}
        try { subError?.remove?.(); } catch {}
        resolve();
      };

      const timer = setTimeout(() => cleanupAndResolve(), timeoutMs);
      const interval = setInterval(() => {
        if (sessionRef.current !== sessionToken) cleanupAndResolve();
      }, 150);

      subFinish = Tts.addEventListener("tts-finish", cleanupAndResolve);
      subCancel = Tts.addEventListener("tts-cancel", cleanupAndResolve);
      subError = Tts.addEventListener("tts-error", cleanupAndResolve);
    });
  };

  const speakFrom = async (startIndex: number) => {
    const segs = segmentsRef.current;
    if (!segs.length) return;

    stopRef.current = false;
    ttsErrorShownRef.current = false;
    const sessionToken = (sessionRef.current += 1);

    const ready = await ensureTtsReady();
    if (sessionRef.current !== sessionToken) return;
    if (!ready) {
      if (!ttsErrorShownRef.current) {
        ttsErrorShownRef.current = true;
        Alert.alert(
          "Text to speech",
          "The phone's speech engine is not ready yet. Wait a few seconds and try again; if it persists, open Android Settings › Language & input › Text-to-speech and check that a voice is installed."
        );
      }
      setIsReading(false);
      return;
    }
    try { await Tts.setDefaultRate(rateRef.current, true); } catch {}
    // una voce specifica porta con se' la sua lingua; impostare la lingua
    // dopo la voce la sovrascriverebbe, quindi sono alternative.
    if (voiceIdRef.current) {
      try { await Tts.setDefaultVoice(voiceIdRef.current); }
      catch { try { await Tts.setDefaultLanguage(DEVICE_LANG); } catch {} }
    } else {
      try { await Tts.setDefaultLanguage(DEVICE_LANG); } catch {}
    }
    await safeStop();

    setIsReading(true);
    setIsPaused(false);

    let i = Math.max(0, Math.min(startIndex, segs.length - 1));
    setCurrentIdx(i);
    if (fileIdRef.current) await saveProgress(fileIdRef.current, i);

    for (; i < segs.length; i++) {
      if (sessionRef.current !== sessionToken) break;
      if (stopRef.current) break;

      setCurrentIdx(i);
      if (fileIdRef.current) await saveProgress(fileIdRef.current, i);

      const ok = await speakOne(segs[i]);
      if (!ok && !ttsErrorShownRef.current) {
        ttsErrorShownRef.current = true;
        Alert.alert("Text to speech", "Some parts cannot be read by the voice. Lower the speed or pick another voice.");
      }
      await waitTtsDone(sessionToken, 60000);
    }

    if (sessionRef.current === sessionToken) {
      setIsReading(false);
      setIsPaused(false);
    }
  };

  const onPlayPress = async () => {
    if (!canRead || isExtracting) return;
    if (isReading) { await pause(); return; }
    await speakFrom(currentIdx);
  };

  const skipSegment = (delta: number) => {
    const next = Math.max(0, Math.min(currentIdx + delta, Math.max(0, segmentsRef.current.length - 1)));
    setCurrentIdx(next);
    if (fileId) saveProgress(fileId, next).catch(() => {});
    if (isReading) hardStop().then(() => speakFrom(next));
  };

  const skipToChapter = (ch: Chapter) => {
    setChaptersOpen(false);
    const next = ch.startIndex;
    setCurrentIdx(next);
    if (fileId) saveProgress(fileId, next).catch(() => {});
    if (isReading) hardStop().then(() => speakFrom(next));
    else scrollToIndexSafe(next, 0.1);
  };

  // Tap su una frase: sposta il cursore e, se sta leggendo, riparte da lì.
  const onPressSegment = useCallback((index: number) => {
    setCurrentIdx(index);
    if (fileIdRef.current) saveProgress(fileIdRef.current, index).catch(() => {});
    if (isReadingRef.current) hardStop().then(() => speakFrom(index));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cycleSpeed = () => {
    const idx = SPEED_PRESETS.findIndex((v) => Math.abs(v - rate) < 0.01);
    const next = SPEED_PRESETS[(idx + 1) % SPEED_PRESETS.length] ?? 1.0;
    setRate(next);
  };

  const goToCurrent = () => scrollToIndexSafe(currentIdx, 0.32);

  // sceglie una voce, la salva e ne riproduce un'anteprima
  const onSelectVoice = async (id: string | null) => {
    setVoiceId(id);
    voiceIdRef.current = id;
    await hardStop();
    const ready = await ensureTtsReady(4000);
    if (!ready) return;
    try { await Tts.setDefaultRate(rateRef.current, true); } catch {}
    if (id) {
      try { await Tts.setDefaultVoice(id); } catch { try { await Tts.setDefaultLanguage(DEVICE_LANG); } catch {} }
    } else {
      try { await Tts.setDefaultLanguage(DEVICE_LANG); } catch {}
    }
    const lang = (id ? voices.find((v) => v.id === id)?.language : DEVICE_LANG) || DEVICE_LANG;
    const phrase = lang.toLowerCase().startsWith("it") ? "Ciao, questa è la voce selezionata." : "Hi, this is the selected voice.";
    try { await Tts.speak(phrase); } catch {}
  };

  const openInstallVoices = async () => {
    setVoicesOpen(false);
    try { await Tts.requestInstallData(); }
    catch {
      Alert.alert(
        "Voices",
        "Open Android Settings › System › Languages & input › Text-to-speech to manage or install more voices."
      );
    }
  };

  // ====== APPLY TEXT ======
  // `extracted`: text pulled out of a PDF/DOCX (needs de-noising: page numbers,
  // repeated headers...). `markdown`: source is a .md file, honour its syntax.
  const applyTextForCurrentFile = async (
    fid: string,
    text: string,
    opts: { extracted?: boolean; markdown?: boolean } = {}
  ) => {
    const cleaned = opts.extracted ? postCleanExtractedText(text) : normalizeText(text);
    setRawText(cleaned);

    const segs = segmentIntoSentences(cleaned, { markdown: !!opts.markdown });
    segmentsRef.current = segs;
    setSegments(segs);
    setChapters(buildChapters(segs));

    const savedIdx = await loadProgress(fid);
    const clamped = Math.max(0, Math.min(savedIdx, Math.max(0, segs.length - 1)));
    setCurrentIdx(clamped);
    return clamped;
  };

  const openFileFromUri = async (
    name: string,
    uri: string,
    mime: string | null | undefined,
    autoStart: boolean,
    fromShare: boolean
  ) => {
    setIsExtracting(true);
    await hardStop();
    setSegments([]);
    segmentsRef.current = [];
    setChapters([]);
    setRawText("");

    setPicked({ name, uri, type: mime ?? "" });
    const fid = makeFileId(name, mime ?? "");
    setFileId(fid);

    let localPath = "";
    const ext = extOf(name);
    console.log("[open]", JSON.stringify({ name, uri: uri.slice(0, 120), mime, ext, fromShare, autoStart }));

    try {
      if (fromShare) {
        localPath = await copySharedUriToCache(uri, name);
        console.log("[open] copied to", localPath);
      } else {
        const copied = await keepLocalCopy({
          destination: "cachesDirectory",
          files: [{ uri, fileName: name }],
        });
        const localUri = copied[0]?.status === "success" ? copied[0].localUri : null;
        if (!localUri) throw new Error("Could not create a local copy of the file.");
        localPath = localUri.replace("file://", "");
      }

      if (isTextLikeExt(ext) || (mime ?? "").startsWith("text/")) {
        const raw = await RNFS.readFile(localPath, "utf8");
        const finalText = ext === "rtf" ? stripRtf(raw) : raw;
        const markdown = ext === "md" || ext === "markdown" || (mime ?? "").includes("markdown");
        const start = await applyTextForCurrentFile(fid, finalText, { markdown });
        setIsExtracting(false);
        if (autoStart) setTimeout(() => speakFrom(start), 200);
        return;
      }

      if (ext === "rtf" || (mime ?? "").includes("rtf")) {
        const raw = await RNFS.readFile(localPath, "utf8");
        const start = await applyTextForCurrentFile(fid, stripRtf(raw));
        setIsExtracting(false);
        if (autoStart) setTimeout(() => speakFrom(start), 200);
        return;
      }

      if (ext === "docx" || (mime ?? "").includes("wordprocessingml")) {
        const docText = await extractDocxText(localPath);
        const start = await applyTextForCurrentFile(fid, docText, { extracted: true });
        setIsExtracting(false);
        if (autoStart) setTimeout(() => speakFrom(start), 200);
        return;
      }

      if (ext === "pdf" || mime === "application/pdf") {
        const b64 = await RNFS.readFile(localPath, "base64");
        console.log("[open] pdf base64 length", b64.length);
        pendingAutoStartRef.current = autoStart;
        setPdfBase64(b64);
        return; // isExtracting resta true finché la WebView risponde
      }

      try {
        const raw = await RNFS.readFile(localPath, "utf8");
        const start = await applyTextForCurrentFile(fid, raw);
        setIsExtracting(false);
        if (autoStart) setTimeout(() => speakFrom(start), 200);
        return;
      } catch {
        setIsExtracting(false);
        Alert.alert("Unsupported format", `I can't read:\n${name}`);
      }
    } catch (err: any) {
      console.log("[open] error", String(err?.message ?? err));
      setIsExtracting(false);
      Alert.alert("Error", String(err?.message ?? err ?? "Could not open the file"));
    }
  };

  // Text that arrives without a file (share sheet "text" payload).
  const openSharedText = async (title: string, text: string, autoStart: boolean) => {
    setIsExtracting(true);
    await hardStop();
    setSegments([]);
    segmentsRef.current = [];
    setChapters([]);
    setRawText("");
    setPicked({ name: title, uri: "", type: "text/plain" });
    // stable id from the content so progress is kept if the same text comes back
    let h = 0;
    for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
    const fid = makeFileId(`shared-${(h >>> 0).toString(16)}`, "text/plain");
    setFileId(fid);
    fileIdRef.current = fid;
    try {
      const looksMd = /^\s*#{1,6}\s|\n\s*[-*+]\s|\*\*[^*]+\*\*/.test(text);
      const start = await applyTextForCurrentFile(fid, text, { markdown: looksMd });
      setIsExtracting(false);
      if (autoStart) setTimeout(() => speakFrom(start), 200);
    } catch (err: any) {
      setIsExtracting(false);
      Alert.alert("Error", String(err?.message ?? err ?? "Could not read the shared text"));
    }
  };

  const pickFile = async () => {
    try {
      const [pickedFile] = await pick({ type: [types.allFiles] });
      const name = pickedFile.name ?? "file";
      const uri = pickedFile.uri;
      const mime = pickedFile.type ?? "";
      await openFileFromUri(name, uri, mime, false, false);
    } catch (err: any) {
      setIsExtracting(false);
      const msg = String(err?.message ?? "");
      if (msg.toLowerCase().includes("cancel")) return;
      Alert.alert("Error", msg || "Could not pick the file");
    }
  };

  // ====== SHARE INTENT ======
  // Nessun clearReceivedFiles(): azzererebbe per sempre il listener della libreria
  // (singleton isClear=true). Il lato nativo annulla gia' l'intent dopo la lettura,
  // quindi i foreground successivi tornano vuoti e non riaprono il file.
  // The library asks the native side only once at mount (plus AppState
  // "active"). On a cold start JS often runs before the Activity is attached
  // (getCurrentActivity() == null) and that first call never resolves, so the
  // share is silently lost. We call the native module ourselves with retries;
  // the native side clears the intent after the first successful read, so
  // repeated calls are harmless.
  useEffect(() => {
    const native = NativeModules?.ReceiveSharingIntent;
    let cancelled = false;

    const handleFiles = async (files: any[]) => {
        console.log("[share] files", JSON.stringify(files).slice(0, 600));
        if (!files || files.length === 0) return;
        if (processingShareRef.current) return;
        processingShareRef.current = true;
        try {
          const f = files[0];
          const name = f?.fileName || f?.filePath?.split?.(/[\\/]/).pop?.() || "shared";
          const mime = f?.mimeType || "";
          const uri =
            f?.contentUri ||
            (f?.filePath ? (f.filePath.startsWith("file://") ? f.filePath : `file://${f.filePath}`) : null);
          if (!uri) {
            // Plain text shared from another app (a selection, a note, a message):
            // no file behind it, the text itself is the document.
            const sharedText = String(f?.text || "").trim();
            const link = String(f?.weblink || "").trim();
            if (sharedText) {
              const title = String(f?.subject || "").trim() || "Shared text";
              await openSharedText(title, sharedText, true);
            } else if (link) {
              Alert.alert("Sharing", "Links are not fetched yet. Share the page text or a file instead.");
            }
            return;
          }
          await openFileFromUri(name, uri, mime, true, true);
        } catch (e: any) {
          console.log("[share] error", String(e?.message ?? e));
          Alert.alert("Sharing", String(e?.message ?? e ?? "Error"));
          setIsExtracting(false);
        } finally {
          processingShareRef.current = false;
        }
    };

    const poll = (reason: string) => {
      if (cancelled) return;
      console.log("[share] poll", reason, "native=", !!native, "fn=", typeof native?.getFileNames);
      if (!native?.getFileNames) {
        console.log("[share] native module missing");
        return;
      }
      native
        .getFileNames()
        .then((obj: any) => {
          const files = obj ? Object.keys(obj).map((k) => obj[k]) : [];
          if (files.length) console.log("[share] got files on", reason);
          handleFiles(files);
        })
        .catch((e: any) => {
          // "Invalid file type." / NPE on a null intent = nothing pending (normal)
          const msg = String(e?.message ?? e ?? "");
          if (!/Invalid file type|NullPointer|null object/i.test(msg)) console.log("[share] native error:", msg);
        });
    };

    // cold start: several attempts while the Activity gets attached
    poll("mount");
    const timers = [400, 1200, 2500, 5000].map((ms) => setTimeout(() => poll(`t+${ms}`), ms));
    // warm start (app already running, brought to front by the share sheet)
    const sub = AppState.addEventListener("change", (st) => {
      if (st === "active") poll("appstate");
    });
    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
      sub.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const renderItem = useCallback(
    ({ item, index }: { item: string; index: number }) => (
      <SegmentRow
        text={item}
        index={index}
        active={index === currentIdx}
        fontSize={fontSize}
        palette={palette}
        onPress={onPressSegment}
      />
    ),
    [currentIdx, fontSize, palette, onPressSegment]
  );

  const busy = isExtracting;
  const hasDoc = segments.length > 0;

  const docKindColor = (() => {
    const ext = extOf(picked?.name ?? "");
    if (ext === "pdf") return CORAL;
    if (ext === "docx" || ext === "doc") return SKY;
    if (ext === "rtf") return GRAPE;
    if (ext === "md" || ext === "markdown") return TANGERINE;
    return MINT;
  })();

  const sheetBottom = Math.max(12, insets.bottom + 8);

  return (
    <View style={[s.container, { paddingTop: insets.top }]}>
      <StatusBar barStyle={palette.statusBar} backgroundColor={palette.bg} />

      {/* HEADER */}
      <View style={s.header}>
        <PosterTitle text="LEGGIMI" palette={palette} size={30} style={{ flex: 1 }} />
        <ComicIconButton icon="📂" onPress={pickFile} disabled={busy} palette={palette} color={YELLOW} fontSize={20} style={s.headerBtn} />
        {chapters.length > 1 && (
          <ComicIconButton icon="☰" onPress={() => setChaptersOpen(true)} palette={palette} color={SKY} fontSize={20} style={s.headerBtn} />
        )}
        <ComicIconButton icon="Aa" onPress={() => setSettingsOpen(true)} palette={palette} color={MINT} fontSize={17} style={s.headerBtn} />
      </View>

      {/* DOCUMENT STICKER + PROGRESS */}
      {(hasDoc || busy) && picked && (
        <ComicBox palette={palette} color={docKindColor} radius={18} style={s.docCard} onPress={goToCurrent} contentStyle={s.docCardInner}>
          <View style={s.docRow}>
            <View style={s.docBadge}>
              <Text style={s.docBadgeText}>{(extOf(picked.name) || (picked.type === "text/plain" ? "txt" : "doc")).toUpperCase().slice(0, 4)}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text numberOfLines={1} style={s.docTitle}>{picked.name}</Text>
              {hasDoc ? (
                <Text numberOfLines={1} style={s.docSub}>
                  {currentChapterIdx >= 0 ? `${chapters[currentChapterIdx].title} · ` : ""}block {currentIdx + 1}/{segments.length}
                </Text>
              ) : (
                <Text numberOfLines={1} style={s.docSub}>Reading the file…</Text>
              )}
            </View>
            <Text style={s.docPct}>{pct}%</Text>
          </View>
          <View style={s.progressTrack}>
            <View style={[s.progressFill, { width: `${Math.max(pct, 2)}%` }]} />
          </View>
        </ComicBox>
      )}

      {/* CONTENUTO */}
      <View style={s.readerArea}>
        {!hasDoc && !busy ? (
          <ScrollView contentContainerStyle={s.emptyScroll} showsVerticalScrollIndicator={false}>
            <ComicBox palette={palette} radius={24} shadow={6} contentStyle={s.emptyCard}>
              <Text style={s.emptyEmoji}>📖</Text>
              <PosterTitle text="LISTEN TO YOUR" palette={palette} size={26} />
              <PosterTitle text="DOCUMENTS" palette={palette} size={26} />
              <Text style={s.emptyText}>
                Open a PDF, Word, Markdown, TXT or RTF file — or share it to LeggiMi from any other app — and I will read it out loud.
              </Text>
              <View style={s.kindRow}>
                {[
                  ["PDF", CORAL],
                  ["DOCX", SKY],
                  ["TXT", MINT],
                  ["RTF", GRAPE],
                ].map(([k, c]) => (
                  <View key={k} style={[s.kindSticker, { backgroundColor: c, borderColor: palette.ink }]}>
                    <Text style={s.kindStickerText}>{k}</Text>
                  </View>
                ))}
              </View>
              <ComicButton text="OPEN A DOCUMENT" icon="📂" onPress={pickFile} palette={palette} color={YELLOW} style={{ marginTop: 18 }} />
            </ComicBox>

            <ComicBox palette={palette} color={SKY} radius={20} style={{ marginTop: 26 }} contentStyle={s.tipCard}>
              <Text style={s.tipEmoji}>💡</Text>
              <Text style={s.tipText}>
                In any app tap <Text style={{ fontFamily: FONT_BOLD }}>Share</Text> and pick LeggiMi: I start reading right away. Selected text works too.
              </Text>
            </ComicBox>
          </ScrollView>
        ) : (
          <ComicBox palette={palette} radius={22} shadow={5} style={s.readerCard} contentStyle={{ flex: 1 }}>
            <FlatList
              ref={listRef}
              data={segments}
              keyExtractor={(_, i) => String(i)}
              renderItem={renderItem}
              extraData={`${currentIdx}|${fontSize}|${themeName}`}
              initialNumToRender={20}
              maxToRenderPerBatch={20}
              windowSize={21}
              contentContainerStyle={s.listContent}
              showsVerticalScrollIndicator
              onScrollToIndexFailed={(info) => {
                listRef.current?.scrollToOffset({
                  offset: info.averageItemLength * info.index,
                  animated: false,
                });
                setTimeout(() => scrollToIndexSafe(info.index), 220);
              }}
            />
          </ComicBox>
        )}

        {busy && (
          <View style={s.loadingOverlay}>
            <ComicBox palette={palette} color={YELLOW} radius={22} shadow={6} contentStyle={s.loadingCard}>
              <ActivityIndicator size="large" color={INK} />
              <PosterTitle text="ONE MOMENT…" palette={palette} size={22} color={INK} style={{ marginTop: 12 }} />
              <Text style={s.loadingText}>Extracting the text</Text>
              {picked?.name ? <Text style={s.loadingSub} numberOfLines={1}>{picked.name}</Text> : null}
            </ComicBox>
          </View>
        )}
      </View>

      {/* TRANSPORT BAR */}
      <ComicBox palette={palette} radius={26} shadow={5} style={[s.transportWrap, { marginBottom: Math.max(12, insets.bottom) }]} contentStyle={s.transport}>
        <View style={s.tItem}>
          <ComicIconButton icon="⏮" onPress={() => skipSegment(-1)} disabled={!hasDoc} palette={palette} color={palette.surface2} size={48} fontSize={20} />
          <Text style={s.tLabel}>Prev</Text>
        </View>

        <View style={s.tItem}>
          <ComicIconButton
            icon={isReading ? "❚❚" : "▶"}
            onPress={onPlayPress}
            disabled={!canRead || busy}
            palette={palette}
            color={isReading ? CORAL : MINT}
            size={72}
            fontSize={isReading ? 24 : 30}
            iconColor={INK}
          />
          <Text style={s.tLabel}>{isReading ? "Pause" : isPaused ? "Resume" : "Play"}</Text>
        </View>

        <View style={s.tItem}>
          <ComicIconButton icon="⏭" onPress={() => skipSegment(1)} disabled={!hasDoc} palette={palette} color={palette.surface2} size={48} fontSize={20} />
          <Text style={s.tLabel}>Next</Text>
        </View>

        <View style={s.tItem}>
          <ComicBox palette={palette} color={YELLOW} radius={16} shadow={4} onPress={cycleSpeed} contentStyle={s.speedPill}>
            <Text style={s.speedText}>{rate.toFixed(2)}×</Text>
          </ComicBox>
          <Text style={s.tLabel}>Speed</Text>
        </View>
      </ComicBox>

      {/* SHEET IMPOSTAZIONI */}
      <Modal visible={settingsOpen} transparent animationType="slide" onRequestClose={() => setSettingsOpen(false)}>
        <Pressable style={s.backdrop} onPress={() => setSettingsOpen(false)} />
        <View style={[s.sheetWrap, { bottom: sheetBottom }]}>
          <ComicBox palette={palette} radius={26} shadow={6} contentStyle={s.sheet}>
            <ScrollView showsVerticalScrollIndicator={false}>
              <View style={s.sheetHead}>
                <Text style={s.sheetEmoji}>🎨</Text>
                <PosterTitle text="READING" palette={palette} size={26} />
              </View>

              <Text style={s.sheetLabel}>Theme</Text>
              <View style={s.chipRow}>
                <ComicChip text="Light" selected={themeName === "light"} onPress={() => setThemeName("light")} palette={palette} color={YELLOW} />
                <ComicChip text="Sepia" selected={themeName === "sepia"} onPress={() => setThemeName("sepia")} palette={palette} color={TANGERINE} />
                <ComicChip text="Dark" selected={themeName === "dark"} onPress={() => setThemeName("dark")} palette={palette} color={GRAPE} />
              </View>

              <Text style={s.sheetLabel}>Text size</Text>
              <View style={s.fontRow}>
                <ComicButton text="A−" onPress={() => setFontIndex((i) => Math.max(0, i - 1))} disabled={fontIndex <= 0} palette={palette} color={SKY} style={{ minWidth: 84 }} />
                <View style={s.fontPreviewWrap}>
                  <Text style={[s.fontPreview, { fontSize: Math.min(fontSize + 4, 30) }]}>Aa</Text>
                  <Text style={s.fontPreviewMeta}>{fontSize}px</Text>
                </View>
                <ComicButton text="A+" onPress={() => setFontIndex((i) => Math.min(FONT_SIZES.length - 1, i + 1))} disabled={fontIndex >= FONT_SIZES.length - 1} palette={palette} color={SKY} style={{ minWidth: 84 }} />
              </View>

              <Text style={s.sheetLabel}>Voice speed · {rate.toFixed(2)}×</Text>
              <ComicBox palette={palette} color={palette.surface2} radius={16} shadow={3} contentStyle={{ paddingHorizontal: 8, paddingVertical: 4 }}>
                <Slider
                  minimumValue={0.5}
                  maximumValue={2.0}
                  step={0.05}
                  value={rate}
                  onValueChange={setRate}
                  minimumTrackTintColor={CORAL}
                  maximumTrackTintColor={palette.ink}
                  thumbTintColor={CORAL}
                />
              </ComicBox>

              <Text style={s.sheetLabel}>Voice</Text>
              <ComicBox
                palette={palette}
                radius={16}
                shadow={4}
                onPress={() => { setSettingsOpen(false); setVoicesOpen(true); }}
                contentStyle={s.rowSelect}
              >
                <Text style={s.rowSelectEmoji}>🗣️</Text>
                <Text style={s.rowSelectText} numberOfLines={1}>{currentVoiceLabel}</Text>
                <Text style={s.rowSelectChevron}>›</Text>
              </ComicBox>

              <ComicButton text="DONE" onPress={() => setSettingsOpen(false)} palette={palette} color={MINT} style={{ marginTop: 24 }} />
            </ScrollView>
          </ComicBox>
        </View>
      </Modal>

      {/* SHEET CAPITOLI */}
      <Modal visible={chaptersOpen} transparent animationType="slide" onRequestClose={() => setChaptersOpen(false)}>
        <Pressable style={s.backdrop} onPress={() => setChaptersOpen(false)} />
        <View style={[s.sheetWrap, { bottom: sheetBottom, maxHeight: "72%" }]}>
          <ComicBox palette={palette} radius={26} shadow={6} contentStyle={s.sheet}>
            <View style={s.sheetHead}>
              <Text style={s.sheetEmoji}>📑</Text>
              <PosterTitle text="CONTENTS" palette={palette} size={26} />
            </View>
            <ScrollView style={{ marginTop: 4, flexGrow: 0 }} showsVerticalScrollIndicator={false}>
              {chapters.map((ch, idx) => {
                const active = idx === currentChapterIdx;
                return (
                  <ComicBox
                    key={idx}
                    palette={palette}
                    color={active ? YELLOW : palette.surface}
                    radius={14}
                    stroke={active ? 3 : 2}
                    shadow={active ? 4 : 2}
                    onPress={() => skipToChapter(ch)}
                    style={s.listItem}
                    contentStyle={s.chapterRow}
                  >
                    <Text style={[s.chapterText, active && { color: INK, fontFamily: FONT_BOLD }]} numberOfLines={2}>
                      {ch.title}
                    </Text>
                    <Text style={[s.chapterMeta, active && { color: INK }]}>{ch.startIndex + 1}–{ch.endIndex + 1}</Text>
                  </ComicBox>
                );
              })}
            </ScrollView>
            <ComicButton text="CLOSE" onPress={() => setChaptersOpen(false)} palette={palette} color={CORAL} style={{ marginTop: 18 }} />
          </ComicBox>
        </View>
      </Modal>

      {/* SHEET VOCE */}
      <Modal visible={voicesOpen} transparent animationType="slide" onRequestClose={() => setVoicesOpen(false)}>
        <Pressable style={s.backdrop} onPress={() => setVoicesOpen(false)} />
        <View style={[s.sheetWrap, { bottom: sheetBottom, maxHeight: "78%" }]}>
          <ComicBox palette={palette} radius={26} shadow={6} contentStyle={s.sheet}>
            <View style={s.sheetHead}>
              <Text style={s.sheetEmoji}>🗣️</Text>
              <PosterTitle text="VOICE" palette={palette} size={26} />
            </View>
            <Text style={s.voiceHint}>Tap a voice to hear a preview. Your choice is saved automatically.</Text>
            <ScrollView style={{ marginTop: 10, flexGrow: 0 }} showsVerticalScrollIndicator={false}>
              <ComicBox
                palette={palette}
                color={!voiceId ? YELLOW : palette.surface}
                radius={14}
                stroke={!voiceId ? 3 : 2}
                shadow={!voiceId ? 4 : 2}
                onPress={() => onSelectVoice(null)}
                style={s.listItem}
                contentStyle={s.chapterRow}
              >
                <Text style={[s.chapterText, !voiceId && { color: INK, fontFamily: FONT_BOLD }]}>Predefinita di sistema</Text>
                {!voiceId ? <Text style={s.voiceCheck}>✓</Text> : null}
              </ComicBox>
              {voices.map((v, idx) => {
                const active = v.id === voiceId;
                return (
                  <ComicBox
                    key={v.id}
                    palette={palette}
                    color={active ? YELLOW : palette.surface}
                    radius={14}
                    stroke={active ? 3 : 2}
                    shadow={active ? 4 : 2}
                    onPress={() => onSelectVoice(v.id)}
                    style={s.listItem}
                    contentStyle={s.chapterRow}
                  >
                    <View style={{ flex: 1, paddingRight: 10 }}>
                      <Text style={[s.chapterText, active && { color: INK, fontFamily: FONT_BOLD }]} numberOfLines={1}>
                        {voiceLabel(v, idx)}
                      </Text>
                      {v.networkConnectionRequired ? <Text style={[s.voiceMeta, active && { color: INK }]}>needs a connection</Text> : null}
                    </View>
                    {active ? <Text style={s.voiceCheck}>✓</Text> : null}
                  </ComicBox>
                );
              })}
              {voices.length === 0 ? (
                <Text style={s.voiceHint}>No voices found on this phone: install one below.</Text>
              ) : null}
              <ComicButton text="INSTALL MORE VOICES…" icon="⬇️" onPress={openInstallVoices} palette={palette} color={SKY} compact style={{ alignSelf: "flex-start", marginTop: 10, marginLeft: 2 }} />
            </ScrollView>
            <ComicButton text="CLOSE" onPress={() => setVoicesOpen(false)} palette={palette} color={CORAL} style={{ marginTop: 18 }} />
          </ComicBox>
        </View>
      </Modal>

      {/* PDF extractor offline (nascosto) */}
      {pdfBase64 && (
        <WebView
          source={{ html: pdfJsHtmlOffline(pdfBase64), baseUrl: "file:///android_asset/" }}
          javaScriptEnabled
          originWhitelist={["*"]}
          allowFileAccess
          allowFileAccessFromFileURLs
          allowUniversalAccessFromFileURLs
          mixedContentMode="always"
          onMessage={async (e) => {
            try {
              const msg = JSON.parse(e.nativeEvent.data);
              console.log("[pdf] message ok=", msg.ok, "len=", String(msg.text || "").length, msg.error || "");
              if (msg.ok) {
                const t = String(msg.text || "").trim();
                if (!t) {
                  Alert.alert("PDF", "This PDF has no text layer (scanned): it would need OCR.");
                  return;
                }
                if (!fileId) throw new Error("missing fileId");
                const start = await applyTextForCurrentFile(fileId, t, { extracted: true });
                setIsExtracting(false);
                setPdfBase64(null);
                if (pendingAutoStartRef.current) {
                  pendingAutoStartRef.current = false;
                  setTimeout(() => speakFrom(start), 250);
                }
              } else {
                Alert.alert("PDF", msg.error || "Could not extract text from the PDF");
              }
            } catch (err: any) {
              Alert.alert("PDF", String(err?.message ?? "Could not parse the PDF"));
            } finally {
              setIsExtracting(false);
              setPdfBase64(null);
              pendingAutoStartRef.current = false;
            }
          }}
          onError={(e) => {
            console.log("[pdf] webview error", JSON.stringify(e?.nativeEvent ?? {}));
            Alert.alert("PDF", "The PDF reader failed while extracting text");
            setIsExtracting(false);
            setPdfBase64(null);
            pendingAutoStartRef.current = false;
          }}
          style={{ width: 0, height: 0, opacity: 0, position: "absolute" }}
        />
      )}
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <AppInner />
    </SafeAreaProvider>
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: p.bg },

    header: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 16,
      paddingTop: 10,
      paddingBottom: 6,
      gap: 10,
    },
    headerBtn: { marginLeft: 2 },

    docCard: { marginHorizontal: 16, marginTop: 8, marginBottom: 4 },
    docCardInner: { paddingHorizontal: 12, paddingTop: 10, paddingBottom: 12 },
    docRow: { flexDirection: "row", alignItems: "center", gap: 10 },
    docBadge: {
      backgroundColor: PAPER,
      borderWidth: 3,
      borderColor: INK,
      borderRadius: 12,
      paddingHorizontal: 8,
      paddingVertical: 4,
      minWidth: 48,
      alignItems: "center",
    },
    docBadgeText: { fontFamily: FONT_POSTER, fontSize: 14, color: INK, includeFontPadding: false },
    docTitle: { fontFamily: FONT_BOLD, fontSize: 15, color: INK },
    docSub: { fontFamily: FONT_BODY, fontSize: 12.5, color: INK, opacity: 0.8, marginTop: 1 },
    docPct: { fontFamily: FONT_POSTER, fontSize: 22, color: INK, includeFontPadding: false, marginLeft: 4 },

    progressTrack: {
      marginTop: 10,
      height: 14,
      borderRadius: 8,
      backgroundColor: PAPER,
      borderWidth: 3,
      borderColor: INK,
      overflow: "hidden",
    },
    progressFill: { height: "100%", backgroundColor: YELLOW, borderRightWidth: 3, borderRightColor: INK },

    readerArea: { flex: 1 },
    readerCard: { flex: 1, marginHorizontal: 16, marginTop: 10, marginBottom: 12 },
    listContent: { paddingVertical: 12, paddingBottom: 30 },

    emptyScroll: { paddingHorizontal: 18, paddingTop: 18, paddingBottom: 30, flexGrow: 1, justifyContent: "center" },
    emptyCard: { alignItems: "center", paddingHorizontal: 20, paddingVertical: 26 },
    emptyEmoji: { fontSize: 60, marginBottom: 10 },
    emptyText: { color: p.dim, fontSize: 16, lineHeight: 23, textAlign: "center", marginTop: 12, fontFamily: FONT_BODY },
    kindRow: { flexDirection: "row", gap: 8, marginTop: 16, flexWrap: "wrap", justifyContent: "center" },
    kindSticker: { borderWidth: 3, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 4, transform: [{ rotate: "-2deg" }] },
    kindStickerText: { fontFamily: FONT_POSTER, fontSize: 14, color: INK, includeFontPadding: false },

    tipCard: { flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 12, gap: 10 },
    tipEmoji: { fontSize: 26 },
    tipText: { flex: 1, color: INK, fontSize: 14.5, lineHeight: 20, fontFamily: FONT_BODY },

    loadingOverlay: {
      ...StyleSheet.absoluteFillObject,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: p.bg + "CC",
      paddingHorizontal: 32,
    },
    loadingCard: { alignItems: "center", paddingHorizontal: 26, paddingVertical: 24, minWidth: 240 },
    loadingText: { color: INK, fontSize: 15, fontFamily: FONT_BOLD, marginTop: 4 },
    loadingSub: { color: INK, opacity: 0.75, fontSize: 12.5, marginTop: 6, maxWidth: 220, fontFamily: FONT_BODY },

    transportWrap: { marginHorizontal: 16 },
    transport: {
      flexDirection: "row",
      alignItems: "flex-end",
      justifyContent: "space-around",
      paddingHorizontal: 10,
      paddingTop: 12,
      paddingBottom: 10,
    },
    tItem: { alignItems: "center", justifyContent: "flex-end", minWidth: 60 },
    tLabel: { color: p.dim, fontSize: 11.5, marginTop: 8, fontFamily: FONT_BOLD },

    speedPill: { paddingHorizontal: 10, height: 48, minWidth: 64, alignItems: "center", justifyContent: "center" },
    speedText: { color: INK, fontSize: 15, fontFamily: FONT_POSTER, includeFontPadding: false, letterSpacing: 0.5 },

    backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: "#17161A99" },
    sheetWrap: { position: "absolute", left: 12, right: 12, maxHeight: "88%" },
    sheet: { paddingHorizontal: 18, paddingTop: 16, paddingBottom: 18 },
    sheetHead: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 6 },
    sheetEmoji: { fontSize: 26 },
    sheetLabel: { color: p.text, fontSize: 14, marginTop: 16, marginBottom: 10, fontFamily: FONT_BOLD },

    chipRow: { flexDirection: "row", gap: 10, flexWrap: "wrap" },

    fontRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
    fontPreviewWrap: { alignItems: "center", flex: 1 },
    fontPreview: { color: p.text, fontFamily: FONT_BOLD, includeFontPadding: false },
    fontPreviewMeta: { color: p.dim, fontSize: 12, fontFamily: FONT_BODY, marginTop: 2 },

    listItem: { marginBottom: 10, marginRight: 6 },
    chapterRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 12, paddingHorizontal: 14 },
    chapterText: { color: p.text, fontSize: 15, flex: 1, paddingRight: 10, fontFamily: FONT_BODY },
    chapterMeta: { color: p.dim, fontSize: 12, fontFamily: FONT_BOLD },

    rowSelect: { flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 12, gap: 10 },
    rowSelectEmoji: { fontSize: 20 },
    rowSelectText: { color: p.text, fontSize: 15, fontFamily: FONT_BOLD, flex: 1, paddingRight: 10 },
    rowSelectChevron: { color: p.text, fontSize: 24, marginTop: -2, fontFamily: FONT_BOLD },
    voiceHint: { color: p.dim, fontSize: 13, lineHeight: 18, marginTop: 4, fontFamily: FONT_BODY },
    voiceMeta: { color: p.dim, fontSize: 11.5, marginTop: 2, fontFamily: FONT_BODY },
    voiceCheck: { color: INK, fontSize: 18, fontFamily: FONT_BOLD },
  });
}
