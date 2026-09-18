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
  Linking,
  PermissionsAndroid,
  Platform,
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
import TextRecognition from "@react-native-ml-kit/text-recognition";
import {
  INK, CREAM, PAPER, YELLOW, CORAL, MINT, SKY, GRAPE, TANGERINE, AQUA, BUBBLEGUM,
  FONT_POSTER, FONT_BODY, FONT_BOLD, THEMES, Palette, ThemeName,
  ComicBox, ComicButton, ComicIconButton, ComicChip, PosterTitle,
} from "./src/comic";
import ScanStudio from "./src/scan/ScanStudio";
import CloudSheet, { UploadFile } from "./src/cloud/CloudSheet";
import { ScanDoc, deleteScan, scanNative, safeFileName, loadScan, needsOcr } from "./src/scan/store";
import {
  WHISPER_MODELS, WhisperModelKey, isAudio, getModelKey, setModelKey, hasModel, downloadModel, deleteModel,
  transcribeAudio, fmtDuration, cancelModelDownload,
} from "./src/audio/transcribe";

type DocKind = "pdf" | "docx" | "txt" | "md" | "rtf" | "image" | "text" | "print" | "scan" | "audio" | "other";
type DocSource = "picker" | "share" | "print" | "scan";
type Picked = { name: string; uri: string; type?: string | null; kind?: DocKind; ocr?: boolean };
/** One row of the Library (history): what was opened, how far you got. */
type LibraryEntry = {
  id: string; // same key used for progress:<id>
  name: string;
  kind: DocKind;
  source: DocSource;
  addedAt: number;
  lastOpenedAt: number;
  total: number;
  index: number;
  ocr: boolean;
  markdown: boolean;
  textPath: string; // cached clean text, so reopening is instant (and OCR runs once); "" = not read yet
  scanId?: string; // for scanned documents: the ScanStudio document
  pages?: number; // for scanned documents: number of pages
};
type Chapter = { title: string; startIndex: number; endIndex: number };
type Voice = { id: string; name?: string; language?: string; quality?: number; latency?: number; networkConnectionRequired?: boolean; notInstalled?: boolean };

const SETTINGS_RATE_KEY = "settings:ttsRate";
const SETTINGS_THEME_KEY = "settings:theme";
const SETTINGS_FONT_KEY = "settings:fontIndex";
const SETTINGS_VOICE_KEY = "settings:ttsVoice";

const FONT_SIZES = [15, 17, 19, 21, 24, 27, 31];
const SPEED_PRESETS = [0.75, 1.0, 1.25, 1.5, 1.75, 2.0];

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

