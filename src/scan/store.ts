// Scanned documents: data model, storage and the bridge to the native
// LeggiMiScan module (android/app/src/main/java/com/leggimimobile/scan).
import { NativeModules, PermissionsAndroid, Platform } from "react-native";
import RNFS from "react-native-fs";
import AsyncStorage from "@react-native-async-storage/async-storage";
import TextRecognition from "@react-native-ml-kit/text-recognition";

export type ScanFilter = "original" | "magic" | "gray" | "bw" | "lighten";

export type OcrLine = { text: string; left: number; top: number; width: number; height: number };

export type ScanPage = {
  id: string;
  /** the picture as captured/imported (never modified) */
  original: string;
  origW: number;
  origH: number;
  /** sheet corners, normalised 0..1: tl, tr, br, bl (x,y). null = whole picture */
  quad: number[] | null;
  rotation: number; // 0, 90, 180, 270
  filter: ScanFilter;
  /** the processed page (cropped, straightened, rotated, enhanced) */
  rendered: string;
  w: number;
  h: number;
  /** OCR of `rendered`; `source` tells which rendered file it belongs to */
  ocr?: { text: string; lines: OcrLine[]; w: number; h: number; source: string };
};

export type ScanDoc = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  pages: ScanPage[];
};

export type PdfMode = "image" | "searchable" | "text";

type Sized = { path: string; width: number; height: number };

const N: any = (NativeModules as any).LeggiMiScan;

export const scanNative = {
  available(): boolean {
    return !!N;
  },
  scan(limit: number, gallery: boolean): Promise<string[]> {
    return N.scan(limit, gallery);
  },
  importImage(src: string, out: string, maxSide = 3000): Promise<Sized> {
    return N.importImage(src, out, maxSide);
  },
  detect(src: string): Promise<number[] | null> {
    return N.detect(src);
  },
  processPage(o: {
    src: string;
    out: string;
    quad: number[] | null;
    rotation: number;
    filter: ScanFilter;
    maxSide?: number;
    quality?: number;
  }): Promise<Sized> {
    return N.processPage(o);
  },
  makePdf(o: {
    out: string;
    mode: PdfMode;
    title: string;
    text?: string;
    pages?: { path: string; imgW: number; imgH: number; lines?: OcrLine[] }[];
  }): Promise<{ path: string; pages: number; bytes: number }> {
    return N.makePdf(o);
  },
  async saveToDownloads(src: string, name: string, mime: string): Promise<string> {
    if (Platform.OS === "android" && Number(Platform.Version) < 29) {
      try {
        await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE);
      } catch {}
    }
    return N.saveToDownloads(src, name, mime);
  },
  shareFile(src: string, mime: string, title: string): Promise<boolean> {
    return N.shareFile(src, mime, title);
  },
};

export const SCAN_ROOT = `${RNFS.DocumentDirectoryPath}/scans`;
export const scanDir = (id: string) => `${SCAN_ROOT}/${id}`;
const scanKey = (id: string) => `scan:${id}`;

export function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export function defaultScanName(d = new Date()) {
  const p = (n: number) => `${n}`.padStart(2, "0");
  return `Scan ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}`;
}

export function safeFileName(name: string) {
  const s = name.replace(/[^A-Za-z0-9 ._()-]+/g, "_").replace(/\s+/g, " ").trim();
  return s.slice(0, 80) || "LeggiMi";
}

export async function loadScan(id: string): Promise<ScanDoc | null> {
  try {
    const raw = await AsyncStorage.getItem(scanKey(id));
    const d = raw ? JSON.parse(raw) : null;
    return d && Array.isArray(d.pages) ? d : null;
  } catch {
    return null;
  }
}

export async function saveScan(doc: ScanDoc) {
  await AsyncStorage.setItem(scanKey(doc.id), JSON.stringify(doc));
}

export async function deleteScan(id: string) {
  await AsyncStorage.removeItem(scanKey(id)).catch(() => {});
  await RNFS.unlink(scanDir(id)).catch(() => {});
}

export async function unlinkQuiet(path?: string | null) {
  if (!path) return;
  try {
    if (await RNFS.exists(path)) await RNFS.unlink(path);
  } catch {}
}

/** On-device OCR (ML Kit) of one image, keeping each line's box for searchable PDFs. */
export async function ocrImage(path: string): Promise<{ text: string; lines: OcrLine[] }> {
  const url = /^(file|content):\/\//.test(path) ? path : `file://${path}`;
  const res: any = await TextRecognition.recognize(url);
  const lines: OcrLine[] = [];
  const blocks: string[] = [];
  for (const b of res?.blocks || []) {
    const bl: string[] = [];
    for (const l of b?.lines || []) {
      const t = String(l?.text || "").trim();
      if (!t) continue;
      bl.push(t);
      const f = l?.frame;
      if (f && f.width > 0 && f.height > 0) {
        lines.push({ text: t, left: f.left, top: f.top, width: f.width, height: f.height });
      }
    }
    if (bl.length) blocks.push(bl.join("\n"));
  }
  return { text: blocks.join("\n\n"), lines };
}

/** The recognised text of the whole document, page after page. */
export function scanText(doc: ScanDoc) {
  return doc.pages
    .map((p) => (p.ocr?.text || "").trim())
    .filter(Boolean)
    .join("\n\n");
}

export function needsOcr(p: ScanPage) {
  return !p.ocr || p.ocr.source !== p.rendered;
}

export function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
