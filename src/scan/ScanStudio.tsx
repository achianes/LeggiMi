// ScanStudio: CamScanner-style workspace for photographed pages.
// Capture (ML Kit scanner or imported pictures) -> crop with draggable corners
// and perspective correction -> enhance filters -> reorder -> OCR -> read aloud
// or export as PDF (images, searchable, text only).
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  Modal,
  ScrollView,
  Image,
  TextInput,
  ActivityIndicator,
  Alert,
  PanResponder,
  StyleSheet,
  useWindowDimensions,
  LayoutChangeEvent,
} from "react-native";
import RNFS from "react-native-fs";
import { pick, keepLocalCopy, types } from "@react-native-documents/picker";
import {
  INK, PAPER, YELLOW, CORAL, MINT, SKY, GRAPE, TANGERINE, BUBBLEGUM,
  FONT_POSTER, FONT_BODY, FONT_BOLD, Palette,
  ComicBox, ComicButton, ComicIconButton, ComicChip, PosterTitle,
} from "../comic";
import {
  ScanDoc, ScanPage, ScanFilter, PdfMode,
  scanNative, scanDir, newId, defaultScanName, safeFileName, loadScan, saveScan, deleteScan,
  unlinkQuiet, ocrImage, scanText, needsOcr, fmtBytes,
} from "./store";

export type ExportTarget = { path: string; name: string; mime: string };

type Props = {
  visible: boolean;
  /** existing scan to open; null starts a new one */
  docId: string | null;
  /** what to do right after opening */
  start?: "camera" | "import" | null;
  /** pictures to add straight away (e.g. an image shared to LeggiMi) */
  images?: string[];
  /** "asis": keep the pictures untouched; "crop": find the sheet and enhance (default) */
  imagesMode?: "asis" | "crop";
  palette: Palette;
  insetTop: number;
  insetBottom: number;
  onClose: () => void;
  /** the document changed (pages, name): keep the Library in sync */
  onSaved: (doc: ScanDoc) => void;
  /** the whole document was deleted from inside the studio */
  onDeleted: (docId: string) => void;
  /** OCR done: open the text in the reader */
  onRead: (doc: ScanDoc, text: string) => void;
  /** optional extra destination for exported PDFs (cloud) */
  onCloudExport?: (file: ExportTarget) => void;
};

const FILTERS: { key: ScanFilter; label: string; color: string }[] = [
  { key: "original", label: "Original", color: PAPER },
  { key: "magic", label: "Magic", color: YELLOW },
  { key: "gray", label: "Gray", color: "#C9C4BC" },
  { key: "bw", label: "B&W", color: PAPER },
  { key: "lighten", label: "Lighten", color: TANGERINE },
];

const FULL_QUAD = [0, 0, 1, 0, 1, 1, 0, 1];

const fileUri = (p: string) => (p.startsWith("file://") || p.startsWith("content://") ? p : `file://${p}`);

// ============================================================ crop view

type CropProps = {
  path: string;
  imgW: number;
  imgH: number;
  quad: number[];
  palette: Palette;
  onChange: (q: number[]) => void;
};