/** First line of a cleaned text whose chapters come from its table of contents. */
const TOC_MARK = "<!--toc-->";
const stripMarkers = (text: string) => (text.startsWith(TOC_MARK) ? text.slice(TOC_MARK.length).trim() : text);

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

  // Titles listed in the table of contents: the TOC rows are not read aloud,
  // but their titles tell us which lines of the body are chapter headings.
  const tocTitles: string[] = [];

  // Tables of contents without dot leaders, e.g.
  //   Indice
  //   1. Primo giorno 1          (page on the same line)
  //   2. Che puzza di nafta
  //   29                         (or on the next line)
  // Found after an "Indice / Sommario / Contents" line: at least 3 entries.
  const tocSkip = new Set<number>();
  const TOC_HEADER = /^(indice|indice generale|sommario|contents|table of contents|index)$/i;
  for (let i = 0; i < lines.length; i++) {
    if (!TOC_HEADER.test(lines[i])) continue;
    const found: string[] = [];
    const used: number[] = [i];
    let pending: string[] = [];
    let pendingIdx: number[] = [];
    for (let j = i + 1; j < lines.length && j < i + 600; j++) {
      const l = lines[j];
      if (!l) continue;
      if (/^\d{1,4}$/.test(l)) {
        used.push(j);
        if (pending.length) {
          found.push(pending.join(" "));
          used.push(...pendingIdx);
          pending = [];
          pendingIdx = [];
        }
        continue;
      }
      const withPage = l.match(/^(.*\S)\s+(\d{1,4})$/);
      if (withPage && withPage[1].length <= 150 && withPage[1].replace(/[\d\s.]/g, "").length >= 3) {
        found.push([...pending, withPage[1]].join(" "));
        used.push(...pendingIdx, j);
        pending = [];
        pendingIdx = [];
        continue;
      }
      // a title may wrap on two lines; three plain lines in a row = the body started
      if (l.length > 150 || pending.length >= 2) break;
      pending.push(l);
      pendingIdx.push(j);
    }
    if (found.length >= 3) {
      tocTitles.push(...found);
      used.forEach((k) => tocSkip.add(k));
    }
  }

  const cleanedLines: string[] = [];
  for (let li = 0; li < lines.length; li++) {
    const l = lines[li];
    if (tocSkip.has(li)) continue;
    const low = l.toLowerCase();
    if (!l) { cleanedLines.push(""); continue; }
    if (/^\d{1,4}(\s*\/\s*\d{1,4})?$/.test(l)) continue; // page numbers
    if (/^(pag(ina|e)?|page|p)\.?\s*\d{1,4}(\s*(di|of|\/)\s*\d{1,4})?$/i.test(l)) continue; // "Pagina 3 di 10"
    if (/^(https?:\/\/|www\.)\S+$/i.test(l)) continue; // isolated urls
    if (l.length <= 1) continue;
    // table-of-contents rows: "Chapter 2 ........ 83" / "TITLE ..14" / "1.2 Title · · · · 15"
    const toc = l.match(/^(.*?\S)\s*(?:\.\s?){2,}\s*\d{1,4}\s*$/) || l.match(/^(.*?\S)\s*(?:·\s?){3,}\s*\d{1,4}\s*$/);
    if (toc) {
      if (toc[1].replace(/[.\s\d]/g, "").length >= 3) tocTitles.push(toc[1]);
      continue;
    }
    if (/(\.\s?){6,}/.test(l) && l.replace(/[.\s\d]/g, "").length < 40) continue;

    const c = counts.get(low) ?? 0;
    if (c >= 3 && low.length >= 12 && low.length <= 80) continue; // header/footer ripetuti
    if (/copyright|all rights reserved|powered by/i.test(l) && c >= 2) continue;

    cleanedLines.push(l);
  }

  // Unwrap lines broken by the page layout: a line that does not end a
  // sentence, or a line starting in lowercase (even after a page break),
  // continues the previous one. Headings, list items and dialogue dashes
  // keep their own line.
  const TERMINAL = /[.!?…:;"”»)\]]\s*$/;
  const OWN_LINE = /^(#{1,6}\s|[-*•]\s|\d{1,3}[.)]\s|[—–-]\s|["“«])/;
  // compare titles without case, accents, punctuation or dash styles
  const normTitle = (x: string) =>
    x.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const tocSet = new Set(tocTitles.map(normTitle).filter((x) => x.length >= 4));
  const isTocTitle = (line: string) => {
    if (!tocSet.size || line.length > 140) return false;
    const n = normTitle(line.replace(/^#{1,6}\s+/, ""));
    if (!n) return false;
    if (tocSet.has(n)) return true;
    for (const t of tocSet) {
      // a body heading may carry a little more ("Capitolo 3 – La visita" vs "La visita")
      if (n.startsWith(t) && n.length <= t.length + 4) return true;
      if (n.endsWith(t) && n.length <= t.length + 16 && t.length >= 6) return true;
    }
    return false;
  };
  // the first half of a TOC title split over two lines
  const isTocPrefix = (line: string) => {
    const n = normTitle(line.replace(/^#{1,6}\s+/, ""));
    if (n.length < 6) return false;
    for (const t of tocSet) if (t.startsWith(n) && t.length > n.length) return true;
    return false;
  };
  const merged: string[] = [];
  for (const l of cleanedLines) {
    if (!l) { merged.push(""); continue; }
    let j = merged.length - 1;
    let blanks = 0;
    while (j >= 0 && merged[j] === "") { j--; blanks++; }
    if (j >= 0) {
      const prev = merged[j];
      // a chapter title split on two lines ("7. Ritorno a casa, tutto come" +
      // "prima, anzi peggio…"): glue it back when together it is a TOC title
      // (the larger title font often leaves a blank line between the halves)
      if (
        tocSet.size &&
        blanks <= 2 &&
        !isTocTitle(prev) &&
        !isTocTitle(l) &&
        isTocPrefix(prev) &&
        isTocTitle(`${prev} ${l}`)
      ) {
        merged.length = j + 1;
        merged[j] = `${prev} ${l}`;
        continue;
      }
      const startsLower = /^[a-zà-öø-ÿ]/.test(l);
      const prevOpen = !TERMINAL.test(prev);
      // a long line ending mid-sentence (lowercase letter or comma) continues
      // even across a page break, whatever the next line starts with
      const prevMidSentence = prevOpen && prev.length > 40 && /[a-zà-öø-ÿ,;]$/.test(prev);
      const canJoin =
        !OWN_LINE.test(l) &&
        !isChapterHeading(prev) &&
        !isChapterHeading(l) &&
        !isTocTitle(prev) &&
        !isTocTitle(l) &&
        (startsLower || (prevOpen && blanks === 0) || prevMidSentence);
      if (canJoin) {
        merged.length = j + 1;
        merged[j] = prev + " " + l;
        continue;
      }
    }
    merged.push(l);
  }

  // lines named in the table of contents become real headings (kept in the
  // cached text too, so the Library reopens the document with the same chapters)
  if (tocSet.size) {
    for (let i = 0; i < merged.length; i++) {
      const m = merged[i];
      if (m && !m.startsWith("#") && isTocTitle(m)) merged[i] = `## ${m}`;
    }
  } else {
    // no table of contents: an isolated "12. Some title" line (not part of a
    // numbered list) is a chapter heading rather than a list item
    const NUMBERED = /^\d{1,3}[.)]\s/;
    const near = (i: number, step: number) => {
      for (let k = i + step; k >= 0 && k < merged.length; k += step) if (merged[k]) return merged[k];
      return "";
    };
    for (let i = 0; i < merged.length; i++) {
      const m = merged[i];
      if (!m || !/^\d{1,3}\.\s+\p{Lu}/u.test(m) || m.length > 90 || /[.;,:]$/.test(m)) continue;
      if (!NUMBERED.test(near(i, -1)) && !NUMBERED.test(near(i, 1))) merged[i] = `## ${m}`;
    }
  }

  let out = merged.join("\n");
  out = out.replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();
  return tocSet.size ? `${TOC_MARK}\n${out}` : out;
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
  let t = normalizeText(raw);
  // text whose chapters come from its table of contents: trust those and do
  // not turn every UPPERCASE line (title page, author) into a chapter
  const tocDriven = t.startsWith(TOC_MARK);
  if (tocDriven) t = t.slice(TOC_MARK.length).trim();
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
    if (!markdown && (tocDriven ? isStrongHeading(firstLine) : isChapterHeading(firstLine)) && block.length <= 90 && !block.includes("\n")) {
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
      // keep very short sentences ("Questions?", "Ask Sam.") attached to a
      // neighbour instead of making a one-word block
      else if (acc.length < minMerge || (s.length < 30 && acc.length + s.length + 1 <= maxChars)) acc += " " + s;
      else { flush(); acc = s; }
    }
    flush();
  }
  return out.filter(Boolean);
}

// Front/back matter titles that open a section on their own line
const SECTION_WORDS =
  /^(prefazione|introduzione|premessa|prologo|epilogo|postfazione|ringraziamenti|conclusioni?|appendice|nota dell['’]autore|preface|introduction|foreword|prologue|epilogue|afterword|acknowledg(e)?ments|conclusions?|appendix)(\s*[–—:-]\s*\S.*)?$/i;

/** Headings that are headings in any case (with or without a table of contents). */
function isStrongHeading(line: string) {
  const s = (line || "").trim();
  if (s.length < 3 || s.length > 80) return false;
  if (/^#{1,6}\s+/.test(s)) return true;
  if (SECTION_WORDS.test(s)) return true;
  return /^([Cc]apitolo|[Pp]arte|[Ss]ezione|[Aa]rticolo|[Cc]hapter|[Ss]ection|[Pp]art|CAPITOLO|PARTE|SEZIONE|ARTICOLO|CHAPTER|SECTION|PART)\s+(\d{1,4}|[IVXLCDM]{1,7})(?=$|[\s.:;,–—-])/.test(s);
}

function isChapterHeading(line: string) {
  const s = (line || "").trim();
  if (s.length < 3) return false;
  if (/^#{1,6}\s+/.test(s)) return true;
  if (isStrongHeading(s)) return true;
  // "Capitolo 3", "Parte II", "Chapter 12 – Title": roman numerals must be
  // uppercase, otherwise "parte di un vetro" would look like "Parte DI".
  if (s.length <= 80 && /^([Cc]apitolo|[Pp]arte|[Ss]ezione|[Aa]rticolo|[Cc]hapter|[Ss]ection|[Pp]art|CAPITOLO|PARTE|SEZIONE|ARTICOLO|CHAPTER|SECTION|PART)\s+(\d{1,4}|[IVXLCDM]{1,7})(?=$|[\s.:;,–—-])/.test(s)) return true;
  if (s.length <= 80 && /^(\d+(\.\d+)*|[IVXLCDM]+)\.\s+\S/.test(s)) return true;

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

// ---- Library (history) ------------------------------------------------------
const LIBRARY_KEY = "library:v1";
const LIBRARY_DIR = `${RNFS.DocumentDirectoryPath}/library`;
const LIBRARY_MAX = 200;
const IMAGE_EXTS = ["jpg", "jpeg", "png", "webp", "bmp", "gif", "heic", "heif", "tif", "tiff"];

function hashStr(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}
function kindOf(name: string, mime: string | null | undefined, source: DocSource): DocKind {
  if (source === "print") return "print";
  const ext = extOf(name);
  const m = (mime ?? "").toLowerCase();
  if (ext === "pdf" || m === "application/pdf") return "pdf";
  if (ext === "docx" || ext === "doc" || m.includes("wordprocessingml")) return "docx";
  if (ext === "md" || ext === "markdown" || m.includes("markdown")) return "md";
  if (ext === "rtf" || m.includes("rtf")) return "rtf";
  if (IMAGE_EXTS.includes(ext) || m.startsWith("image/")) return "image";
  if (isAudio(name, mime)) return "audio";
  if (ext === "txt" || m.startsWith("text/") || isTextLikeExt(ext)) return "txt";
  return "other";
}
function kindEmoji(k: DocKind) {
  switch (k) {
    case "pdf": return "📕";
    case "docx": return "📘";
    case "md": return "📝";
    case "rtf": return "📄";
    case "image": return "🖼️";
    case "text": return "💬";
    case "print": return "🖨️";
    case "scan": return "📷";
    case "audio": return "🎙️";
    case "txt": return "📄";
    default: return "📎";
  }
}
function kindColor(k: DocKind) {
  switch (k) {
    case "pdf": return CORAL;
    case "docx": return SKY;
    case "md": return TANGERINE;
    case "rtf": return GRAPE;
    case "image": return BUBBLEGUM;
    case "text": return AQUA;
    case "print": return YELLOW;
    case "scan": return SKY;
    case "audio": return AQUA;
    default: return MINT;
  }
}
function kindLabel(k: DocKind) {
  switch (k) {
    case "docx": return "DOC";
    case "image": return "IMG";
    case "text": return "TXT";
    case "print": return "PRNT";
    case "scan": return "SCAN";
    case "audio": return "AUDIO";
    case "other": return "FILE";
    default: return k.toUpperCase();
  }
}
async function loadLibrary(): Promise<LibraryEntry[]> {
  try {
    const raw = await AsyncStorage.getItem(LIBRARY_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((e) => e && typeof e.id === "string") : [];
  } catch { return []; }
}
async function persistLibrary(list: LibraryEntry[]) {
  await AsyncStorage.setItem(LIBRARY_KEY, JSON.stringify(list.slice(0, LIBRARY_MAX)));
}
function fmtDate(ts: number) {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hh = `${d.getHours()}`.padStart(2, "0");
  const mm = `${d.getMinutes()}`.padStart(2, "0");
  if (sameDay) return `today ${hh}:${mm}`;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const year = d.getFullYear() === now.getFullYear() ? "" : ` ${d.getFullYear()}`;
  return `${d.getDate()} ${months[d.getMonth()]}${year}`;
}

// ---- OCR (Google ML Kit, on device) ----------------------------------------
function ocrAvailable() {
  return !!(NativeModules as any)?.TextRecognition;
}
async function ocrImageFile(path: string): Promise<string> {
  const url = /^(file|content):\/\//.test(path) ? path : `file://${path}`;
  const res: any = await TextRecognition.recognize(url);
  const blocks: string[] = (res?.blocks || [])
    .map((b: any) => (b?.lines || []).map((l: any) => String(l?.text || "").trim()).filter(Boolean).join("\n"))
    .filter(Boolean);
  return blocks.length ? blocks.join("\n\n") : String(res?.text || "");
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

    // Rebuild lines and paragraphs from glyph positions: pdf.js gives text
    // runs with a transform (x, y); a vertical jump means a new line, a
    // bigger jump means a paragraph break. Joining everything with spaces
    // (the naive way) loses headings, lists and tables of contents.
    let full = "";
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      const lines = [];
      let cur = "";
      let lastY = null, lastH = 10, lastX2 = null;
      for (const it of content.items) {
        const str = it.str || "";
        if (!str && !it.hasEOL) continue;
        const tr = it.transform || [1, 0, 0, 1, 0, 0];
        const x = tr[4], y = tr[5];
        const h = Math.max(4, Math.abs(tr[3]) || it.height || lastH);
        if (lastY !== null) {
          const dy = Math.abs(y - lastY);
          if (dy > h * 0.55) {
            lines.push(cur.trim());
            cur = "";
            if (dy > h * 1.9) lines.push("");
          } else if (lastX2 !== null && x - lastX2 > h * 0.18 && cur && !cur.endsWith(" ") && !str.startsWith(" ")) {
            cur += " ";
          }
        }
        cur += str;
        if (it.hasEOL && !str.endsWith("-")) {
          lines.push(cur.trim());
          cur = "";
          lastY = null; lastX2 = null;
          continue;
        }
        lastY = y; lastH = h; lastX2 = x + (it.width || 0);
      }
      if (cur.trim()) lines.push(cur.trim());
      full += lines.join("\\n") + "\\n\\n";
    }

    // OCR support: the app can ask for page bitmaps one at a time
    // (window.__renderPage(n) via injectJavaScript) when the PDF has no text.
    window.__renderPage = async (n) => {
      try {
        const page = await pdf.getPage(n);
        const vp0 = page.getViewport({ scale: 1 });
        const scale = Math.min(2.4, Math.max(1.3, 1600 / Math.max(vp0.width, vp0.height)));
        const vp = page.getViewport({ scale });
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(vp.width);
        canvas.height = Math.ceil(vp.height);
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        const dataUrl = canvas.toDataURL("image/jpeg", 0.88);
        window.ReactNativeWebView.postMessage(
          JSON.stringify({ type: "page", page: n, total: pdf.numPages, jpeg: dataUrl.split(",")[1] })
        );
      } catch (e) {
        window.ReactNativeWebView.postMessage(
          JSON.stringify({ type: "pageError", page: n, error: String(e) })
        );
      }
    };

    window.ReactNativeWebView.postMessage(
      JSON.stringify({ type: "text", ok: true, text: full.trim(), pages: pdf.numPages })
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
  const webRef = useRef<WebView | null>(null);

  // OCR of a scanned PDF: pages are rendered one at a time by the WebView
  const [ocrState, setOcrState] = useState<{ page: number; total: number } | null>(null);
  const ocrRef = useRef<{ fid: string; texts: string[]; total: number } | null>(null);

  // Library (history of opened documents)
  const [library, setLibrary] = useState<LibraryEntry[]>([]);
  const libraryRef = useRef<LibraryEntry[]>([]);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const persistTimerRef = useRef<any>(null);
  // what the document being opened is, for the library row
  const currentMetaRef = useRef<{ name: string; kind: DocKind; source: DocSource; ocr: boolean; scanId?: string; pages?: number } | null>(null);

  // Scanner workspace (CamScanner-like)
  const [scanOpen, setScanOpen] = useState<{
    docId: string | null;
    start: "camera" | "import" | "export" | null;
    images?: string[];
    imagesMode?: "asis" | "crop";
  } | null>(null);

  // Comic choice sheet (replaces the 3-button system dialog when there are more options)
  type ChoiceOption = { key: string; icon: string; label: string; sub?: string; color: string };
  const [choice, setChoice] = useState<{ title: string; message?: string; emoji?: string; options: ChoiceOption[] } | null>(null);
  const choiceResolveRef = useRef<((k: string | null) => void) | null>(null);
  const askChoice = (title: string, message: string, emoji: string, options: ChoiceOption[]) =>
    new Promise<string | null>((resolve) => {
      choiceResolveRef.current = resolve;
      setChoice({ title, message, emoji, options });
    });
  const answerChoice = (k: string | null) => {
    const r = choiceResolveRef.current;
    choiceResolveRef.current = null;
    setChoice(null);
    r?.(k);
  };

  // cloud accounts sheet; with a file it asks where to upload it
  const [cloudOpen, setCloudOpen] = useState<{ file: UploadFile | null; onUploaded?: () => void } | null>(null);
  const [speechModelLabel, setSpeechModelLabel] = useState("");

  // long local jobs (model download, transcription) shown in the loading card
  const [task, setTask] = useState<{ title: string; sub?: string; progress?: number; cancel?: () => void } | null>(null);

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
  // Nearby moves (next sentence) glide; far jumps (a chapter, a restored
  // position) land directly, without animating through all the text between.
  const lastScrollIdxRef = useRef(0);
  const jumpViewPosRef = useRef<number | null>(null);
  // Without fixed row heights a FlatList cannot scroll past the rows it has
  // drawn, so reaching a far row means drawing everything before it. So the
  // list shows a window of the text, segments[base…]: a far jump starts a new
  // window a few rows above the target, and scrolling back up prepends the
  // earlier rows in chunks while the visible text stays still.
  const [listWin, setListWin] = useState({ key: 0, base: 0 });
  const listBaseRef = useRef(0);
  const FAR_JUMP = 40;
  const WIN_LEAD = 6;
  const listData = useMemo(() => (listWin.base > 0 ? segments.slice(listWin.base) : segments), [segments, listWin.base]);

  const scrollToIndexSafe = useCallback((index: number, viewPosition = 0.32, animated?: boolean) => {
    const list = listRef.current;
    if (!list || index < 0 || index >= segmentsRef.current.length) return;
    const dist = Math.abs(index - lastScrollIdxRef.current);
    const glide = animated ?? dist <= 8;
    lastScrollIdxRef.current = index;
    const settle = () => {
      if (lastScrollIdxRef.current !== index) return; // moved elsewhere meanwhile
      const rel = index - listBaseRef.current;
      if (rel < 0) return;
      try { listRef.current?.scrollToIndex({ index: rel, viewPosition, animated: false }); } catch {}
    };
    if (index < listBaseRef.current || (!glide && dist > FAR_JUMP)) {
      const base = Math.max(0, index - WIN_LEAD);
      listBaseRef.current = base;
      setListWin((w) => ({ key: w.key + 1, base }));
      [80, 200, 450].forEach((ms) => setTimeout(settle, ms));
      return;
    }
    try {
      list.scrollToIndex({ index: index - listBaseRef.current, viewPosition, animated: glide });
    } catch {}
    if (!glide) [120, 300].forEach((ms) => setTimeout(settle, ms));
  }, []);

  // scrolled up to the top of the window: bring in the rows before it
  const onListStartReached = useCallback(() => {
    if (listBaseRef.current <= 0) return;
    const base = Math.max(0, listBaseRef.current - 60);
    listBaseRef.current = base;
    setListWin((w) => ({ ...w, base }));
  }, []);

  // a new document starts from wherever its saved position is: jump there
  // (declared first so it runs before the scroll effect below)
  useEffect(() => {
    lastScrollIdxRef.current = -1000;
    if (listBaseRef.current !== 0) {
      listBaseRef.current = 0;
      setListWin((w) => ({ key: w.key + 1, base: 0 }));
    }
  }, [segments]);

  useEffect(() => {
    if (!segments.length) return;
    const vp = jumpViewPosRef.current ?? 0.32;
    jumpViewPosRef.current = null;
    scrollToIndexSafe(currentIdx, vp);
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

  // ====== LIBRARY ======
  useEffect(() => {
    refreshSpeechModelLabel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    loadLibrary().then((list) => {
      libraryRef.current = list;
      setLibrary(list);
    });
  }, []);

  // keep the library row in step with the reading position (debounced)
  useEffect(() => {
    if (!fileId || !segments.length) return;
    const list = libraryRef.current;
    const i = list.findIndex((e) => e.id === fileId);
    if (i < 0 || list[i].index === currentIdx) return;
    const next = list.slice();
    next[i] = { ...next[i], index: currentIdx, total: segments.length, lastOpenedAt: Date.now() };
    libraryRef.current = next;
    clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(() => {
      setLibrary([...libraryRef.current]);
      persistLibrary(libraryRef.current).catch(() => {});
    }, 1200);
  }, [currentIdx, fileId, segments.length]);

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
    // the scroll itself happens in the currentIdx effect, with the heading near the top
    jumpViewPosRef.current = 0.1;
    if (next === currentIdx) scrollToIndexSafe(next, 0.1);
    setCurrentIdx(next);
    if (fileId) saveProgress(fileId, next).catch(() => {});
    if (isReading) hardStop().then(() => speakFrom(next));
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

    // remember it in the Library, with the clean text cached for instant reopening
    const meta = currentMetaRef.current;
    if (meta && segs.length) {
      try {
        await RNFS.mkdir(LIBRARY_DIR);
        const textPath = `${LIBRARY_DIR}/${hashStr(fid)}.txt`;
        await RNFS.writeFile(textPath, cleaned, "utf8");
        const now = Date.now();
        const prev = libraryRef.current.find((e) => e.id === fid);
        const entry: LibraryEntry = {
          ...(prev ?? {}),
          ...(meta.scanId ? { scanId: meta.scanId, pages: meta.pages } : {}),
          id: fid,
          name: meta.name,
          kind: meta.kind,
          source: meta.source,
          ocr: !!meta.ocr,
          markdown: !!opts.markdown,
          textPath,
          total: segs.length,
          index: clamped,
          addedAt: prev?.addedAt ?? now,
          lastOpenedAt: now,
        };
        const next = [entry, ...libraryRef.current.filter((e) => e.id !== fid)].slice(0, LIBRARY_MAX);
        libraryRef.current = next;
        setLibrary(next);
        persistLibrary(next).catch(() => {});
      } catch {}
    }
    return clamped;
  };

  const removeFromLibrary = async (entry: LibraryEntry) => {
    const next = libraryRef.current.filter((e) => e.id !== entry.id);
    libraryRef.current = next;
    setLibrary(next);
    persistLibrary(next).catch(() => {});
    if (entry.textPath) RNFS.unlink(entry.textPath).catch(() => {});
    AsyncStorage.removeItem(`progress:${entry.id}`).catch(() => {});
    if (entry.scanId) deleteScan(entry.scanId).catch(() => {});
  };

  // Clean the phone: everything LeggiMi keeps locally (never the cloud).
  const dirSize = async (dir: string): Promise<number> => {
    try {
      if (!(await RNFS.exists(dir))) return 0;
      let total = 0;
      for (const it of await RNFS.readDir(dir)) {
        total += it.isDirectory() ? await dirSize(it.path) : Number(it.size) || 0;
      }
      return total;
    } catch {
      return 0;
    }
  };

  const clearLibrary = async () => {
    setLibraryOpen(false);
    const what = await askChoice(
      "CLEAN THE PHONE",
      "Removes what LeggiMi keeps on this phone. Files already in your cloud stay there: delete them one by one in the cloud. Cloud accounts and the speech model are kept.",
      "🧹",
      [
        {
          key: "all",
          icon: "🧹",
          label: "Everything on this phone",
          sub: "Library, reading positions, scanned pages, temporary files and the files saved in Download/LeggiMi",
          color: CORAL,
        },
        {
          key: "app",
          icon: "🗂️",
          label: "Only the app data",
          sub: "Same, but keep the files saved in Download/LeggiMi",
          color: YELLOW,
        },
      ]
    );
    if (what !== "all" && what !== "app") return;
    const sure = await new Promise<boolean>((resolve) =>
      Alert.alert(
        "Delete for good?",
        what === "all"
          ? "Library, scans, temporary files and Download/LeggiMi will be deleted from this phone. This cannot be undone."
          : "Library, scans and temporary files will be deleted from this phone. This cannot be undone.",
        [
          { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
          { text: "Delete", style: "destructive", onPress: () => resolve(true) },
        ],
        { cancelable: true, onDismiss: () => resolve(false) }
      )
    );
    if (!sure) return;
    setIsExtracting(true);
    setTask({ title: "CLEANING…", sub: "Removing the local files" });
    try {
      // stop and close whatever is open
      await hardStop();
      setSegments([]);
      segmentsRef.current = [];
      setChapters([]);
      setPicked(null);
      setFileId(null);
      fileIdRef.current = null;

      const docs = libraryRef.current.length;
      const dirs = [LIBRARY_DIR, `${RNFS.DocumentDirectoryPath}/scans`, RNFS.CachesDirectoryPath];
      let freed = 0;
      for (const d of dirs) freed += await dirSize(d);
      await RNFS.unlink(LIBRARY_DIR).catch(() => {});
      await RNFS.unlink(`${RNFS.DocumentDirectoryPath}/scans`).catch(() => {});
      for (const it of await RNFS.readDir(RNFS.CachesDirectoryPath).catch(() => [] as any[])) {
        await RNFS.unlink(it.path).catch(() => {});
      }
      const keys = await AsyncStorage.getAllKeys();
      const drop = keys.filter((k) => k.startsWith("progress:") || k.startsWith("scan:"));
      if (drop.length) await AsyncStorage.multiRemove(drop);
      libraryRef.current = [];
      setLibrary([]);
      await persistLibrary([]);
      let removed = 0;
      if (what === "all") removed = await scanNative.clearDownloads().catch(() => 0);
      setTask(null);
      setIsExtracting(false);
      const mb = (freed / 1024 / 1024).toFixed(1);
      Alert.alert(
        "Phone cleaned",
        `${docs} document${docs === 1 ? "" : "s"} removed · ${mb} MB freed` +
          (what === "all" ? ` · ${removed} file${removed === 1 ? "" : "s"} deleted from Download/LeggiMi` : "") +
          ". Your cloud was not touched."
      );
    } catch (e: any) {
      setTask(null);
      setIsExtracting(false);
      Alert.alert("Clean", String(e?.message ?? e));
    }
  };

  // Reopen a document from the Library: the clean text is cached, so no
  // extraction (or OCR) is needed again.
  const openFromLibrary = async (entry: LibraryEntry) => {
    setLibraryOpen(false);
    if (entry.scanId && !entry.textPath) {
      setScanOpen({ docId: entry.scanId, start: null });
      return;
    }
    setIsExtracting(true);
    await hardStop();
    setSegments([]);
    segmentsRef.current = [];
    setChapters([]);
    setRawText("");
    setPicked({ name: entry.name, uri: "", type: null, kind: entry.kind, ocr: entry.ocr });
    setFileId(entry.id);
    fileIdRef.current = entry.id;
    currentMetaRef.current = { name: entry.name, kind: entry.kind, source: entry.source, ocr: entry.ocr, scanId: entry.scanId, pages: entry.pages };
    try {
      const text = await RNFS.readFile(entry.textPath, "utf8");
      const start = await applyTextForCurrentFile(entry.id, text, { markdown: entry.markdown });
      setIsExtracting(false);
      setTimeout(() => scrollToIndexSafe(start, 0.32), 250);
    } catch {
      setIsExtracting(false);
      setPicked(null);
      Alert.alert("Library", "The saved copy of this document is gone. Open it again from its app.");
      removeFromLibrary(entry);
    }
  };

  const confirmAsync = (title: string, message: string, okText = "OK", cancelText = "Cancel") =>
    new Promise<boolean>((resolve) => {
      Alert.alert(
        title,
        message,
        [
          { text: cancelText, style: "cancel", onPress: () => resolve(false) },
          { text: okText, onPress: () => resolve(true) },
        ],
        { cancelable: true, onDismiss: () => resolve(false) }
      );
    });

  // Pictures (photos of pages, screenshots...) have no text: ask what to do.
  const handleImages = async (fid: string, paths: string[], autoStart: boolean) => {
    setIsExtracting(false);
    const scans = libraryRef.current.filter((e) => e.scanId);
    const many = paths.length > 1;
    const k = await askChoice(
      many ? `${paths.length} IMAGES` : "AN IMAGE",
      many ? "These are pictures, not text. What should LeggiMi do with them?" : "This is a picture, not text. What should LeggiMi do with it?",
      "🖼️",
      [
        { key: "ocr", icon: "🔍", label: "Read the text", sub: "Recognise the text on the phone (OCR) and read it aloud", color: MINT },
        { key: "asis", icon: "💾", label: "Save as it is", sub: "Keep the picture in a new scanned document", color: YELLOW },
        { key: "crop", icon: "✂️", label: "Scan & crop", sub: "Find the sheet, straighten and enhance it", color: SKY },
        ...(scans.length
          ? [{ key: "add", icon: "➕", label: "Add to a scan…", sub: `Append to one of your ${scans.length} scanned document${scans.length > 1 ? "s" : ""}`, color: GRAPE }]
          : []),
      ]
    );
    if (k === "asis" || k === "crop") {
      setPicked(null);
      setScanOpen({ docId: null, start: null, images: paths, imagesMode: k });
      return;
    }
    if (k === "add") {
      const target = await askChoice(
        "ADD TO…",
        "Pick the scanned document that gets the new page" + (many ? "s." : "."),
        "➕",
        scans.slice(0, 12).map((e) => ({
          key: e.scanId!,
          icon: "📷",
          label: e.name,
          sub: `${e.pages ?? 0} page${e.pages === 1 ? "" : "s"} · ${fmtDate(e.lastOpenedAt)}`,
          color: SKY,
        }))
      );
      setPicked(null);
      if (target) setScanOpen({ docId: target, start: null, images: paths, imagesMode: "crop" });
      return;
    }
    if (k !== "ocr") { setPicked(null); return; }
    if (!ocrAvailable()) {
      Alert.alert("OCR", "This build has no OCR module. Install the latest LeggiMi build to read images.");
      setPicked(null);
      return;
    }
    setIsExtracting(true);
    try {
      const parts: string[] = [];
      for (let i = 0; i < paths.length; i++) {
        setOcrState({ page: i + 1, total: paths.length });
        const t = await ocrImageFile(paths[i]);
        if (t.trim()) parts.push(t.trim());
      }
      setOcrState(null);
      const text = parts.join("\n\n");
      if (!text.trim()) {
        setIsExtracting(false);
        setPicked(null);
        Alert.alert("OCR", "No readable text was found.");
        return;
      }
      if (currentMetaRef.current) currentMetaRef.current.ocr = true;
      setPicked((p) => (p ? { ...p, ocr: true } : p));
      const startIdx = await applyTextForCurrentFile(fid, text, { extracted: true });
      setIsExtracting(false);
      if (autoStart) setTimeout(() => speakFrom(startIdx), 200);
    } catch (err: any) {
      setOcrState(null);
      setIsExtracting(false);
      setPicked(null);
      Alert.alert("OCR", String(err?.message ?? err ?? "Text recognition failed"));
    }
  };

  // Several pictures shared at once (SEND_MULTIPLE)
  const openSharedImages = async (files: { name: string; uri: string }[]) => {
    await hardStop();
    setSegments([]);
    segmentsRef.current = [];
    setChapters([]);
    setRawText("");
    const label = `${files.length} images`;
    const fid = makeFileId(`images-${hashStr(files.map((f) => f.name).join("|"))}`, "image/*");
    setFileId(fid);
    fileIdRef.current = fid;
    currentMetaRef.current = { name: label, kind: "image", source: "share", ocr: false };
    setPicked({ name: label, uri: "", type: "image/*", kind: "image" });
    setIsExtracting(true);
    const paths: string[] = [];
    try {
      for (const f of files) paths.push(await copySharedUriToCache(f.uri, f.name));
    } catch (e: any) {
      setIsExtracting(false);
      setPicked(null);
      Alert.alert("Sharing", String(e?.message ?? e));
      return;
    }
    await handleImages(fid, paths, true);
  };

  // ---- recordings: offline transcription (whisper.cpp)
  // Transcripts: always saved in Download/LeggiMi first, then (optionally) cloud or share
  const saveTextExport = async (title: string, text: string, as: "txt" | "pdf", suffix = " (transcript)") => {
    const base = safeFileName(title.replace(/\.[a-z0-9]{2,4}$/i, "")) + suffix;
    await RNFS.mkdir(`${RNFS.CachesDirectoryPath}/export`).catch(() => {});
    try {
      const name = `${base}.${as}`;
      const mime = as === "pdf" ? "application/pdf" : "text/plain";
      const out = `${RNFS.CachesDirectoryPath}/export/${name}`;
      await RNFS.unlink(out).catch(() => {});
      if (as === "pdf") await scanNative.makePdf({ out, mode: "text", title, text });
      else await RNFS.writeFile(out, text, "utf8");
      const where = await scanNative.saveToDownloads(out, name, mime);
      const next = await askChoice(
        "SAVED",
        `${name}
is in ${where.replace(/\/[^/]+$/, "")}. Send it somewhere else too?`,
        "✅",
        [
          { key: "cloud", icon: "☁️", label: "Cloud", sub: "Into the LeggiMi folder of your cloud", color: GRAPE },
          { key: "share", icon: "📤", label: "Share", sub: "Send it to another app", color: SKY },
        ]
      );
      if (next === "cloud") setCloudOpen({ file: { path: out, name, mime } });
      else if (next === "share") await scanNative.shareFile(out, mime, name);
    } catch (e: any) {
      Alert.alert("Export", String(e?.message ?? e));
    }
  };

  // Library: save a document (always to Download/LeggiMi first), then cloud or share
  const exportFromLibrary = async (e: LibraryEntry) => {
    setLibraryOpen(false);
    const opts: ChoiceOption[] = [];
    if (e.scanId) {
      opts.push({ key: "scanpdf", icon: "🖼️", label: "PDF of the pages", sub: "Images, searchable or text only", color: SKY });
    }
    if (e.textPath) {
      opts.push(
        { key: "pdf", icon: "📕", label: "Text as PDF", sub: "Saved in Download/LeggiMi, then cloud or share", color: CORAL },
        { key: "txt", icon: "📄", label: "Text file (.txt)", sub: "Saved in Download/LeggiMi, then cloud or share", color: YELLOW }
      );
    }
    if (!opts.length) {
      Alert.alert("Export", "Nothing to export yet.");
      return;
    }
    const k = await askChoice("EXPORT", `“${e.name}”`, "📤", opts);
    if (k === "scanpdf" && e.scanId) {
      setScanOpen({ docId: e.scanId, start: "export" });
      return;
    }
    if (k !== "pdf" && k !== "txt") return;
    try {
      const text = stripMarkers(await RNFS.readFile(e.textPath, "utf8"));
      await saveTextExport(e.name, text, k, e.kind === "audio" ? " (transcript)" : "");
    } catch {
      Alert.alert("Export", "The saved text of this document is gone. Open it again from its app.");
    }
  };

  // Library: "Move to cloud" = upload a PDF to the LeggiMi folder of the cloud,
  // then (only if the upload worked) remove the document from this phone.
  const moveToCloud = async (e: LibraryEntry) => {
    setLibraryOpen(false);
    const ok = await askChoice(
      "MOVE TO CLOUD",
      `“${e.name}” is uploaded as a PDF to the LeggiMi folder of your cloud. When the upload is done it is removed from this phone (Library, text${e.scanId ? " and scanned pages" : ""}).`,
      "☁️",
      [{ key: "go", icon: "☁️", label: "Choose the cloud and move", sub: "Nothing is deleted if the upload fails", color: GRAPE }]
    );
    if (ok !== "go") return;
    const base = safeFileName(e.name.replace(/\.[a-z0-9]{2,4}$/i, ""));
    const name = `${base}.pdf`;
    const out = `${RNFS.CachesDirectoryPath}/export/${name}`;
    setIsExtracting(true);
    setTask({ title: "PREPARING THE PDF", sub: e.name });
    try {
      await RNFS.mkdir(`${RNFS.CachesDirectoryPath}/export`).catch(() => {});
      await RNFS.unlink(out).catch(() => {});
      const doc = e.scanId ? await loadScan(e.scanId) : null;
      if (doc && doc.pages.length) {
        // the pages themselves; searchable when every page already has its OCR
        const searchable = doc.pages.every((pg) => !needsOcr(pg));
        await scanNative.makePdf({
          out,
          mode: searchable ? "searchable" : "image",
          title: doc.name,
          pages: doc.pages.map((pg) => ({ path: pg.rendered, imgW: pg.w, imgH: pg.h, lines: searchable ? pg.ocr?.lines ?? [] : [] })),
        });
      } else if (e.textPath) {
        const text = stripMarkers(await RNFS.readFile(e.textPath, "utf8"));
        await scanNative.makePdf({ out, mode: "text", title: e.name, text });
      } else {
        throw new Error("Nothing to move yet.");
      }
    } catch (err: any) {
      setTask(null);
      setIsExtracting(false);
      Alert.alert("Move to cloud", String(err?.message ?? err));
      return;
    }
    setTask(null);
    setIsExtracting(false);
    setCloudOpen({
      file: { path: out, name, mime: "application/pdf" },
      onUploaded: () => {
        if (fileIdRef.current === e.id) {
          hardStop();
          setSegments([]);
          segmentsRef.current = [];
          setChapters([]);
          setPicked(null);
          setFileId(null);
          fileIdRef.current = null;
        }
        removeFromLibrary(e);
        RNFS.unlink(out).catch(() => {});
      },
    });
  };

  const pickSpeechModel = async (current: WhisperModelKey, title: string, message: string) => {
    const keys = Object.keys(WHISPER_MODELS) as WhisperModelKey[];
    const have = await Promise.all(keys.map((k) => hasModel(k)));
    const m = await askChoice(
      title,
      message,
      "📦",
      keys.map((k, i) => ({
        key: k,
        icon: k === "tiny" ? "⚡" : k === "base" ? "⚖️" : "🎯",
        label: `${WHISPER_MODELS[k].label}${have[i] ? " · downloaded" : ""}`,
        sub: WHISPER_MODELS[k].note,
        color: k === current ? YELLOW : MINT,
      }))
    );
    return m as WhisperModelKey | null;
  };

  const ensureSpeechModel = async (): Promise<WhisperModelKey | null> => {
    let model = await getModelKey();
    if (await hasModel(model)) return model;
    const m = await pickSpeechModel(
      model,
      "SPEECH MODEL",
      "Transcription runs on the phone with a whisper.cpp model. It is downloaded once (Wi‑Fi recommended); after that recordings never leave the device."
    );
    if (!m) return null;
    model = m;
    await setModelKey(model);
    if (await hasModel(model)) return model;
    setIsExtracting(true);
    setTask({ title: "DOWNLOADING THE MODEL", sub: WHISPER_MODELS[model].note, progress: 0, cancel: cancelModelDownload });
    try {
      await downloadModel(model, (f) =>
        setTask({ title: "DOWNLOADING THE MODEL", sub: WHISPER_MODELS[model].note, progress: f, cancel: cancelModelDownload })
      );
      return model;
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (msg !== "Cancelled") Alert.alert("Speech model", msg);
      return null;
    } finally {
      setTask(null);
    }
  };

  const refreshSpeechModelLabel = async () => {
    const k = await getModelKey();
    setSpeechModelLabel(`${WHISPER_MODELS[k].label}${(await hasModel(k)) ? "" : " · not downloaded"}`);
  };

  const chooseSpeechModel = async () => {
    setSettingsOpen(false);
    const cur = await getModelKey();
    const m = await pickSpeechModel(cur, "SPEECH MODEL", "Used to turn recordings into text on the phone. Bigger models are more accurate but slower.");
    if (!m) return;
    await setModelKey(m);
    if (!(await hasModel(m))) {
      const ok = await askChoice("DOWNLOAD NOW?", `${WHISPER_MODELS[m].note}. Wi‑Fi recommended.`, "📦", [
        { key: "yes", icon: "⬇️", label: "Download", color: MINT },
      ]);
      if (ok === "yes") {
        setIsExtracting(true);
        setTask({ title: "DOWNLOADING THE MODEL", sub: WHISPER_MODELS[m].note, progress: 0, cancel: cancelModelDownload });
        try {
          await downloadModel(m, (f) =>
            setTask({ title: "DOWNLOADING THE MODEL", sub: WHISPER_MODELS[m].note, progress: f, cancel: cancelModelDownload })
          );
          // free the space of the other models
          for (const k of Object.keys(WHISPER_MODELS) as WhisperModelKey[]) if (k !== m) await deleteModel(k);
        } catch (e: any) {
          const msg = String(e?.message ?? e);
          if (msg !== "Cancelled") Alert.alert("Speech model", msg);
        } finally {
          setTask(null);
          setIsExtracting(false);
        }
      }
    }
    refreshSpeechModelLabel();
  };

  const handleAudio = async (fid: string, name: string, localPath: string, autoStart: boolean) => {
    setIsExtracting(false);
    const k = await askChoice(
      "A RECORDING",
      `${name}\n\nLeggiMi can turn speech into text right on the phone: nothing is uploaded.`,
      "🎙️",
      [{ key: "go", icon: "📝", label: "Transcribe to text", sub: "Then read it aloud, keep it in the Library, save it as TXT or PDF", color: MINT }]
    );
    if (k !== "go") { setPicked(null); return; }
    const model = await ensureSpeechModel();
    if (!model) { setIsExtracting(false); setPicked(null); return; }
    setIsExtracting(true);
    try {
      const tr = await transcribeAudio(localPath, model, (stage, p) => {
        if (stage === "decoding") setTask({ title: "LISTENING…", sub: "Decoding the audio" });
        else if (stage === "loading") setTask({ title: "LISTENING…", sub: "Loading the speech model" });
        else setTask({ title: "LISTENING…", sub: "Writing down what is said", progress: p ?? 0 });
      });
      setTask(null);
      if (!tr.text.trim()) {
        setIsExtracting(false);
        setPicked(null);
        Alert.alert("Transcription", "No speech was recognised in this recording.");
        return;
      }
      const startIdx = await applyTextForCurrentFile(fid, tr.text, {});
      setIsExtracting(false);
      const next = await askChoice(
        "TRANSCRIPT READY",
        `${fmtDuration(tr.durationMs)} of audio${tr.language ? ` · language: ${tr.language}` : ""}. It is already saved in your Library.`,
        "✅",
        [
          { key: "read", icon: "🔊", label: "Read it aloud", color: MINT },
          { key: "txt", icon: "📄", label: "Save as text file", sub: "Download/LeggiMi, then cloud or share if you like", color: YELLOW },
          { key: "pdf", icon: "📕", label: "Save as PDF", sub: "Download/LeggiMi, then cloud or share if you like", color: CORAL },
        ]
      );
      if (next === "read" || (next === null && autoStart)) setTimeout(() => speakFrom(startIdx), 200);
      else if (next === "txt" || next === "pdf") await saveTextExport(name, tr.text, next);
    } catch (err: any) {
      setTask(null);
      setIsExtracting(false);
      setPicked(null);
      Alert.alert("Transcription", String(err?.message ?? err ?? "Transcription failed"));
    }
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

    const fromPrint = fromShare && (uri.includes("leggimi.fileprovider") || /^Print - /.test(name));
    const source: DocSource = fromPrint ? "print" : fromShare ? "share" : "picker";
    const kind = kindOf(name, mime, source);
    currentMetaRef.current = { name, kind, source, ocr: false };
    setPicked({ name, uri, type: mime ?? "", kind });
    const fid = makeFileId(name, mime ?? "");
    setFileId(fid);

    let localPath = "";
    const ext = extOf(name);
    console.log("[open]", name, mime || ext, fromShare ? "share" : "picker");

    try {
      if (fromShare) {
        localPath = await copySharedUriToCache(uri, name);
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
        pendingAutoStartRef.current = autoStart;
        setPdfBase64(b64);
        return; // isExtracting stays true until the WebView answers
      }

      if (IMAGE_EXTS.includes(ext) || (mime ?? "").startsWith("image/")) {
        await handleImages(fid, [localPath], autoStart);
        return;
      }

      if (isAudio(name, mime)) {
        await handleAudio(fid, name, localPath, autoStart);
        return;
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
    setPicked({ name: title, uri: "", type: "text/plain", kind: "text" });
    currentMetaRef.current = { name: title, kind: "text", source: "share", ocr: false };
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
        if (!files || files.length === 0) return;
        if (processingShareRef.current) return;
        processingShareRef.current = true;
        try {
          const uriOf = (x: any) =>
            x?.contentUri || (x?.filePath ? (x.filePath.startsWith("file://") ? x.filePath : `file://${x.filePath}`) : null);
          const nameOf = (x: any) => x?.fileName || x?.filePath?.split?.(/[\\/]/).pop?.() || "shared";
          const images = files.filter((x) => uriOf(x) && (String(x?.mimeType || "").startsWith("image/") || IMAGE_EXTS.includes(extOf(nameOf(x)))));
          if (files.length > 1 && images.length === files.length) {
            await openSharedImages(images.map((x) => ({ name: nameOf(x), uri: uriOf(x) as string })));
            return;
          }
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

    // A document printed to the "LeggiMi" printer while the app was not
    // visible: the print service leaves cache/print/pending.json because Android
    // forbids it to open the app from the background.
    const checkPendingPrint = async () => {
      const note = `${RNFS.CachesDirectoryPath}/print/pending.json`;
      try {
        if (!(await RNFS.exists(note))) return;
        const raw = await RNFS.readFile(note, "utf8");
        await RNFS.unlink(note).catch(() => {});
        const info = JSON.parse(raw);
        const path = String(info?.path || "");
        const name = String(info?.name || "Printed document.pdf");
        if (!path || !(await RNFS.exists(path))) return;
        if (processingShareRef.current) return;
        processingShareRef.current = true;
        try {
          await openFileFromUri(name, `file://${path}`, "application/pdf", true, true);
        } finally {
          processingShareRef.current = false;
        }
      } catch (e: any) {
        console.log("[print] pending note error", String(e?.message ?? e));
      }
    };

    const poll = (reason: string) => {
      if (cancelled) return;
      checkPendingPrint();
      if (!native?.getFileNames) {
        console.log("[share] native module missing");
        return;
      }
      native
        .getFileNames()
        .then((obj: any) => {
          const files = obj ? Object.keys(obj).map((k) => obj[k]) : [];
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
    // Android only: the activity regains focus after the share sheet closes,
    // even when the app never left the foreground (split screen, popups).
    const subFocus = (AppState as any).addEventListener?.("focus", () => poll("focus"));
    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
      sub.remove();
      subFocus?.remove?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const renderItem = useCallback(
    ({ item, index }: { item: string; index: number }) => (
      <SegmentRow
        text={item}
        index={index + listWin.base}
        active={index + listWin.base === currentIdx}
        fontSize={fontSize}
        palette={palette}
        onPress={onPressSegment}
      />
    ),
    [currentIdx, fontSize, palette, onPressSegment, listWin.base]
  );

  const busy = isExtracting;
  const hasDoc = segments.length > 0;

  const docKind: DocKind = picked?.kind ?? kindOf(picked?.name ?? "", picked?.type, "picker");
  const docKindColor = kindColor(docKind);

  // ---- scanner <-> library
  const scanLibraryId = (scanId: string) => `scan::${scanId}`;

  const onScanSaved = useCallback((d: ScanDoc) => {
    const id = scanLibraryId(d.id);
    const now = Date.now();
    const prev = libraryRef.current.find((e) => e.id === id);
    const pagesChanged = prev ? prev.pages !== d.pages.length : true;
    const base: LibraryEntry = prev ?? {
      id,
      name: d.name,
      kind: "scan",
      source: "scan",
      addedAt: now,
      lastOpenedAt: now,
      total: 0,
      index: 0,
      ocr: true,
      markdown: false,
      textPath: "",
    };
    const entry: LibraryEntry = {
      ...base,
      name: d.name,
      kind: "scan",
      source: "scan",
      ocr: true,
      scanId: d.id,
      pages: d.pages.length,
      lastOpenedAt: now,
      // pages were added or removed: the cached text is stale until the next Read
      textPath: prev && pagesChanged ? "" : base.textPath,
    };
    const next = [entry, ...libraryRef.current.filter((e) => e.id !== id)].slice(0, LIBRARY_MAX);
    libraryRef.current = next;
    setLibrary(next);
    persistLibrary(next).catch(() => {});
  }, []);

  const onScanDeleted = useCallback((scanId: string) => {
    const id = scanLibraryId(scanId);
    const next = libraryRef.current.filter((e) => e.id !== id);
    libraryRef.current = next;
    setLibrary(next);
    persistLibrary(next).catch(() => {});
    AsyncStorage.removeItem(`progress:${id}`).catch(() => {});
  }, []);

  const onScanRead = async (d: ScanDoc, text: string) => {
    setScanOpen(null);
    setIsExtracting(true);
    await hardStop();
    setSegments([]);
    segmentsRef.current = [];
    setChapters([]);
    setRawText("");
    const id = scanLibraryId(d.id);
    setPicked({ name: d.name, uri: "", type: "image/jpeg", kind: "scan", ocr: true });
    setFileId(id);
    fileIdRef.current = id;
    currentMetaRef.current = { name: d.name, kind: "scan", source: "scan", ocr: true, scanId: d.id, pages: d.pages.length };
    try {
      const start = await applyTextForCurrentFile(id, text, { extracted: true });
      setIsExtracting(false);
      setTimeout(() => speakFrom(start), 250);
    } catch (err: any) {
      setIsExtracting(false);
      Alert.alert("Scanner", String(err?.message ?? err ?? "Could not read the pages"));
    }
  };

  // Android 13+: the print service can only wave at you with a notification
  const askNotificationPermission = async () => {
    try {
      if (Platform.OS !== "android" || Platform.Version < 33) return;
      const perm = "android.permission.POST_NOTIFICATIONS" as any;
      const has = await PermissionsAndroid.check(perm);
      if (!has) await PermissionsAndroid.request(perm);
    } catch {}
  };

  // ask once at first start, so "print to LeggiMi" can notify right away
  useEffect(() => {
    (async () => {
      try {
        if (await AsyncStorage.getItem("settings:notifAsked")) return;
        await AsyncStorage.setItem("settings:notifAsked", "1");
        await askNotificationPermission();
      } catch {}
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openPrintSettings = async () => {
    await askNotificationPermission();
    try {
      await Linking.sendIntent("android.settings.ACTION_PRINT_SETTINGS");
    } catch {
      Alert.alert("Printing", "Open Android Settings › Connected devices › Printing and enable “LeggiMi (read aloud)”.");
    }
  };

  const sheetBottom = Math.max(12, insets.bottom + 8);

  return (
    <View style={[s.container, { paddingTop: insets.top }]}>
      <StatusBar barStyle={palette.statusBar} backgroundColor={palette.bg} />

      {/* HEADER */}
      <View style={s.header}>
        <PosterTitle text="LEGGIMI" palette={palette} size={hasDoc ? 25 : 28} style={{ flex: 1 }} />
        <ComicIconButton icon="📂" onPress={pickFile} disabled={busy} palette={palette} color={YELLOW} size={42} fontSize={18} style={s.headerBtn} />
        <ComicIconButton icon="📷" onPress={() => setScanOpen({ docId: null, start: "camera" })} disabled={busy} palette={palette} color={BUBBLEGUM} size={42} fontSize={18} style={s.headerBtn} />
        <ComicIconButton icon="🕘" onPress={() => setLibraryOpen(true)} disabled={busy} palette={palette} color={TANGERINE} size={42} fontSize={18} style={s.headerBtn} />
        {chapters.length > 1 && (
          <ComicIconButton icon="☰" onPress={() => setChaptersOpen(true)} palette={palette} color={SKY} size={42} fontSize={18} style={s.headerBtn} />
        )}
        <ComicIconButton icon="⚙️" onPress={() => setSettingsOpen(true)} palette={palette} color={MINT} size={42} fontSize={18} style={s.headerBtn} />
      </View>

      {/* DOCUMENT STICKER + PROGRESS */}
      {(hasDoc || busy) && picked && (
        <ComicBox palette={palette} color={docKindColor} radius={18} style={s.docCard} onPress={goToCurrent} contentStyle={s.docCardInner}>
          <View style={s.docRow}>
            <View style={s.docBadge}>
              <Text style={s.docBadgeText}>{kindLabel(docKind)}</Text>
            </View>
            {picked.ocr ? (
              <View style={[s.docBadge, { minWidth: 0, paddingHorizontal: 6 }]}>
                <Text style={s.docBadgeText}>OCR</Text>
              </View>
            ) : null}
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
                Open a PDF, Word, Markdown, TXT or RTF file, scan paper pages, or share a photo or a recording from any other app — and I will read it out loud.
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
              <ComicButton text="SCAN PAGES" icon="📷" onPress={() => setScanOpen({ docId: null, start: "camera" })} palette={palette} color={BUBBLEGUM} style={{ marginTop: 12 }} />
              {library.length > 0 ? (
                <ComicButton text={`LIBRARY · ${library.length}`} icon="🕘" onPress={() => setLibraryOpen(true)} palette={palette} color={TANGERINE} compact style={{ marginTop: 12 }} />
              ) : null}
            </ComicBox>

            <ComicBox palette={palette} color={SKY} radius={20} style={{ marginTop: 26 }} contentStyle={s.tipCard}>
              <Text style={s.tipEmoji}>💡</Text>
              <Text style={s.tipText}>
                In any app tap <Text style={{ fontFamily: FONT_BOLD }}>Share</Text> and pick LeggiMi: I start reading right away. Selected text works too.
              </Text>
            </ComicBox>

            <ComicBox palette={palette} color={GRAPE} radius={20} style={{ marginTop: 16 }} contentStyle={s.tipCardCol}>
              <View style={s.tipCard}>
                <Text style={s.tipEmoji}>🖨️</Text>
                <Text style={s.tipText}>
                  No Share button? <Text style={{ fontFamily: FONT_BOLD }}>Print</Text> instead and choose the printer{" "}
                  <Text style={{ fontFamily: FONT_BOLD }}>“LeggiMi (read aloud)”</Text>. Enable it once in Android's print settings.
                </Text>
              </View>
              <ComicButton text="PRINT SETTINGS" onPress={openPrintSettings} palette={palette} color={palette.surface} compact style={{ alignSelf: "flex-start", marginTop: 8, marginLeft: 38 }} />
            </ComicBox>

            <ComicBox palette={palette} color={AQUA} radius={20} style={{ marginTop: 16 }} contentStyle={s.tipCard}>
              <Text style={s.tipEmoji}>🎙️</Text>
              <Text style={s.tipText}>
                Recordings too: share a voice note or any audio file and LeggiMi writes it down <Text style={{ fontFamily: FONT_BOLD }}>on the phone</Text>, then reads it or saves it as TXT / PDF.
              </Text>
            </ComicBox>

            <ComicBox palette={palette} color={BUBBLEGUM} radius={20} style={{ marginTop: 16 }} contentStyle={s.tipCard}>
              <Text style={s.tipEmoji}>🔍</Text>
              <Text style={s.tipText}>
                Photos, screenshots and scanned PDFs are read too: LeggiMi offers on‑device <Text style={{ fontFamily: FONT_BOLD }}>OCR</Text> when there is no text layer.
              </Text>
            </ComicBox>
          </ScrollView>
        ) : (
          <ComicBox palette={palette} radius={22} shadow={5} style={s.readerCard} contentStyle={{ flex: 1 }}>
            <FlatList
              key={`list-${listWin.key}`}
              ref={listRef}
              data={listData}
              keyExtractor={(_, i) => String(i + listWin.base)}
              renderItem={renderItem}
              extraData={`${currentIdx}|${fontSize}|${themeName}`}
              initialNumToRender={20}
              maxToRenderPerBatch={20}
              windowSize={21}
              contentContainerStyle={s.listContent}
              showsVerticalScrollIndicator
              onStartReached={onListStartReached}
              onStartReachedThreshold={1.5}
              // rows prepended above (scrolling up) must not push the text down
              maintainVisibleContentPosition={listWin.base > 0 ? { minIndexForVisible: 0 } : undefined}
              onScrollToIndexFailed={(info) => {
                // the target is not drawn yet: land on an estimate at once
                listRef.current?.scrollToOffset({
                  offset: Math.max(0, info.averageItemLength * info.index),
                  animated: false,
                });
              }}
            />
          </ComicBox>
        )}

        {busy && (
          <View style={s.loadingOverlay}>
            <ComicBox palette={palette} color={YELLOW} radius={22} shadow={6} contentStyle={s.loadingCard}>
              <ActivityIndicator size="large" color={INK} />
              <PosterTitle
                text={task ? task.title : ocrState ? "READING THE PIXELS…" : "ONE MOMENT…"}
                palette={palette}
                size={22}
                color={INK}
                style={{ marginTop: 12 }}
              />
              <Text style={s.loadingText}>
                {task
                  ? task.sub ?? ""
                  : ocrState
                  ? ocrState.total > 1 ? `OCR · page ${ocrState.page} of ${ocrState.total}` : "OCR · recognising text"
                  : "Extracting the text"}
              </Text>
              {task && task.progress !== undefined ? (
                <View style={[s.taskTrack, { borderColor: INK }]}>
                  <View style={[s.taskFill, { width: `${Math.max(3, Math.round(task.progress * 100))}%` }]} />
                </View>
              ) : null}
              {task && task.progress !== undefined ? <Text style={s.loadingSub}>{Math.round(task.progress * 100)}%</Text> : null}
              {task?.cancel ? (
                <ComicButton text="CANCEL" onPress={task.cancel} palette={palette} color={CORAL} compact style={{ marginTop: 12 }} />
              ) : null}
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
                <Text style={s.sheetEmoji}>⚙️</Text>
                <PosterTitle text="SETTINGS" palette={palette} size={26} />
              </View>

              <Text style={s.sheetLabel}>Cloud drives</Text>
              <ComicBox
                palette={palette}
                color={GRAPE}
                radius={16}
                shadow={4}
                onPress={() => { setSettingsOpen(false); setCloudOpen({ file: null }); }}
                contentStyle={s.rowSelect}
              >
                <Text style={s.rowSelectEmoji}>☁️</Text>
                <View style={{ flex: 1, paddingRight: 10 }}>
                  <Text style={[s.rowSelectText, { color: INK }]} numberOfLines={1}>Cloud accounts</Text>
                  <Text style={[s.libMeta, { color: INK }]} numberOfLines={1}>Google Drive</Text>
                </View>
                <Text style={[s.rowSelectChevron, { color: INK }]}>›</Text>
              </ComicBox>

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

              <Text style={s.sheetLabel}>Speech to text</Text>
              <ComicBox palette={palette} radius={16} shadow={4} onPress={chooseSpeechModel} contentStyle={s.rowSelect}>
                <Text style={s.rowSelectEmoji}>🎙️</Text>
                <Text style={s.rowSelectText} numberOfLines={1}>{speechModelLabel || "Speech model"}</Text>
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

      {/* SHEET LIBRARY (history) */}
      <Modal visible={libraryOpen} transparent animationType="slide" onRequestClose={() => setLibraryOpen(false)}>
        <Pressable style={s.backdrop} onPress={() => setLibraryOpen(false)} />
        <View style={[s.sheetWrap, { bottom: sheetBottom, maxHeight: "86%" }]}>
          <ComicBox palette={palette} radius={26} shadow={6} contentStyle={s.sheet}>
            <View style={s.sheetHead}>
              <Text style={s.sheetEmoji}>🕘</Text>
              <PosterTitle text="LIBRARY" palette={palette} size={26} style={{ flex: 1 }} />
              <ComicIconButton
                icon="☁️"
                onPress={() => { setLibraryOpen(false); setCloudOpen({ file: null }); }}
                palette={palette}
                color={GRAPE}
                size={36}
                fontSize={16}
                style={{ marginRight: 10 }}
              />
              {library.length > 0 ? (
                <ComicButton text="CLEAN" icon="🧹" onPress={clearLibrary} palette={palette} color={palette.surface2} compact />
              ) : null}
            </View>
            {library.length === 0 ? (
              <Text style={s.voiceHint}>Everything you open, share or print to LeggiMi ends up here, with the point you reached. Nothing yet.</Text>
            ) : (
              <Text style={s.voiceHint}>Tap a document to pick up where you left off. 📤 saves or sends it, ☁️ moves it to your cloud.</Text>
            )}
            <ScrollView style={{ marginTop: 10, flexGrow: 0 }} showsVerticalScrollIndicator={false}>
              {library.map((e) => {
                const pctE = e.total ? Math.round(((e.index + 1) / e.total) * 100) : 0;
                const done = e.total > 0 && e.index >= e.total - 1;
                return (
                  <ComicBox key={e.id} palette={palette} radius={16} stroke={2} shadow={3} onPress={() => openFromLibrary(e)} style={s.listItem} contentStyle={s.libRow}>
                    <View style={[s.libIcon, { backgroundColor: kindColor(e.kind), borderColor: palette.ink }]}>
                      <Text style={{ fontSize: 20 }}>{kindEmoji(e.kind)}</Text>
                    </View>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text numberOfLines={1} style={s.libName}>{e.name}</Text>
                      <Text numberOfLines={1} style={s.libMeta}>
                        {kindLabel(e.kind)}
                        {e.scanId && e.pages ? ` · ${e.pages} page${e.pages === 1 ? "" : "s"}` : ""}
                        {e.ocr && !e.scanId ? " · OCR" : ""} · {fmtDate(e.lastOpenedAt)} ·{" "}
                        {e.scanId && !e.textPath ? "not read yet" : done ? "finished" : `block ${e.index + 1}/${e.total}`}
                      </Text>
                      <View style={[s.libTrack, { borderColor: palette.ink, backgroundColor: palette.surface }]}>
                        <View style={[s.libFill, { width: `${Math.max(pctE, 2)}%`, backgroundColor: done ? MINT : YELLOW }]} />
                      </View>
                    </View>
                    <View style={s.libRight}>
                      <ComicIconButton
                        icon="📤"
                        onPress={() => exportFromLibrary(e)}
                        palette={palette}
                        color={YELLOW}
                        size={30}
                        fontSize={13}
                      />
                      <ComicIconButton
                        icon="☁️"
                        onPress={() => moveToCloud(e)}
                        palette={palette}
                        color={GRAPE}
                        size={30}
                        fontSize={13}
                      />
                      {e.scanId ? (
                        <ComicIconButton
                          icon="✎"
                          onPress={() => { setLibraryOpen(false); setScanOpen({ docId: e.scanId!, start: null }); }}
                          palette={palette}
                          color={SKY}
                          size={30}
                          fontSize={14}
                        />
                      ) : (
                        <Text style={s.libPct}>{pctE}%</Text>
                      )}
                      <ComicIconButton
                        icon="✕"
                        onPress={() =>
                          e.scanId
                            ? Alert.alert("Delete scan", `Delete “${e.name}” and its pages?`, [
                                { text: "Cancel", style: "cancel" },
                                { text: "Delete", style: "destructive", onPress: () => removeFromLibrary(e) },
                              ])
                            : removeFromLibrary(e)
                        }
                        palette={palette}
                        color={palette.surface2}
                        size={30}
                        fontSize={13}
                      />
                    </View>
                  </ComicBox>
                );
              })}
            </ScrollView>
            <ComicButton text="CLOSE" onPress={() => setLibraryOpen(false)} palette={palette} color={CORAL} style={{ marginTop: 14 }} />
          </ComicBox>
        </View>
      </Modal>

      {/* CHOICE SHEET */}
      <Modal visible={!!choice} transparent animationType="slide" onRequestClose={() => answerChoice(null)}>
        <Pressable style={s.backdrop} onPress={() => answerChoice(null)} />
        {choice ? (
          <View style={[s.sheetWrap, { bottom: sheetBottom, maxHeight: "86%" }]}>
            <ComicBox palette={palette} radius={26} shadow={6} contentStyle={s.sheet}>
              <View style={s.sheetHead}>
                {choice.emoji ? <Text style={s.sheetEmoji}>{choice.emoji}</Text> : null}
                <PosterTitle text={choice.title} palette={palette} size={24} style={{ flex: 1 }} />
              </View>
              {choice.message ? <Text style={[s.voiceHint, { marginBottom: 6 }]}>{choice.message}</Text> : null}
              <ScrollView style={{ marginTop: 8, flexGrow: 0 }} showsVerticalScrollIndicator={false}>
                {choice.options.map((o) => (
                  <ComicBox
                    key={o.key}
                    palette={palette}
                    radius={16}
                    stroke={3}
                    shadow={4}
                    onPress={() => answerChoice(o.key)}
                    style={s.listItem}
                    contentStyle={s.libRow}
                  >
                    <View style={[s.libIcon, { backgroundColor: o.color, borderColor: palette.ink }]}>
                      <Text style={{ fontSize: 20 }}>{o.icon}</Text>
                    </View>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={s.libName}>{o.label}</Text>
                      {o.sub ? <Text style={s.libMeta}>{o.sub}</Text> : null}
                    </View>
                  </ComicBox>
                ))}
              </ScrollView>
              <ComicButton text="CANCEL" onPress={() => answerChoice(null)} palette={palette} color={palette.surface2} style={{ marginTop: 10 }} />
            </ComicBox>
          </View>
        ) : null}
      </Modal>

      {/* SCANNER (CamScanner-like) */}
      {scanOpen ? (
        <ScanStudio
          visible
          docId={scanOpen.docId}
          start={scanOpen.start}
          images={scanOpen.images}
          imagesMode={scanOpen.imagesMode}
          palette={palette}
          insetTop={insets.top}
          insetBottom={insets.bottom}
          onClose={() => setScanOpen(null)}
          onSaved={onScanSaved}
          onDeleted={onScanDeleted}
          onRead={onScanRead}
          onCloudExport={(f) => setCloudOpen({ file: f })}
        />
      ) : null}

      {/* CLOUD ACCOUNTS / UPLOAD */}
      <CloudSheet
        visible={!!cloudOpen}
        palette={palette}
        bottomInset={insets.bottom}
        file={cloudOpen?.file ?? null}
        onUploaded={cloudOpen?.onUploaded}
        onClose={() => setCloudOpen(null)}
      />

      {/* PDF extractor offline (hidden). Also renders pages for OCR on request. */}
      {pdfBase64 && (
        <WebView
          ref={webRef}
          source={{ html: pdfJsHtmlOffline(pdfBase64), baseUrl: "file:///android_asset/" }}
          javaScriptEnabled
          originWhitelist={["*"]}
          allowFileAccess
          allowFileAccessFromFileURLs
          allowUniversalAccessFromFileURLs
          mixedContentMode="always"
          onMessage={async (e) => {
            let msg: any;
            try { msg = JSON.parse(e.nativeEvent.data); } catch { return; }

            const cleanup = () => {
              setIsExtracting(false);
              setPdfBase64(null);
              setOcrState(null);
              ocrRef.current = null;
              pendingAutoStartRef.current = false;
            };
            const finishOk = (start: number) => {
              setIsExtracting(false);
              setPdfBase64(null);
              setOcrState(null);
              ocrRef.current = null;
              if (pendingAutoStartRef.current) {
                pendingAutoStartRef.current = false;
                setTimeout(() => speakFrom(start), 250);
              }
            };

            // ---- one OCR page rendered by pdf.js
            if (msg.type === "page" || msg.type === "pageError") {
              const job = ocrRef.current;
              if (!job) return;
              const n = Number(msg.page) || 1;
              if (msg.type === "page") {
                const tmp = `${RNFS.CachesDirectoryPath}/ocr_${hashStr(job.fid)}_${n}.jpg`;
                try {
                  await RNFS.writeFile(tmp, String(msg.jpeg || ""), "base64");
                  job.texts[n - 1] = await ocrImageFile(tmp);
                } catch (err: any) {
                  console.log("[ocr] page", n, String(err?.message ?? err));
                  job.texts[n - 1] = "";
                } finally {
                  RNFS.unlink(tmp).catch(() => {});
                }
              } else {
                job.texts[n - 1] = "";
              }
              if (n < job.total) {
                setOcrState({ page: n + 1, total: job.total });
                webRef.current?.injectJavaScript(`window.__renderPage(${n + 1}); true;`);
                return;
              }
              const text = job.texts.join("\n\n").trim();
              if (!text) {
                Alert.alert("OCR", "No readable text was found in this PDF.");
                setPicked(null);
                cleanup();
                return;
              }
              try {
                if (currentMetaRef.current) currentMetaRef.current.ocr = true;
                setPicked((p) => (p ? { ...p, ocr: true } : p));
                const start = await applyTextForCurrentFile(job.fid, text, { extracted: true });
                finishOk(start);
              } catch (err: any) {
                Alert.alert("OCR", String(err?.message ?? err ?? "Could not read the recognised text"));
                cleanup();
              }
              return;
            }

            // ---- text layer result
            try {
              if (!msg.ok) throw new Error(msg.error || "Could not extract text from the PDF");
              const fid = fileIdRef.current;
              if (!fid) throw new Error("missing fileId");
              const t = String(msg.text || "").trim();
              const pages = Math.max(1, Number(msg.pages) || 1);
              const scanned = t.replace(/\s+/g, "").length < 40 * pages;
              if (scanned) {
                const ok = await confirmAsync(
                  "Scanned PDF",
                  `This PDF has ${t ? "almost " : ""}no text: it is made of images. Recognise the text on the phone (OCR) on ${pages} page${pages > 1 ? "s" : ""}?`,
                  "Run OCR"
                );
                if (!ok) { setPicked(null); cleanup(); return; }
                if (!ocrAvailable()) {
                  Alert.alert("OCR", "This build has no OCR module. Install the latest LeggiMi build to read scanned PDFs.");
                  setPicked(null);
                  cleanup();
                  return;
                }
                ocrRef.current = { fid, texts: new Array(pages).fill(""), total: pages };
                setOcrState({ page: 1, total: pages });
                webRef.current?.injectJavaScript("window.__renderPage(1); true;");
                return; // keep the WebView alive for the page renders
              }
              const start = await applyTextForCurrentFile(fid, t, { extracted: true });
              finishOk(start);
            } catch (err: any) {
              Alert.alert("PDF", String(err?.message ?? "Could not parse the PDF"));
              cleanup();
            }
          }}
          onError={(e) => {
            console.log("[pdf] webview error", JSON.stringify(e?.nativeEvent ?? {}));
            Alert.alert("PDF", "The PDF reader failed while extracting text");
            setIsExtracting(false);
            setPdfBase64(null);
            setOcrState(null);
            ocrRef.current = null;
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
    tipCardCol: { paddingBottom: 12 },

    libRow: { flexDirection: "row", alignItems: "center", paddingVertical: 10, paddingHorizontal: 12, gap: 10 },
    libIcon: { width: 44, height: 44, borderRadius: 14, borderWidth: 3, alignItems: "center", justifyContent: "center" },
    libName: { color: p.text, fontSize: 15, fontFamily: FONT_BOLD },
    libMeta: { color: p.dim, fontSize: 12, fontFamily: FONT_BODY, marginTop: 1 },
    libTrack: { marginTop: 6, height: 8, borderRadius: 5, borderWidth: 2, overflow: "hidden" },
    libFill: { height: "100%" },
    libRight: { width: 76, flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", alignItems: "center", gap: 8, marginLeft: 2 },
    libPct: { color: p.text, fontFamily: FONT_POSTER, fontSize: 14, includeFontPadding: false, width: 34, textAlign: "center" },
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
    taskTrack: { alignSelf: "stretch", height: 14, borderRadius: 8, borderWidth: 3, backgroundColor: PAPER, overflow: "hidden", marginTop: 12 },
    taskFill: { height: "100%", backgroundColor: MINT },
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
