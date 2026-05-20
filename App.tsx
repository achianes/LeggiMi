import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Platform,
  Alert,
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

const SETTINGS_RATE_KEY = "settings:ttsRate";

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
  // path reale in cache
  const safeName = (fileName || "shared").replace(/[^\w.\-() ]+/g, "_");
  const destPath = `${RNFS.CachesDirectoryPath}/${Date.now()}_${safeName}`;

  // RNFS su Android copia anche da content://
  // Se sharedUri è file://, va bene lo stesso.
  await RNFS.copyFile(sharedUri, destPath);
  return destPath; // path locale "vero"
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

function segmentTextForKaraoke(raw: string, maxChars = 700) {
  const t = normalizeText(raw);
  if (!t) return [];

  let blocks = t.split(/\n\s*\n+/g).map((x) => x.trim()).filter(Boolean);
  if (blocks.length <= 1) {
    const lines = t.split("\n").map((x) => x.trim()).filter(Boolean);
    if (lines.length >= 8) blocks = lines;
  }

  const segments: string[] = [];
  const sentenceSplit = /(?<=[\.\!\?\:;])\s+/g;

  for (const b0 of blocks) {
    const b = b0.trim();
    if (!b) continue;

    if (b.length <= maxChars) { segments.push(b); continue; }

    const sentences = b.split(sentenceSplit).map((s) => s.trim()).filter(Boolean);
    let acc = "";
    for (const s of sentences) {
      if (!acc) { acc = s; continue; }
      if ((acc + " " + s).length <= maxChars) acc += " " + s;
      else { segments.push(acc); acc = s; }
    }
    if (acc) segments.push(acc);
  }

  const final: string[] = [];
  for (const seg of segments) {
    if (seg.length <= maxChars * 1.3) final.push(seg);
    else for (let i = 0; i < seg.length; i += maxChars) final.push(seg.slice(i, i + maxChars));
  }
  return final.filter(Boolean);
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
function buildChapters(segs: string[]): Chapter[] {
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

  const N = 10;
  if (segs.length <= N) return [{ title: "Testo", startIndex: 0, endIndex: Math.max(0, segs.length - 1) }];

  const chapters: Chapter[] = [];
  for (let i = 0, part = 1; i < segs.length; i += N, part++) {
    chapters.push({ title: `Parte ${part}`, startIndex: i, endIndex: Math.min(segs.length - 1, i + N - 1) });
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
 * PDF extraction offline: pdf.js letto da assets (android/app/src/main/assets/pdfjs/pdf.min.js)
 * Worker disabilitato per semplicità/offline (più lento ma affidabile).
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
    // ✅ IMPORT ASSOLUTO (FONDAMENTALE)
    const pdfjsLib = await import("file:///android_asset/pdfjs/pdf.min.mjs");

    // ✅ worker esplicito (anche se disableWorker)
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
      disableWorker: true, // offline + stabile
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

function AppInner() {
  const insets = useSafeAreaInsets();

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


  const stopRef = useRef(false);
  const [ttsReady, setTtsReady] = useState(false);
  const ttsErrorShownRef = useRef(false);
  const sessionRef = useRef(0);

  const scrollRef = useRef<ScrollView | null>(null);
  const containerRef = useRef<View | null>(null);
  const segmentRefs = useRef<Record<number, Text | null>>({});

  const canRead = useMemo(
    () => segments.length > 0 && segments[currentIdx]?.trim().length > 0,
    [segments, currentIdx]
  );


  useEffect(() => {
    if (!segments.length) return;
    const node = segmentRefs.current[currentIdx];
    const containerNode = containerRef.current;
    if (!node || !containerNode || !scrollRef.current) return;

    try {
      // @ts-ignore
      node.measureLayout(
        // @ts-ignore
        containerNode,
        (_x: number, y: number) => {
          scrollRef.current?.scrollTo({ y: Math.max(0, y - 20), animated: true });
        },
        () => {}
      );
    } catch {}
  }, [currentIdx, segments.length]);

  // load settings
  useEffect(() => {
    (async () => {
      try {
        const savedRate = await AsyncStorage.getItem(SETTINGS_RATE_KEY);
        if (savedRate) {
          const v = Number(savedRate);
          if (!Number.isNaN(v)) setRate(v);
        }
      } catch {}
    })();
  }, []);

  // init TTS
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
      Tts.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // apply + save rate
  useEffect(() => {
    AsyncStorage.setItem(SETTINGS_RATE_KEY, String(rate)).catch(() => {});
    if (!ttsReady) return;
    Tts.setDefaultRate(rate, true).catch(() => {});
  }, [rate, ttsReady]);

  // ====== CORE CONTROLS ======
  const hardStop = async () => {
    stopRef.current = true;
    sessionRef.current += 1;
    setIsPaused(false);
    await Tts.stop();
    setIsReading(false);
  };

  const pause = async () => {
    if (!isReading) return;
    stopRef.current = true;
    sessionRef.current += 1;
    await Tts.stop();
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
      try {
        await Tts.speak(b);
        return true;
      } catch {
        return false;
      }
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

    try { await Tts.getInitStatus(); } catch {}
    try { await Tts.setDefaultRate(rate, true); } catch {}
    try { await Tts.setDefaultLanguage("it-IT"); } catch {}
    await Tts.stop();

    setIsReading(true);
    setIsPaused(false);

    let i = Math.max(0, Math.min(startIndex, segs.length - 1));
    setCurrentIdx(i);
    if (fileId) await saveProgress(fileId, i);

    for (; i < segs.length; i++) {
      if (sessionRef.current !== sessionToken) break;
      if (stopRef.current) break;

      setCurrentIdx(i);
      if (fileId) await saveProgress(fileId, i);

      const ok = await speakOne(segs[i]);
      if (!ok && !ttsErrorShownRef.current) {
        ttsErrorShownRef.current = true;
        Alert.alert("Sintesi vocale", "Alcune parti non sono leggibili dal TTS. Riduci la velocità o cambia voce TTS.");
      }

      await waitTtsDone(sessionToken, 60000);
    }

    if (sessionRef.current === sessionToken) setIsReading(false);
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
    if (isReading || isPaused) {
      hardStop().then(() => speakFrom(next));
    }
  };

  const skipToChapter = (ch: Chapter) => {
    const next = ch.startIndex;
    setCurrentIdx(next);
    if (fileId) saveProgress(fileId, next).catch(() => {});
    if (isReading || isPaused) {
      hardStop().then(() => speakFrom(next));
    }
  };

  // ====== APPLY TEXT ======
  const applyTextForCurrentFile = async (fid: string, text: string) => {
    const cleaned = postCleanExtractedText(text);
    setRawText(cleaned);

    const segs = segmentTextForKaraoke(cleaned, 700);
    segmentsRef.current = segs;
    setSegments(segs);

    const ch = buildChapters(segs);
    setChapters(ch);

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

  setPicked({ name, uri, type: mime ?? "" });

  const fid = makeFileId(name, mime ?? "");
  setFileId(fid);

  let localPath = "";
  const ext = extOf(name);

  try {
    if (fromShare) {
      // ✅ SHARE: non usare keepLocalCopy (permessi transitori)
      // uri può essere content:// oppure file://
      localPath = await copySharedUriToCache(uri, name);
    } else {
      // ✅ PICKER: keepLocalCopy è ok
      const copied = await keepLocalCopy({
        destination: "cachesDirectory",
        files: [{ uri, fileName: name }],
      });

      const localUri = copied[0]?.status === "success" ? copied[0].localUri : null;
      if (!localUri) throw new Error("Impossibile creare una copia locale del file (picker).");

      localPath = localUri.replace("file://", "");
    }

    // TXT / text/*
    if (isTextLikeExt(ext) || (mime ?? "").startsWith("text/")) {
      const raw = await RNFS.readFile(localPath, "utf8");
      const finalText = ext === "rtf" ? stripRtf(raw) : raw;
      const start = await applyTextForCurrentFile(fid, finalText);
      setIsExtracting(false);
      if (autoStart) setTimeout(() => speakFrom(start), 200);
      return;
    }

    // RTF (alcuni device lo danno con mime non text/*)
    if (ext === "rtf" || (mime ?? "").includes("rtf")) {
      const raw = await RNFS.readFile(localPath, "utf8");
      const start = await applyTextForCurrentFile(fid, stripRtf(raw));
      setIsExtracting(false);
      if (autoStart) setTimeout(() => speakFrom(start), 200);
      return;
    }

    // DOCX
    if (ext === "docx" || (mime ?? "").includes("wordprocessingml")) {
      const docText = await extractDocxText(localPath);
      const start = await applyTextForCurrentFile(fid, docText);
      setIsExtracting(false);
      if (autoStart) setTimeout(() => speakFrom(start), 200);
      return;
    }

    // PDF
    if (ext === "pdf" || mime === "application/pdf") {
      const b64 = await RNFS.readFile(localPath, "base64");
      pendingAutoStartRef.current = autoStart;
      setPdfBase64(b64);
      // lascia isExtracting = true finché la WebView risponde
      return;
    }

    // Fallback: prova come testo
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

  // SHARE INTENT
  useEffect(() => {
    ReceiveSharingIntent.getReceivedFiles(
      async (files: any[]) => {
        try {
          if (!files || files.length === 0) return;
          const f = files[0];
          const name = f?.fileName || f?.filePath?.split?.(/[\\/]/).pop?.() || "condiviso";
          const mime = f?.mimeType || "";
          const uri =
            f?.contentUri ||
            (f?.filePath ? (f.filePath.startsWith("file://") ? f.filePath : `file://${f.filePath}`) : null);
          if (!uri) return;

          try { ReceiveSharingIntent.clearReceivedFiles(); } catch {}
          await openFileFromUri(name, uri, mime, true, true);
        } catch (e: any) {
          Alert.alert("Condivisione", String(e?.message ?? e ?? "Errore"));
          setIsExtracting(false);
        }
      },
      () => {},
      "ShareMedia"
    );

    return () => {
      try { ReceiveSharingIntent.clearReceivedFiles(); } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* NIENTE HEADER: spazio massimo */}

      {/* Capitoli/Parti */}
      {chapters.length > 0 && segments.length > 0 && (
        <View style={styles.chapterPanel}>
          <ScrollView style={styles.chapterList}>
            {chapters.map((ch, idx) => (
              <TouchableOpacity key={idx} onPress={() => skipToChapter(ch)} style={styles.chapterRow}>
                <Text style={styles.chapterText}>
                  {ch.title} ({ch.startIndex + 1}–{ch.endIndex + 1})
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      )}

      {/* Karaoke */}
      <View ref={containerRef as any} style={styles.textBox}>
        <ScrollView ref={scrollRef as any} showsVerticalScrollIndicator>
          {segments.length === 0 ? (
            <Text style={styles.text}>{rawText || "Condividi un file su LeggiMi oppure scegli un file."}</Text>
          ) : (
            segments.map((seg, i) => (
              <Text
                key={i}
                ref={(r) => { segmentRefs.current[i] = r; }}
                style={[styles.text, i === currentIdx ? styles.karaoke : styles.normalSeg]}
              >
                {seg + "\n\n"}
              </Text>
            ))
          )}
        </ScrollView>
      </View>

      {/* Velocità */}
      <View style={styles.rateBox}>
        <Text style={styles.rateLabel}>Velocità: {rate.toFixed(2)}x</Text>
        <Slider minimumValue={0.5} maximumValue={2.0} step={0.05} value={rate} onValueChange={setRate} />
      </View>

      {/* Toolbar */}
      <View style={[styles.toolbar, { paddingBottom: Math.max(10, insets.bottom) }]}>
        <TouchableOpacity style={styles.tbBtn} onPress={pickFile} disabled={isExtracting}>
          <Text style={styles.tbText}>📁</Text>
          <Text style={styles.tbMini}>File</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.tbBtn, (!canRead || isExtracting) && styles.tbDisabled]}
          onPress={onPlayPress}
          disabled={!canRead || isExtracting}
        >
          <Text style={styles.tbText}>{isReading ? "⏸" : "▶️"}</Text>
          <Text style={styles.tbMini}>{isReading ? "Pausa" : "Play"}</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.tbBtn, (!isReading && !isPaused) && styles.tbDisabled]}
          onPress={hardStop}
          disabled={!isReading && !isPaused}
        >
          <Text style={styles.tbText}>⏹</Text>
          <Text style={styles.tbMini}>Stop</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.tbBtn, segments.length === 0 && styles.tbDisabled]}
          onPress={() => skipSegment(-1)}
          disabled={segments.length === 0}
        >
          <Text style={styles.tbText}>⏮</Text>
          <Text style={styles.tbMini}>Prev</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.tbBtn, segments.length === 0 && styles.tbDisabled]}
          onPress={() => skipSegment(+1)}
          disabled={segments.length === 0}
        >
          <Text style={styles.tbText}>⏭</Text>
          <Text style={styles.tbMini}>Next</Text>
        </TouchableOpacity>
      </View>

      {/* PDF WebView extractor offline */}
      {pdfBase64 && (
        <WebView
          source={{ html: pdfJsHtmlOffline(pdfBase64), baseUrl: "file:///android_asset/" }}
          javaScriptEnabled
          originWhitelist={["*"]}
		allowFileAccess={true}
		allowFileAccessFromFileURLs={true}
		allowUniversalAccessFromFileURLs={true}
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
          style={{ width: 0, height: 0, opacity: 0 }}
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

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0b0b0b" },

  chapterPanel: { backgroundColor: "#151515", borderRadius: 12, marginHorizontal: 16, marginTop: 8, marginBottom: 10, padding: 12 },
  chapterList: { maxHeight: 240 },
  chapterRow: { paddingVertical: 10, borderTopWidth: 1, borderTopColor: "#222" },
  chapterText: { color: "white" },

  textBox: { flex: 1, marginHorizontal: 16, backgroundColor: "#111", borderRadius: 12, padding: 12 },
  text: { color: "white", lineHeight: 20 },
  normalSeg: { backgroundColor: "transparent" },
  karaoke: { backgroundColor: "#ffe86a", color: "#000", borderRadius: 6, padding: 8 },

  rateBox: { paddingHorizontal: 16, paddingTop: 10, paddingBottom: 8 },
  rateLabel: { color: "#8f8f8f", fontSize: 12, marginBottom: 6 },

  toolbar: {
    flexDirection: "row",
    justifyContent: "space-around",
    paddingTop: 10,
    backgroundColor: "#121212",
    borderTopWidth: 1,
    borderTopColor: "#222",
  },
  tbBtn: { alignItems: "center", paddingHorizontal: 8, paddingVertical: 4, minWidth: 56 },
  tbText: { color: "white", fontSize: 18, fontWeight: "900" },
  tbMini: { color: "#bdbdbd", fontSize: 10, marginTop: 2 },
  tbDisabled: { opacity: 0.35 },
});