/** Picture with the sheet outline and four draggable corners, plus a magnifier while dragging. */
function CropView({ path, imgW, imgH, quad, palette, onChange }: CropProps) {
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [drag, setDrag] = useState<number>(-1);
  const quadRef = useRef(quad);
  quadRef.current = quad;
  // the parent passes a new callback on every render: keep the latest one in a
  // ref so the PanResponder (and the gesture in progress) is created only once
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const rect = useMemo(() => {
    if (!box.w || !box.h || !imgW || !imgH) return { x: 0, y: 0, w: 0, h: 0 };
    const pad = 22; // room for the handles at the borders
    const s = Math.min((box.w - pad * 2) / imgW, (box.h - pad * 2) / imgH);
    const w = imgW * s;
    const h = imgH * s;
    return { x: (box.w - w) / 2, y: (box.h - h) / 2, w, h };
  }, [box, imgW, imgH]);
  const rectRef = useRef(rect);
  rectRef.current = rect;

  const pts = [0, 1, 2, 3].map((i) => ({ x: rect.x + quad[2 * i] * rect.w, y: rect.y + quad[2 * i + 1] * rect.h }));

  const dragRef = useRef({ idx: -1, sx: 0, sy: 0 });
  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: (e) => {
          const r = rectRef.current;
          const q = quadRef.current;
          const tx = e.nativeEvent.locationX;
          const ty = e.nativeEvent.locationY;
          let best = -1;
          let bestD = 70;
          for (let i = 0; i < 4; i++) {
            const x = r.x + q[2 * i] * r.w;
            const y = r.y + q[2 * i + 1] * r.h;
            const d = Math.hypot(x - tx, y - ty);
            if (d < bestD) { bestD = d; best = i; }
          }
          dragRef.current = best >= 0
            ? { idx: best, sx: r.x + q[2 * best] * r.w, sy: r.y + q[2 * best + 1] * r.h }
            : { idx: -1, sx: 0, sy: 0 };
          setDrag(best);
        },
        onPanResponderMove: (_e, g) => {
          const d = dragRef.current;
          if (d.idx < 0) return;
          const r = rectRef.current;
          if (!r.w || !r.h) return;
          const nx = Math.min(1, Math.max(0, (d.sx + g.dx - r.x) / r.w));
          const ny = Math.min(1, Math.max(0, (d.sy + g.dy - r.y) / r.h));
          const q = quadRef.current.slice();
          q[2 * d.idx] = nx;
          q[2 * d.idx + 1] = ny;
          quadRef.current = q;
          onChangeRef.current(q);
        },
        onPanResponderRelease: () => { dragRef.current.idx = -1; setDrag(-1); },
        onPanResponderTerminate: () => { dragRef.current.idx = -1; setDrag(-1); },
      }),
    []
  );

  const onLayout = (e: LayoutChangeEvent) => setBox({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height });

  const ZOOM = 2.6;
  const LOUPE = 128;
  const active = drag >= 0 ? pts[drag] : null;

  return (
    <View style={{ flex: 1 }} onLayout={onLayout} {...pan.panHandlers}>
      {rect.w > 0 ? (
        <>
          <View pointerEvents="none" style={{ position: "absolute", left: rect.x, top: rect.y, width: rect.w, height: rect.h }}>
            <Image source={{ uri: fileUri(path) }} style={{ width: rect.w, height: rect.h }} resizeMode="stretch" />
          </View>
          {/* outline: ink underneath, yellow on top */}
          {[0, 1, 2, 3].map((i) => {
            const a = pts[i];
            const b = pts[(i + 1) % 4];
            const len = Math.hypot(b.x - a.x, b.y - a.y);
            const ang = Math.atan2(b.y - a.y, b.x - a.x);
            const mx = (a.x + b.x) / 2;
            const my = (a.y + b.y) / 2;
            return (
              <React.Fragment key={`e${i}`}>
                <View pointerEvents="none" style={{ position: "absolute", left: mx - len / 2, top: my - 3, width: len, height: 6, backgroundColor: INK, borderRadius: 3, transform: [{ rotate: `${ang}rad` }] }} />
                <View pointerEvents="none" style={{ position: "absolute", left: mx - len / 2, top: my - 1.5, width: len, height: 3, backgroundColor: YELLOW, borderRadius: 2, transform: [{ rotate: `${ang}rad` }] }} />
              </React.Fragment>
            );
          })}
          {pts.map((p, i) => (
            <View
              key={`h${i}`}
              pointerEvents="none"
              style={[
                styles.handle,
                { left: p.x - 16, top: p.y - 16, backgroundColor: drag === i ? YELLOW : CORAL },
              ]}
            />
          ))}
          {active ? (
            <View
              pointerEvents="none"
              style={[
                styles.loupe,
                { width: LOUPE, height: LOUPE, borderRadius: LOUPE / 2, left: active.x < box.w / 2 ? box.w - LOUPE - 12 : 12 },
              ]}
            >
              <Image
                source={{ uri: fileUri(path) }}
                resizeMode="stretch"
                style={{
                  position: "absolute",
                  width: rect.w * ZOOM,
                  height: rect.h * ZOOM,
                  left: LOUPE / 2 - (active.x - rect.x) * ZOOM,
                  top: LOUPE / 2 - (active.y - rect.y) * ZOOM,
                }}
              />
              <View style={{ position: "absolute", left: LOUPE / 2 - 1, top: LOUPE / 2 - 14, width: 2, height: 28, backgroundColor: CORAL }} />
              <View style={{ position: "absolute", left: LOUPE / 2 - 14, top: LOUPE / 2 - 1, width: 28, height: 2, backgroundColor: CORAL }} />
            </View>
          ) : null}
        </>
      ) : null}
    </View>
  );
}

// ============================================================ studio

type EditorState = {
  index: number;
  mode: "crop" | "enhance";
  quad: number[];
  rotation: number;
  filter: ScanFilter;
};

