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
} from "react-native";

import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";

import { pick, keepLocalCopy, types } from "@react-native-documents/picker";
import RNFS from "react-native-fs";
import Tts from "react-native-tts";
import JSZip from "jszip";
import { WebView } from "react-native-webview";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Slider from "@react-native-community/slider";
import ReceiveSharingIntent from "react-native-receive-sharing-intent";

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

type Palette = {
  bg: string;
  surface: string;
  surface2: string;
  text: string;
  dim: string;
  border: string;
  accent: string;
  onAccent: string;
  hlBg: string;
  hlText: string;
  hlBar: string;
  statusBar: "light-content" | "dark-content";
};

const THEMES: Record<ThemeName, Palette> = {
  dark: {
    bg: "#0B0B0C",
    surface: "#161618",
    surface2: "#212124",
    text: "#ECECEC",
    dim: "#9A9AA0",
    border: "#2A2A2E",
    accent: "#3B82F6",
    onAccent: "#FFFFFF",
    hlBg: "#16314F",
    hlText: "#FFFFFF",
    hlBar: "#3B82F6",
    statusBar: "light-content",
  },
  light: {
    bg: "#FBFBFC",
    surface: "#FFFFFF",
    surface2: "#F1F2F4",
    text: "#16181C",
    dim: "#6B7280",
    border: "#E4E4E7",
    accent: "#2563EB",
    onAccent: "#FFFFFF",
    hlBg: "#DCEAFE",
    hlText: "#0B1220",
    hlBar: "#2563EB",
    statusBar: "dark-content",
  },
  sepia: {
    bg: "#F3EAD6",
    surface: "#EEE3C9",
    surface2: "#E6DABA",
    text: "#3A2F1C",
    dim: "#8A7A55",
    border: "#DDCDA3",
    accent: "#B0712A",
    onAccent: "#FFFFFF",
    hlBg: "#E7D6A6",
    hlText: "#2A2110",
    hlBar: "#B0712A",
    statusBar: "dark-content",
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
  if (!docXmlFile) throw new Error("DOCX non valido: manca word/document.xml");

  const xml = await docXmlFile.async("text");
  let text = xmlToText(xml);

  const foot = zip.file("word/footnotes.xml");
  if (foot) {
    const footXml = await foot.async("text");
    const footText = xmlToText(footXml);
    if (footText && footText.length > 50) text += "\n\n" + footText;
  }

  text = postCleanExtractedText(text);
  if (!text) throw new Error("Non ho trovato testo nel DOCX.");
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

function segmentIntoSentences(raw: string, maxChars = 280, minMerge = 45): string[] {
  const t = normalizeText(raw);
  if (!t) return [];

  let blocks = t.split(/\n\s*\n+/g).map((x) => x.trim()).filter(Boolean);
  if (blocks.length <= 1) {
    const lines = t.split("\n").map((x) => x.trim()).filter(Boolean);
    if (lines.length >= 8) blocks = lines;
  }

  const out: string[] = [];
  for (const block of blocks) {
    const firstLine = block.split("\n")[0] ?? block;
    if (isChapterHeading(firstLine) && block.length <= 90) {
      out.push(block);
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
  return s.replace(/^#{1,6}\s+/, "").trim();
}
function buildChapters(segs: string[], groupSize = 40): Chapter[] {
  const heads: { idx: number; title: string }[] = [];
  segs.forEach((seg, i) => {
    const firstLine = seg.split("\n")[0] ?? seg;
    if (isChapterHeading(firstLine)) heads.push({ idx: i, title: cleanHeadingTitle(firstLine) });
  });

  if (heads.length >= 2) {
    const chapters: Chapter[] = [];
    for (let i = 0; i < heads.length; i++) {
      const start = heads[i].idx;
      const end = i < heads.length - 1 ? heads[i + 1].idx - 1 : segs.length - 1;
      chapters.push({ title: heads[i].title || `Capitolo ${i + 1}`, startIndex: start, endIndex: Math.max(start, end) });
    }
    return chapters;
  }

  if (segs.length <= groupSize) {
    return [{ title: "Documento", startIndex: 0, endIndex: Math.max(0, segs.length - 1) }];
  }

  const chapters: Chapter[] = [];
  for (let i = 0, part = 1; i < segs.length; i += groupSize, part++) {
    chapters.push({ title: `Parte ${part}`, startIndex: i, endIndex: Math.min(segs.length - 1, i + groupSize - 1) });
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

// Gli id voce dei motori sono criptici (es. "it-it-x-kda-local"): ne ricaviamo
// un'etichetta leggibile e stabile.
function voiceLabel(v: Voice, index: number) {
  const raw = String(v.name || v.id || "");
  const m = raw.match(/x-([a-z0-9]+)/i);
  const code = m ? m[1].toUpperCase() : raw.replace(/^it[-_]it[-_]?/i, "").replace(/-(local|network)$/i, "").toUpperCase();
  return code && code.length >= 2 ? `Voce ${code}` : `Voce ${index + 1}`;
}

type RowProps = {
  text: string;
  index: number;
  active: boolean;
  fontSize: number;
  palette: Palette;
  onPress: (i: number) => void;
};
const SegmentRow = React.memo(function SegmentRow({
  text, index, active, fontSize, palette, onPress,
}: RowProps) {
  return (
    <Pressable
      onPress={() => onPress(index)}
      android_ripple={{ color: palette.border }}
      style={[
        rowStyles.row,
        { borderLeftColor: active ? palette.hlBar : "transparent" },
        active && { backgroundColor: palette.hlBg },
      ]}
    >
      <Text
        style={{
          color: active ? palette.hlText : palette.text,
          fontSize,
          lineHeight: Math.round(fontSize * 1.55),
        }}
      >
        {text}
      </Text>
    </Pressable>
  );
});

const rowStyles = StyleSheet.create({
  row: {
    paddingVertical: 7,
    paddingHorizontal: 16,
    borderLeftWidth: 3,
    borderRadius: 6,
    marginVertical: 1,
  },
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

  const [themeName, setThemeName] = useState<ThemeName>("dark");
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
    if (!voiceId) return "Predefinita di sistema";
    const i = voices.findIndex((v) => v.id === voiceId);
    return i >= 0 ? voiceLabel(voices[i], i) : "Voce selezionata";
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
          setThemeName(systemScheme === "light" ? "light" : "dark");
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
        try { await Tts.setDefaultLanguage("it-IT"); } catch {}
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
        Alert.alert("Sintesi vocale", "Alcuni testi contengono caratteri difficili. Se succede spesso, prova a ridurre la velocità.");
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

  // carica le voci italiane installate quando il motore e' pronto
  useEffect(() => {
    if (!ttsReady) return;
    (async () => {
      try {
        const all: Voice[] = await Tts.voices();
        const it = (all || []).filter(
          (v) => v && !v.notInstalled && typeof v.language === "string" && v.language.toLowerCase().startsWith("it")
        );
        it.sort(
          (a, b) =>
            (a.networkConnectionRequired ? 1 : 0) - (b.networkConnectionRequired ? 1 : 0) ||
            String(a.name || a.id).localeCompare(String(b.name || b.id))
        );
        setVoices(it);
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
    const a = sanitizeForTts(text);
    if (!a) return true;
    try {
      await Tts.speak(a);
      return true;
    } catch {
      const b = sanitizeForTtsStrong(text);
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
          "Sintesi vocale",
          "Il motore vocale del telefono non è ancora pronto. Attendi qualche secondo e riprova; se persiste, apri Impostazioni Android › Lingua e immissione › Sintesi vocale e verifica che sia installata una voce italiana."
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
      catch { try { await Tts.setDefaultLanguage("it-IT"); } catch {} }
    } else {
      try { await Tts.setDefaultLanguage("it-IT"); } catch {}
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
        Alert.alert("Sintesi vocale", "Alcune parti non sono leggibili dal TTS. Riduci la velocità o cambia voce TTS.");
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
      try { await Tts.setDefaultVoice(id); } catch { try { await Tts.setDefaultLanguage("it-IT"); } catch {} }
    } else {
      try { await Tts.setDefaultLanguage("it-IT"); } catch {}
    }
    try { await Tts.speak("Ciao, questa è la voce selezionata."); } catch {}
  };

  const openInstallVoices = async () => {
    setVoicesOpen(false);
    try { await Tts.requestInstallData(); }
    catch {
      Alert.alert(
        "Voci",
        "Apri Impostazioni Android › Sistema › Lingue e immissione › Sintesi vocale per gestire o installare altre voci."
      );
    }
  };

  // ====== APPLY TEXT ======
  const applyTextForCurrentFile = async (fid: string, text: string) => {
    const cleaned = postCleanExtractedText(text);
    setRawText(cleaned);

    const segs = segmentIntoSentences(cleaned);
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

    try {
      if (fromShare) {
        localPath = await copySharedUriToCache(uri, name);
      } else {
        const copied = await keepLocalCopy({
          destination: "cachesDirectory",
          files: [{ uri, fileName: name }],
        });
        const localUri = copied[0]?.status === "success" ? copied[0].localUri : null;
        if (!localUri) throw new Error("Impossibile creare una copia locale del file (picker).");
        localPath = localUri.replace("file://", "");
      }

      if (isTextLikeExt(ext) || (mime ?? "").startsWith("text/")) {
        const raw = await RNFS.readFile(localPath, "utf8");
        const finalText = ext === "rtf" ? stripRtf(raw) : raw;
        const start = await applyTextForCurrentFile(fid, finalText);
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
        const start = await applyTextForCurrentFile(fid, docText);
        setIsExtracting(false);
        if (autoStart) setTimeout(() => speakFrom(start), 200);
        return;
      }

      if (ext === "pdf" || mime === "application/pdf") {
        const b64 = await RNFS.readFile(localPath, "base64");
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
        Alert.alert("Formato non supportato", `Non riesco a leggere:\n${name}`);
      }
    } catch (err: any) {
      setIsExtracting(false);
      Alert.alert("Errore", String(err?.message ?? err ?? "Errore apertura file"));
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
      Alert.alert("Errore", msg || "Errore scelta file");
    }
  };

  // ====== SHARE INTENT ======
  // Nessun clearReceivedFiles(): azzererebbe per sempre il listener della libreria
  // (singleton isClear=true). Il lato nativo annulla gia' l'intent dopo la lettura,
  // quindi i foreground successivi tornano vuoti e non riaprono il file.
  useEffect(() => {
    ReceiveSharingIntent.getReceivedFiles(
      async (files: any[]) => {
        if (!files || files.length === 0) return;
        if (processingShareRef.current) return;
        processingShareRef.current = true;
        try {
          const f = files[0];
          const name = f?.fileName || f?.filePath?.split?.(/[\\/]/).pop?.() || "condiviso";
          const mime = f?.mimeType || "";
          const uri =
            f?.contentUri ||
            (f?.filePath ? (f.filePath.startsWith("file://") ? f.filePath : `file://${f.filePath}`) : null);
          if (!uri) return;
          await openFileFromUri(name, uri, mime, true, true);
        } catch (e: any) {
          Alert.alert("Condivisione", String(e?.message ?? e ?? "Errore"));
          setIsExtracting(false);
        } finally {
          processingShareRef.current = false;
        }
      },
      () => {},
      "ShareMedia"
    );
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

  return (
    <View style={[s.container, { paddingTop: insets.top }]}>
      <StatusBar barStyle={palette.statusBar} backgroundColor={palette.bg} />

      {/* HEADER */}
      <View style={s.header}>
        <Pressable onPress={pickFile} disabled={busy} style={s.headerBtn} android_ripple={{ color: palette.border, borderless: true }}>
          <Text style={s.headerIcon}>📂</Text>
        </Pressable>

        <Pressable onPress={goToCurrent} style={s.headerTitleWrap}>
          <Text numberOfLines={1} style={s.headerTitle}>
            {picked?.name || "LeggiMi"}
          </Text>
          {segments.length > 0 && (
            <Text numberOfLines={1} style={s.headerSub}>
              {currentChapterIdx >= 0 ? `${chapters[currentChapterIdx].title} · ` : ""}{pct}% · frase {currentIdx + 1}/{segments.length}
            </Text>
          )}
        </Pressable>

        {chapters.length > 1 && (
          <Pressable onPress={() => setChaptersOpen(true)} style={s.headerBtn} android_ripple={{ color: palette.border, borderless: true }}>
            <Text style={s.headerIcon}>☰</Text>
          </Pressable>
        )}
        <Pressable onPress={() => setSettingsOpen(true)} style={s.headerBtn} android_ripple={{ color: palette.border, borderless: true }}>
          <Text style={s.headerAa}>Aa</Text>
        </Pressable>
      </View>

      {/* PROGRESS BAR */}
      <View style={s.progressTrack}>
        <View style={[s.progressFill, { width: `${pct}%` }]} />
      </View>

      {/* CONTENUTO */}
      <View style={s.readerArea}>
        {segments.length === 0 && !busy ? (
          <View style={s.emptyWrap}>
            <Text style={s.emptyEmoji}>📖</Text>
            <Text style={s.emptyTitle}>Ascolta i tuoi documenti</Text>
            <Text style={s.emptyText}>
              Apri un file PDF, Word, TXT o RTF — oppure condividilo a LeggiMi da un'altra app — e te lo leggo ad alta voce.
            </Text>
            <Pressable onPress={pickFile} style={s.primaryBtn} android_ripple={{ color: "#ffffff30" }}>
              <Text style={s.primaryBtnText}>Apri un documento</Text>
            </Pressable>
            <Text style={s.emptyHint}>Suggerimento: in qualsiasi app premi “Condividi” e scegli LeggiMi.</Text>
          </View>
        ) : (
          <FlatList
            ref={listRef}
            data={segments}
            keyExtractor={(_, i) => String(i)}
            renderItem={renderItem}
            extraData={`${currentIdx}|${fontSize}|${themeName}`}
            initialNumToRender={20}
            maxToRenderPerBatch={20}
            windowSize={11}
            removeClippedSubviews
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
        )}

        {busy && (
          <View style={s.loadingOverlay}>
            <ActivityIndicator size="large" color={palette.accent} />
            <Text style={s.loadingText}>Estrazione del testo…</Text>
            {picked?.name ? <Text style={s.loadingSub} numberOfLines={1}>{picked.name}</Text> : null}
          </View>
        )}
      </View>

      {/* TRANSPORT BAR */}
      <View style={[s.transport, { paddingBottom: Math.max(12, insets.bottom) }]}>
        <Pressable
          onPress={() => skipSegment(-1)}
          disabled={segments.length === 0}
          style={[s.tBtn, segments.length === 0 && s.tDisabled]}
          android_ripple={{ color: palette.border, borderless: true }}
        >
          <Text style={s.tIcon}>⏮</Text>
          <Text style={s.tLabel}>Prec.</Text>
        </Pressable>

        <Pressable
          onPress={onPlayPress}
          disabled={!canRead || busy}
          style={[s.playBtn, (!canRead || busy) && s.tDisabled]}
          android_ripple={{ color: "#ffffff40", borderless: true }}
        >
          <Text style={s.playIcon}>{isReading ? "❚❚" : "►"}</Text>
        </Pressable>

        <Pressable
          onPress={() => skipSegment(1)}
          disabled={segments.length === 0}
          style={[s.tBtn, segments.length === 0 && s.tDisabled]}
          android_ripple={{ color: palette.border, borderless: true }}
        >
          <Text style={s.tIcon}>⏭</Text>
          <Text style={s.tLabel}>Succ.</Text>
        </Pressable>

        <Pressable onPress={cycleSpeed} style={s.speedPill} android_ripple={{ color: palette.border }}>
          <Text style={s.speedText}>{rate.toFixed(2)}×</Text>
          <Text style={s.tLabel}>Velocità</Text>
        </Pressable>
      </View>

      {/* SHEET IMPOSTAZIONI */}
      <Modal visible={settingsOpen} transparent animationType="slide" onRequestClose={() => setSettingsOpen(false)}>
        <Pressable style={s.backdrop} onPress={() => setSettingsOpen(false)} />
        <View style={s.sheet}>
          <View style={s.sheetHandle} />
          <Text style={s.sheetTitle}>Impostazioni lettura</Text>

          <Text style={s.sheetLabel}>Tema</Text>
          <View style={s.segmented}>
            {(["dark", "light", "sepia"] as ThemeName[]).map((t) => (
              <Pressable
                key={t}
                onPress={() => setThemeName(t)}
                style={[s.segItem, themeName === t && s.segItemActive]}
              >
                <Text style={[s.segText, themeName === t && s.segTextActive]}>
                  {t === "dark" ? "Scuro" : t === "light" ? "Chiaro" : "Seppia"}
                </Text>
              </Pressable>
            ))}
          </View>

          <Text style={s.sheetLabel}>Dimensione testo</Text>
          <View style={s.fontRow}>
            <Pressable
              onPress={() => setFontIndex((i) => Math.max(0, i - 1))}
              disabled={fontIndex <= 0}
              style={[s.fontBtn, fontIndex <= 0 && s.tDisabled]}
            >
              <Text style={s.fontBtnText}>A−</Text>
            </Pressable>
            <Text style={s.fontPreview}>{fontSize}px</Text>
            <Pressable
              onPress={() => setFontIndex((i) => Math.min(FONT_SIZES.length - 1, i + 1))}
              disabled={fontIndex >= FONT_SIZES.length - 1}
              style={[s.fontBtn, fontIndex >= FONT_SIZES.length - 1 && s.tDisabled]}
            >
              <Text style={s.fontBtnText}>A+</Text>
            </Pressable>
          </View>

          <Text style={s.sheetLabel}>Velocità voce: {rate.toFixed(2)}×</Text>
          <Slider
            minimumValue={0.5}
            maximumValue={2.0}
            step={0.05}
            value={rate}
            onValueChange={setRate}
            minimumTrackTintColor={palette.accent}
            maximumTrackTintColor={palette.border}
            thumbTintColor={palette.accent}
          />

          <Text style={s.sheetLabel}>Voce</Text>
          <Pressable
            onPress={() => { setSettingsOpen(false); setVoicesOpen(true); }}
            style={s.rowSelect}
            android_ripple={{ color: palette.border }}
          >
            <Text style={s.rowSelectText} numberOfLines={1}>{currentVoiceLabel}</Text>
            <Text style={s.rowSelectChevron}>›</Text>
          </Pressable>

          <Pressable onPress={() => setSettingsOpen(false)} style={s.sheetClose} android_ripple={{ color: "#ffffff30" }}>
            <Text style={s.sheetCloseText}>Fatto</Text>
          </Pressable>
        </View>
      </Modal>

      {/* SHEET CAPITOLI */}
      <Modal visible={chaptersOpen} transparent animationType="slide" onRequestClose={() => setChaptersOpen(false)}>
        <Pressable style={s.backdrop} onPress={() => setChaptersOpen(false)} />
        <View style={[s.sheet, { maxHeight: "70%" }]}>
          <View style={s.sheetHandle} />
          <Text style={s.sheetTitle}>Indice</Text>
          <ScrollView style={{ marginTop: 4 }}>
            {chapters.map((ch, idx) => {
              const active = idx === currentChapterIdx;
              return (
                <Pressable
                  key={idx}
                  onPress={() => skipToChapter(ch)}
                  style={[s.chapterRow, active && { backgroundColor: palette.surface2 }]}
                  android_ripple={{ color: palette.border }}
                >
                  <Text style={[s.chapterText, active && { color: palette.accent, fontWeight: "700" }]} numberOfLines={2}>
                    {ch.title}
                  </Text>
                  <Text style={s.chapterMeta}>{ch.startIndex + 1}–{ch.endIndex + 1}</Text>
                </Pressable>
              );
            })}
          </ScrollView>
          <Pressable onPress={() => setChaptersOpen(false)} style={s.sheetClose} android_ripple={{ color: "#ffffff30" }}>
            <Text style={s.sheetCloseText}>Chiudi</Text>
          </Pressable>
        </View>
      </Modal>

      {/* SHEET VOCE */}
      <Modal visible={voicesOpen} transparent animationType="slide" onRequestClose={() => setVoicesOpen(false)}>
        <Pressable style={s.backdrop} onPress={() => setVoicesOpen(false)} />
        <View style={[s.sheet, { maxHeight: "75%" }]}>
          <View style={s.sheetHandle} />
          <Text style={s.sheetTitle}>Voce italiana</Text>
          <Text style={s.voiceHint}>Tocca una voce per ascoltarne un'anteprima. La scelta viene salvata automaticamente.</Text>
          <ScrollView style={{ marginTop: 6 }}>
            <Pressable
              onPress={() => onSelectVoice(null)}
              style={[s.chapterRow, !voiceId && { backgroundColor: palette.surface2 }]}
              android_ripple={{ color: palette.border }}
            >
              <Text style={[s.chapterText, !voiceId && { color: palette.accent, fontWeight: "700" }]}>Predefinita di sistema</Text>
              {!voiceId ? <Text style={s.voiceCheck}>✓</Text> : null}
            </Pressable>
            {voices.map((v, idx) => {
              const active = v.id === voiceId;
              return (
                <Pressable
                  key={v.id}
                  onPress={() => onSelectVoice(v.id)}
                  style={[s.chapterRow, active && { backgroundColor: palette.surface2 }]}
                  android_ripple={{ color: palette.border }}
                >
                  <View style={{ flex: 1, paddingRight: 10 }}>
                    <Text style={[s.chapterText, active && { color: palette.accent, fontWeight: "700" }]} numberOfLines={1}>
                      {voiceLabel(v, idx)}
                    </Text>
                    {v.networkConnectionRequired ? <Text style={s.voiceMeta}>richiede connessione</Text> : null}
                  </View>
                  {active ? <Text style={s.voiceCheck}>✓</Text> : null}
                </Pressable>
              );
            })}
            {voices.length === 0 ? (
              <Text style={s.voiceHint}>Nessuna voce italiana trovata sul telefono: installane una qui sotto.</Text>
            ) : null}
            <Pressable
              onPress={openInstallVoices}
              style={[s.chapterRow, { borderTopWidth: 1, borderTopColor: palette.border, marginTop: 6 }]}
              android_ripple={{ color: palette.border }}
            >
              <Text style={[s.chapterText, { color: palette.accent }]}>+ Installa altre voci…</Text>
            </Pressable>
          </ScrollView>
          <Pressable onPress={() => setVoicesOpen(false)} style={s.sheetClose} android_ripple={{ color: "#ffffff30" }}>
            <Text style={s.sheetCloseText}>Chiudi</Text>
          </Pressable>
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
              if (msg.ok) {
                const t = String(msg.text || "").trim();
                if (!t) {
                  Alert.alert("PDF", "PDF senza testo (scansionato): serve OCR.");
                  return;
                }
                if (!fileId) throw new Error("fileId mancante");
                const start = await applyTextForCurrentFile(fileId, t);
                setIsExtracting(false);
                setPdfBase64(null);
                if (pendingAutoStartRef.current) {
                  pendingAutoStartRef.current = false;
                  setTimeout(() => speakFrom(start), 250);
                }
              } else {
                Alert.alert("PDF", msg.error || "Errore estrazione PDF offline");
              }
            } catch (err: any) {
              Alert.alert("PDF", String(err?.message ?? "Errore parsing PDF"));
            } finally {
              setIsExtracting(false);
              setPdfBase64(null);
              pendingAutoStartRef.current = false;
            }
          }}
          onError={() => {
            Alert.alert("PDF", "Errore WebView durante estrazione PDF offline");
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
      paddingHorizontal: 8,
      height: 52,
    },
    headerBtn: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: 22 },
    headerIcon: { fontSize: 20, color: p.text },
    headerAa: { fontSize: 17, fontWeight: "800", color: p.text },
    headerTitleWrap: { flex: 1, paddingHorizontal: 6 },
    headerTitle: { color: p.text, fontSize: 15, fontWeight: "700" },
    headerSub: { color: p.dim, fontSize: 11, marginTop: 1 },

    progressTrack: { height: 3, backgroundColor: p.border },
    progressFill: { height: 3, backgroundColor: p.accent },

    readerArea: { flex: 1 },
    listContent: { paddingVertical: 10, paddingBottom: 28 },

    emptyWrap: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 32 },
    emptyEmoji: { fontSize: 52, marginBottom: 14 },
    emptyTitle: { color: p.text, fontSize: 22, fontWeight: "800", marginBottom: 10, textAlign: "center" },
    emptyText: { color: p.dim, fontSize: 15, lineHeight: 22, textAlign: "center", marginBottom: 22 },
    primaryBtn: { backgroundColor: p.accent, paddingHorizontal: 26, paddingVertical: 14, borderRadius: 28 },
    primaryBtnText: { color: p.onAccent, fontSize: 16, fontWeight: "700" },
    emptyHint: { color: p.dim, fontSize: 12.5, textAlign: "center", marginTop: 18, lineHeight: 18 },

    loadingOverlay: {
      ...StyleSheet.absoluteFillObject,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: p.bg + "E6",
    },
    loadingText: { color: p.text, fontSize: 15, fontWeight: "600", marginTop: 14 },
    loadingSub: { color: p.dim, fontSize: 12.5, marginTop: 6, maxWidth: "80%" },

    transport: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-around",
      paddingTop: 10,
      backgroundColor: p.surface,
      borderTopWidth: 1,
      borderTopColor: p.border,
    },
    tBtn: { alignItems: "center", justifyContent: "center", minWidth: 56, paddingVertical: 4 },
    tIcon: { color: p.text, fontSize: 22 },
    tLabel: { color: p.dim, fontSize: 10.5, marginTop: 3 },
    tDisabled: { opacity: 0.32 },

    playBtn: {
      width: 64,
      height: 64,
      borderRadius: 32,
      backgroundColor: p.accent,
      alignItems: "center",
      justifyContent: "center",
      marginTop: -6,
    },
    playIcon: { color: p.onAccent, fontSize: 24, fontWeight: "900" },

    speedPill: { alignItems: "center", justifyContent: "center", minWidth: 56, paddingVertical: 4 },
    speedText: { color: p.text, fontSize: 16, fontWeight: "800" },

    backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: "#00000080" },
    sheet: {
      position: "absolute",
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: p.surface,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      paddingHorizontal: 20,
      paddingTop: 8,
      paddingBottom: 30,
    },
    sheetHandle: { alignSelf: "center", width: 40, height: 4, borderRadius: 2, backgroundColor: p.border, marginBottom: 14 },
    sheetTitle: { color: p.text, fontSize: 18, fontWeight: "800", marginBottom: 16 },
    sheetLabel: { color: p.dim, fontSize: 13, marginTop: 14, marginBottom: 8, fontWeight: "600" },

    segmented: { flexDirection: "row", backgroundColor: p.surface2, borderRadius: 12, padding: 4 },
    segItem: { flex: 1, paddingVertical: 10, borderRadius: 9, alignItems: "center" },
    segItemActive: { backgroundColor: p.accent },
    segText: { color: p.text, fontWeight: "600", fontSize: 14 },
    segTextActive: { color: p.onAccent, fontWeight: "800" },

    fontRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
    fontBtn: { backgroundColor: p.surface2, borderRadius: 12, paddingHorizontal: 22, paddingVertical: 12, minWidth: 72, alignItems: "center" },
    fontBtnText: { color: p.text, fontSize: 18, fontWeight: "800" },
    fontPreview: { color: p.text, fontSize: 16, fontWeight: "700" },

    sheetClose: { marginTop: 22, backgroundColor: p.accent, borderRadius: 14, paddingVertical: 14, alignItems: "center" },
    sheetCloseText: { color: p.onAccent, fontSize: 16, fontWeight: "800" },

    chapterRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 14, paddingHorizontal: 12, borderRadius: 10 },
    chapterText: { color: p.text, fontSize: 15, flex: 1, paddingRight: 10 },
    chapterMeta: { color: p.dim, fontSize: 12 },

    rowSelect: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", backgroundColor: p.surface2, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 14 },
    rowSelectText: { color: p.text, fontSize: 15, fontWeight: "600", flex: 1, paddingRight: 10 },
    rowSelectChevron: { color: p.dim, fontSize: 22, marginTop: -2 },
    voiceHint: { color: p.dim, fontSize: 12.5, lineHeight: 18, marginTop: 4 },
    voiceMeta: { color: p.dim, fontSize: 11.5, marginTop: 2 },
    voiceCheck: { color: p.accent, fontSize: 18, fontWeight: "800" },
  });
}