export default function ScanStudio(props: Props) {
  const { visible, palette, insetTop, insetBottom } = props;
  const { width: winW } = useWindowDimensions();
  const [doc, setDoc] = useState<ScanDoc | null>(null);
  const docRef = useRef<ScanDoc | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [preview, setPreview] = useState<{ path: string; w: number; h: number } | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const previewSeq = useRef(0);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportMode, setExportMode] = useState<PdfMode>("searchable");
  const [nameDraft, setNameDraft] = useState("");
  const startedRef = useRef(false);

  const s = useMemo(() => makeStyles(palette), [palette]);

  const commit = useCallback(
    async (next: ScanDoc) => {
      const d = { ...next, updatedAt: Date.now() };
      docRef.current = d;
      setDoc(d);
      if (d.pages.length) {
        await saveScan(d);
        props.onSaved(d);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.onSaved]
  );

  // ---- open / create
  useEffect(() => {
    if (!visible) {
      startedRef.current = false;
      return;
    }
    let cancelled = false;
    (async () => {
      let d: ScanDoc | null = props.docId ? await loadScan(props.docId) : null;
      if (!d) {
        const now = Date.now();
        d = { id: newId(), name: defaultScanName(), createdAt: now, updatedAt: now, pages: [] };
      }
      await RNFS.mkdir(scanDir(d.id)).catch(() => {});
      if (cancelled) return;
      docRef.current = d;
      setDoc(d);
      setNameDraft(d.name);
      setEditor(null);
      setExportOpen(false);
      if (startedRef.current) return;
      startedRef.current = true;
      if (props.images && props.images.length) {
        await addPictures(
          props.images,
          true,
          props.imagesMode === "asis" ? { detect: false, filter: "original" } : { detect: true, filter: "magic" }
        );
      }
      else if (props.start === "camera") await addFromCamera(true);
      else if (props.start === "import") await addFromFiles(true);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, props.docId]);

  const close = useCallback(async () => {
    const d = docRef.current;
    if (d && d.pages.length === 0) await deleteScan(d.id);
    setEditor(null);
    setExportOpen(false);
    props.onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.onClose]);

  // ---- adding pages
  const addPictures = async (sources: string[], fromOpen = false, opts: { detect: boolean; filter: ScanFilter } = { detect: true, filter: "magic" }) => {
    const d0 = docRef.current;
    if (!d0 || !sources.length) {
      if (fromOpen && d0 && !d0.pages.length) close();
      return;
    }
    const added: ScanPage[] = [];
    try {
      for (let i = 0; i < sources.length; i++) {
        setBusy(`Preparing page ${i + 1} of ${sources.length}…`);
        const id = newId();
        const orig = await scanNative.importImage(sources[i], `${scanDir(d0.id)}/${id}_orig.jpg`, 3000);
        let quad: number[] | null = null;
        if (opts.detect) {
          try { quad = await scanNative.detect(orig.path); } catch { quad = null; }
        }
        let rendered = orig.path;
        let w = orig.width;
        let h = orig.height;
        if (quad || opts.filter !== "original") {
          const r = await scanNative.processPage({
            src: orig.path, out: `${scanDir(d0.id)}/${id}_r${Date.now()}.jpg`, quad, rotation: 0, filter: opts.filter,
          });
          rendered = r.path; w = r.width; h = r.height;
        }
        added.push({ id, original: orig.path, origW: orig.width, origH: orig.height, quad, rotation: 0, filter: opts.filter, rendered, w, h });
      }
    } catch (e: any) {
      Alert.alert("Scanner", String(e?.message ?? e));
    } finally {
      setBusy(null);
    }
    const cur = docRef.current;
    if (!cur) return;
    if (added.length) await commit({ ...cur, pages: [...cur.pages, ...added] });
    else if (fromOpen && !cur.pages.length) close();
  };

  const addFromCamera = async (fromOpen = false) => {
    if (!scanNative.available()) {
      Alert.alert("Scanner", "This build has no scanner module. Install the latest LeggiMi build.");
      if (fromOpen) close();
      return;
    }
    let uris: string[] = [];
    try {
      uris = await scanNative.scan(30, true);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (!/cancel/i.test(msg)) {
        Alert.alert(
          "Camera scanner",
          `${msg}\n\nThe scanner comes with Google Play services and is downloaded on first use. You can still import photos instead.`
        );
      }
      if (fromOpen && !(docRef.current?.pages.length)) close();
      return;
    }
    // ML Kit already cropped, straightened and filtered the pages
    await addPictures(uris, fromOpen, { detect: false, filter: "original" });
  };

  const addFromFiles = async (fromOpen = false) => {
    let local: string[] = [];
    try {
      const files = await pick({ type: [types.images], allowMultiSelection: true });
      const copies = await keepLocalCopy({
        destination: "cachesDirectory",
        files: files.map((f, i) => ({ uri: f.uri, fileName: f.name ?? `image_${i}.jpg` })) as any,
      });
      local = copies.filter((c: any) => c.status === "success").map((c: any) => c.localUri);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (!/cancel/i.test(msg)) Alert.alert("Import", msg);
      if (fromOpen && !(docRef.current?.pages.length)) close();
      return;
    }
    await addPictures(local, fromOpen);
  };

  // ---- page editor
  const openEditor = (index: number) => {
    const p = docRef.current?.pages[index];
    if (!p) return;
    setPreview(null);
    setEditor({ index, mode: "enhance", quad: p.quad ?? FULL_QUAD.slice(), rotation: p.rotation, filter: p.filter });
  };

  const editorPage = editor && doc ? doc.pages[editor.index] : null;

  // live preview of the enhance tab
  useEffect(() => {
    if (!editor || editor.mode !== "enhance" || !editorPage || !doc) return;
    const seq = ++previewSeq.current;
    setPreviewBusy(true);
    const t = setTimeout(async () => {
      try {
        const out = `${RNFS.CachesDirectoryPath}/scan_preview_${seq}.jpg`;
        const r = await scanNative.processPage({
          src: editorPage.original, out, quad: editor.quad, rotation: editor.rotation, filter: editor.filter, maxSide: 1100, quality: 80,
        });
        if (seq !== previewSeq.current) { unlinkQuiet(r.path); return; }
        setPreview((old) => {
          if (old) unlinkQuiet(old.path);
          return { path: r.path, w: r.width, h: r.height };
        });
      } catch (e: any) {
        console.log("[scan] preview", String(e?.message ?? e));
      } finally {
        if (seq === previewSeq.current) setPreviewBusy(false);
      }
    }, 120);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor?.mode, editor?.filter, editor?.rotation, editor?.quad, editor?.index]);

  const applyEditor = async () => {
    const d = docRef.current;
    if (!editor || !d) return;
    const p = d.pages[editor.index];
    if (!p) return;
    setBusy("Applying…");
    try {
      const quad = editor.quad.every((v, i) => Math.abs(v - FULL_QUAD[i]) < 0.004) ? null : editor.quad;
      const unchanged =
        JSON.stringify(quad) === JSON.stringify(p.quad) && editor.rotation === p.rotation && editor.filter === p.filter;
      let next: ScanPage = p;
      if (!unchanged) {
        const r = await scanNative.processPage({
          src: p.original, out: `${scanDir(d.id)}/${p.id}_r${Date.now()}.jpg`, quad, rotation: editor.rotation, filter: editor.filter,
        });
        if (p.rendered !== p.original) unlinkQuiet(p.rendered);
        next = { ...p, quad, rotation: editor.rotation, filter: editor.filter, rendered: r.path, w: r.width, h: r.height, ocr: undefined };
      }
      const pages = d.pages.slice();
      pages[editor.index] = next;
      await commit({ ...d, pages });
      setEditor(null);
      setPreview((old) => { if (old) unlinkQuiet(old.path); return null; });
    } catch (e: any) {
      Alert.alert("Scanner", String(e?.message ?? e));
    } finally {
      setBusy(null);
    }
  };

  const movePage = async (delta: number) => {
    const d = docRef.current;
    if (!editor || !d) return;
    const to = editor.index + delta;
    if (to < 0 || to >= d.pages.length) return;
    const pages = d.pages.slice();
    const [p] = pages.splice(editor.index, 1);
    pages.splice(to, 0, p);
    await commit({ ...d, pages });
    setEditor({ ...editor, index: to });
  };

  const deletePage = () => {
    const d = docRef.current;
    if (!editor || !d) return;
    Alert.alert("Delete page", `Remove page ${editor.index + 1}?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          const p = d.pages[editor.index];
          const pages = d.pages.filter((_, i) => i !== editor.index);
          if (p) { unlinkQuiet(p.original); if (p.rendered !== p.original) unlinkQuiet(p.rendered); }
          setEditor(null);
          if (!pages.length) {
            await deleteScan(d.id);
            props.onDeleted(d.id);
            docRef.current = { ...d, pages: [] };
            setDoc(docRef.current);
            return;
          }
          await commit({ ...d, pages });
        },
      },
    ]);
  };

  const autoDetect = async () => {
    if (!editor || !editorPage) return;
    setBusy("Looking for the sheet…");
    try {
      const q = await scanNative.detect(editorPage.original);
      if (q) setEditor({ ...editor, quad: q });
      else Alert.alert("Auto crop", "I could not find the edges of the sheet: drag the corners yourself.");
    } catch (e: any) {
      Alert.alert("Auto crop", String(e?.message ?? e));
    } finally {
      setBusy(null);
    }
  };

  // ---- OCR / read / export
  const runOcr = async (): Promise<ScanDoc | null> => {
    const d = docRef.current;
    if (!d || !d.pages.length) return null;
    const pages = d.pages.slice();
    let changed = false;
    try {
      for (let i = 0; i < pages.length; i++) {
        const p = pages[i];
        if (!needsOcr(p)) continue;
        setBusy(`Recognising text · page ${i + 1} of ${pages.length}`);
        // hard black & white loses the thin strokes OCR needs: read a grey
        // version of the very same page (same crop and size, so the boxes of a
        // searchable PDF still line up with the B&W image)
        let src = p.rendered;
        let tmp: string | null = null;
        if (p.filter === "bw") {
          tmp = `${RNFS.CachesDirectoryPath}/ocr_src_${p.id}.jpg`;
          const g = await scanNative.processPage({ src: p.original, out: tmp, quad: p.quad, rotation: p.rotation, filter: "gray" });
          src = g.path;
        }
        const r = await ocrImage(src);
        if (tmp) unlinkQuiet(tmp);
        pages[i] = { ...p, ocr: { text: r.text, lines: r.lines, w: p.w, h: p.h, source: p.rendered } };
        changed = true;
      }
    } catch (e: any) {
      Alert.alert("OCR", String(e?.message ?? e));
      return null;
    } finally {
      setBusy(null);
    }
    const next = changed ? { ...d, pages } : d;
    if (changed) await commit(next);
    return next;
  };

  const readAloud = async () => {
    const d = await runOcr();
    if (!d) return;
    const text = scanText(d);
    if (!text.trim()) {
      Alert.alert("OCR", "No readable text was found on these pages. Try the B&W filter or a sharper photo.");
      return;
    }
    setEditor(null);
    props.onRead(d, text);
  };

  const buildPdf = async (mode: PdfMode): Promise<ExportTarget | null> => {
    let d = docRef.current;
    if (!d || !d.pages.length) return null;
    if (mode !== "image") {
      d = await runOcr();
      if (!d) return null;
      if (mode === "text" && !scanText(d).trim()) {
        Alert.alert("OCR", "No text was recognised: export the pages as images instead.");
        return null;
      }
    }
    const base = safeFileName(d.name);
    const name = mode === "text" ? `${base} (text).pdf` : `${base}.pdf`;
    const out = `${RNFS.CachesDirectoryPath}/export/${name}`;
    setBusy("Building the PDF…");
    try {
      await RNFS.mkdir(`${RNFS.CachesDirectoryPath}/export`).catch(() => {});
      await unlinkQuiet(out);
      const r = await scanNative.makePdf({
        out,
        mode,
        title: d.name,
        text: mode === "text" ? scanText(d) : "",
        pages: d.pages.map((p) => ({
          path: p.rendered,
          imgW: p.w,
          imgH: p.h,
          lines: mode === "searchable" ? p.ocr?.lines ?? [] : [],
        })),
      });
      console.log("[scan] pdf", r.pages, "pages", fmtBytes(r.bytes));
      return { path: r.path, name, mime: "application/pdf" };
    } catch (e: any) {
      Alert.alert("PDF", String(e?.message ?? e));
      return null;
    } finally {
      setBusy(null);
    }
  };

  const exportTo = async (dest: "downloads" | "share" | "cloud") => {
    const f = await buildPdf(exportMode);
    if (!f) return;
    try {
      if (dest === "downloads") {
        const where = await scanNative.saveToDownloads(f.path, f.name, f.mime);
        setExportOpen(false);
        Alert.alert("Saved", `${f.name}\nis in ${where.replace(/\/[^/]+$/, "")}.`);
      } else if (dest === "share") {
        setExportOpen(false);
        await scanNative.shareFile(f.path, f.mime, f.name);
      } else if (props.onCloudExport) {
        setExportOpen(false);
        props.onCloudExport(f);
      }
    } catch (e: any) {
      Alert.alert("Export", String(e?.message ?? e));
    }
  };

  const rename = async () => {
    const d = docRef.current;
    const n = nameDraft.trim();
    if (!d || !n || n === d.name) return;
    await commit({ ...d, name: n });
  };

  const onBack = () => {
    if (busy) return;
    if (editor) { setEditor(null); return; }
    if (exportOpen) { setExportOpen(false); return; }
    close();
  };

  // ------------------------------------------------------------- render
  const pages = doc?.pages ?? [];
  const tw = Math.floor((winW - 16 * 2 - 16) / 2);
  const th = Math.round(tw * 1.36);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onBack}>
      <View style={[s.root, { paddingTop: insetTop }]}>
        {/* header */}
        <View style={s.header}>
          <ComicIconButton icon="✕" onPress={onBack} palette={palette} color={palette.surface} size={42} fontSize={17} />
          <View style={{ flex: 1, marginHorizontal: 10 }}>
            <TextInput
              value={nameDraft}
              onChangeText={setNameDraft}
              onEndEditing={rename}
              onSubmitEditing={rename}
              style={s.nameInput}
              placeholder="Document name"
              placeholderTextColor={palette.dim}
              selectTextOnFocus
            />
            <Text style={s.headerSub}>
              {pages.length} page{pages.length === 1 ? "" : "s"}
              {pages.length && pages.every((p) => !needsOcr(p)) ? " · text recognised" : ""}
            </Text>
          </View>
          <ComicIconButton icon="📄" onPress={() => pages.length && setExportOpen(true)} disabled={!pages.length} palette={palette} color={SKY} size={42} fontSize={18} />
        </View>

        {/* pages */}
        {pages.length === 0 ? (
          <View style={s.emptyWrap}>
            <ComicBox palette={palette} radius={24} shadow={6} contentStyle={s.emptyCard}>
              <Text style={{ fontSize: 56 }}>📷</Text>
              <PosterTitle text="SCAN PAGES" palette={palette} size={26} style={{ marginTop: 6 }} />
              <Text style={s.emptyText}>
                Photograph one or more sheets: edges are found for you, you can drag the corners, straighten, enhance, then read it aloud or save a PDF.
              </Text>
              <ComicButton text="CAMERA" icon="📷" onPress={() => addFromCamera()} palette={palette} color={YELLOW} style={{ marginTop: 16, alignSelf: "stretch" }} />
              <ComicButton text="IMPORT PHOTOS" icon="🖼️" onPress={() => addFromFiles()} palette={palette} color={BUBBLEGUM} style={{ marginTop: 12, alignSelf: "stretch" }} />
            </ComicBox>
          </View>
        ) : (
          <ScrollView contentContainerStyle={s.grid}>
            {pages.map((p, i) => (
              <ComicBox
                key={p.id}
                palette={palette}
                radius={16}
                shadow={4}
                onPress={() => openEditor(i)}
                style={{ width: tw, marginBottom: 16 }}
                contentStyle={{ height: th, backgroundColor: palette.surface2 }}
              >
                <Image source={{ uri: fileUri(p.rendered) }} resizeMode="contain" style={{ width: "100%", height: "100%" }} />
                <View style={[s.pageNo, { borderColor: palette.ink }]}>
                  <Text style={s.pageNoText}>{i + 1}</Text>
                </View>
                {!needsOcr(p) ? (
                  <View style={[s.ocrBadge, { borderColor: palette.ink }]}>
                    <Text style={s.ocrBadgeText}>OCR ✓</Text>
                  </View>
                ) : null}
              </ComicBox>
            ))}
            <ComicBox palette={palette} radius={16} shadow={3} stroke={2} onPress={() => addFromCamera()} style={{ width: tw, marginBottom: 16 }} contentStyle={[s.addTile, { height: th }]}>
              <Text style={{ fontSize: 34 }}>＋</Text>
              <Text style={s.addTileText}>Add pages</Text>
            </ComicBox>
          </ScrollView>
        )}

        {/* action bar */}
        {pages.length > 0 ? (
          <ComicBox palette={palette} radius={26} shadow={5} style={[s.barWrap, { marginBottom: Math.max(12, insetBottom) }]} contentStyle={s.bar}>
            <BarItem label="Camera" icon="📷" color={YELLOW} onPress={() => addFromCamera()} palette={palette} />
            <BarItem label="Photos" icon="🖼️" color={BUBBLEGUM} onPress={() => addFromFiles()} palette={palette} />
            <BarItem label="Read" icon="🔊" color={MINT} onPress={readAloud} palette={palette} big />
            <BarItem label="PDF" icon="📄" color={SKY} onPress={() => setExportOpen(true)} palette={palette} />
          </ComicBox>
        ) : null}

        {/* page editor */}
        {editor && editorPage ? (
          <View style={[StyleSheet.absoluteFill, s.editor, { paddingTop: insetTop, paddingBottom: Math.max(12, insetBottom) }]}>
            <View style={s.header}>
              <ComicIconButton icon="✕" onPress={() => setEditor(null)} palette={palette} color={palette.surface} size={42} fontSize={17} />
              <PosterTitle text={`PAGE ${editor.index + 1} / ${pages.length}`} palette={palette} size={24} style={{ flex: 1, marginLeft: 12 }} />
              <ComicIconButton icon="🗑" onPress={deletePage} palette={palette} color={CORAL} size={42} fontSize={18} />
            </View>
            <View style={s.modeRow}>
              <ComicChip text="✂️  Crop" selected={editor.mode === "crop"} onPress={() => setEditor({ ...editor, mode: "crop" })} palette={palette} color={YELLOW} />
              <ComicChip text="✨  Enhance" selected={editor.mode === "enhance"} onPress={() => setEditor({ ...editor, mode: "enhance" })} palette={palette} color={MINT} />
            </View>

            <ComicBox palette={palette} radius={20} shadow={4} style={s.canvasWrap} contentStyle={[s.canvas, { backgroundColor: palette.surface2 }]}>
              {editor.mode === "crop" ? (
                <CropView
                  path={editorPage.original}
                  imgW={editorPage.origW}
                  imgH={editorPage.origH}
                  quad={editor.quad}
                  palette={palette}
                  onChange={(q) => setEditor((e) => (e ? { ...e, quad: q } : e))}
                />
              ) : preview ? (
                <Image source={{ uri: fileUri(preview.path) }} resizeMode="contain" style={{ flex: 1, margin: 10 }} />
              ) : (
                <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
                  <ActivityIndicator color={palette.text} />
                </View>
              )}
              {editor.mode === "enhance" && previewBusy ? (
                <View style={s.previewSpin}><ActivityIndicator color={INK} /></View>
              ) : null}
            </ComicBox>

            {editor.mode === "crop" ? (
              <View style={s.toolRow}>
                <ComicButton text="AUTO" icon="🪄" onPress={autoDetect} palette={palette} color={GRAPE} compact />
                <ComicButton text="WHOLE" icon="⛶" onPress={() => setEditor({ ...editor, quad: FULL_QUAD.slice() })} palette={palette} color={palette.surface} compact />
                <ComicButton text="DONE" icon="✓" onPress={() => setEditor({ ...editor, mode: "enhance" })} palette={palette} color={MINT} compact />
              </View>
            ) : (
              <>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0, flexShrink: 0 }} contentContainerStyle={s.filterRow}>
                  {FILTERS.map((f) => (
                    <ComicChip
                      key={f.key}
                      text={f.label}
                      selected={editor.filter === f.key}
                      onPress={() => setEditor({ ...editor, filter: f.key })}
                      palette={palette}
                      color={f.color}
                      style={{ marginRight: 10 }}
                    />
                  ))}
                </ScrollView>
                <View style={s.toolRow}>
                  <ComicIconButton icon="↺" onPress={() => setEditor({ ...editor, rotation: (editor.rotation + 270) % 360 })} palette={palette} color={palette.surface} size={42} fontSize={20} />
                  <ComicIconButton icon="↻" onPress={() => setEditor({ ...editor, rotation: (editor.rotation + 90) % 360 })} palette={palette} color={palette.surface} size={42} fontSize={20} />
                  <ComicIconButton icon="◀" onPress={() => movePage(-1)} disabled={editor.index === 0} palette={palette} color={palette.surface2} size={42} fontSize={15} />
                  <ComicIconButton icon="▶" onPress={() => movePage(1)} disabled={editor.index >= pages.length - 1} palette={palette} color={palette.surface2} size={42} fontSize={15} />
                </View>
              </>
            )}
            <ComicButton text="APPLY" icon="✓" onPress={applyEditor} palette={palette} color={MINT} style={{ marginHorizontal: 16, marginTop: 12 }} />
          </View>
        ) : null}

        {/* export sheet */}
        {exportOpen ? (
          <View style={StyleSheet.absoluteFill}>
            <View style={s.backdrop} onTouchEnd={() => setExportOpen(false)} />
            <View style={[s.sheetWrap, { bottom: Math.max(12, insetBottom + 8) }]}>
              <ComicBox palette={palette} radius={26} shadow={6} contentStyle={s.sheet}>
                <View style={s.sheetHead}>
                  <Text style={{ fontSize: 26 }}>📄</Text>
                  <PosterTitle text="EXPORT PDF" palette={palette} size={26} />
                </View>
                {([
                  ["image", "🖼️", "Pages as images", "Exactly what you scanned"],
                  ["searchable", "🔎", "Searchable PDF", "Images + invisible OCR text you can search and copy"],
                  ["text", "📝", "Text only", "Just the recognised text: tiny file"],
                ] as [PdfMode, string, string, string][]).map(([k, icon, title, sub]) => (
                  <ComicBox
                    key={k}
                    palette={palette}
                    color={exportMode === k ? YELLOW : palette.surface}
                    radius={14}
                    stroke={exportMode === k ? 3 : 2}
                    shadow={exportMode === k ? 4 : 2}
                    onPress={() => setExportMode(k)}
                    style={{ marginBottom: 10, marginRight: 4 }}
                    contentStyle={s.optRow}
                  >
                    <Text style={{ fontSize: 22 }}>{icon}</Text>
                    <View style={{ flex: 1 }}>
                      <Text style={[s.optTitle, exportMode === k && { color: INK }]}>{title}</Text>
                      <Text style={[s.optSub, exportMode === k && { color: INK }]}>{sub}</Text>
                    </View>
                  </ComicBox>
                ))}
                <View style={s.exportBtns}>
                  <ComicButton text="DOWNLOADS" icon="⬇️" onPress={() => exportTo("downloads")} palette={palette} color={MINT} compact style={{ flex: 1 }} />
                  <ComicButton text="SHARE" icon="📤" onPress={() => exportTo("share")} palette={palette} color={SKY} compact style={{ flex: 1 }} />
                </View>
                {props.onCloudExport ? (
                  <ComicButton text="CLOUD" icon="☁️" onPress={() => exportTo("cloud")} palette={palette} color={GRAPE} compact style={{ marginTop: 10 }} />
                ) : null}
              </ComicBox>
            </View>
          </View>
        ) : null}

        {busy ? (
          <View style={s.busy}>
            <ComicBox palette={palette} color={YELLOW} radius={22} shadow={6} contentStyle={s.busyCard}>
              <ActivityIndicator size="large" color={INK} />
              <Text style={s.busyText}>{busy}</Text>
            </ComicBox>
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

function BarItem({ label, icon, color, onPress, palette, big }: { label: string; icon: string; color: string; onPress: () => void; palette: Palette; big?: boolean }) {
  return (
    <View style={{ alignItems: "center", minWidth: 62 }}>
      <ComicIconButton icon={icon} onPress={onPress} palette={palette} color={color} size={big ? 62 : 48} fontSize={big ? 26 : 20} />
      <Text style={{ color: palette.dim, fontFamily: FONT_BOLD, fontSize: 11.5, marginTop: 7 }}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  handle: { position: "absolute", width: 32, height: 32, borderRadius: 16, borderWidth: 3, borderColor: INK },
  loupe: { position: "absolute", top: 12, borderWidth: 3, borderColor: INK, overflow: "hidden", backgroundColor: PAPER },
});

function makeStyles(p: Palette) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: p.bg },
    header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingTop: 10, paddingBottom: 8 },
    nameInput: { color: p.text, fontFamily: FONT_BOLD, fontSize: 18, paddingVertical: 2, paddingHorizontal: 0, borderBottomWidth: 2, borderBottomColor: p.ink },
    headerSub: { color: p.dim, fontFamily: FONT_BODY, fontSize: 12.5, marginTop: 3 },

    emptyWrap: { flex: 1, justifyContent: "center", paddingHorizontal: 18 },
    emptyCard: { alignItems: "center", paddingHorizontal: 20, paddingVertical: 24 },
    emptyText: { color: p.dim, fontFamily: FONT_BODY, fontSize: 15.5, lineHeight: 22, textAlign: "center", marginTop: 10 },

    grid: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", paddingHorizontal: 16, paddingTop: 12, paddingBottom: 20 },
    pageNo: { position: "absolute", top: 8, left: 8, minWidth: 30, height: 30, borderRadius: 15, borderWidth: 3, backgroundColor: YELLOW, alignItems: "center", justifyContent: "center", paddingHorizontal: 6 },
    pageNoText: { fontFamily: FONT_POSTER, fontSize: 15, color: INK, includeFontPadding: false },
    ocrBadge: { position: "absolute", bottom: 8, right: 8, borderWidth: 2, borderRadius: 10, backgroundColor: MINT, paddingHorizontal: 6, paddingVertical: 2 },
    ocrBadgeText: { fontFamily: FONT_BOLD, fontSize: 11, color: INK },
    addTile: { alignItems: "center", justifyContent: "center", backgroundColor: p.surface },
    addTileText: { color: p.text, fontFamily: FONT_BOLD, fontSize: 14, marginTop: 4 },

    barWrap: { marginHorizontal: 16 },
    bar: { flexDirection: "row", alignItems: "flex-end", justifyContent: "space-around", paddingHorizontal: 8, paddingTop: 12, paddingBottom: 10 },

    editor: { backgroundColor: p.bg },
    modeRow: { flexDirection: "row", gap: 12, paddingHorizontal: 16, marginBottom: 12 },
    canvasWrap: { flex: 1, marginHorizontal: 16 },
    canvas: { flex: 1 },
    previewSpin: { position: "absolute", top: 12, right: 12, backgroundColor: YELLOW, borderRadius: 14, borderWidth: 2, borderColor: INK, padding: 4 },
    filterRow: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 6, alignItems: "flex-start" },
    toolRow: { flexDirection: "row", justifyContent: "space-around", alignItems: "center", paddingHorizontal: 16, marginTop: 14 },

    backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: "#17161A99" },
    sheetWrap: { position: "absolute", left: 12, right: 12 },
    sheet: { paddingHorizontal: 18, paddingTop: 16, paddingBottom: 18 },
    sheetHead: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 12 },
    optRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 10 },
    optTitle: { color: p.text, fontFamily: FONT_BOLD, fontSize: 15 },
    optSub: { color: p.dim, fontFamily: FONT_BODY, fontSize: 12.5, marginTop: 1 },
    exportBtns: { flexDirection: "row", gap: 12, marginTop: 6 },

    busy: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center", backgroundColor: p.bg + "B3", paddingHorizontal: 32 },
    busyCard: { alignItems: "center", paddingHorizontal: 26, paddingVertical: 22, minWidth: 240 },
    busyText: { color: INK, fontFamily: FONT_BOLD, fontSize: 15, marginTop: 12, textAlign: "center" },
  });
}
