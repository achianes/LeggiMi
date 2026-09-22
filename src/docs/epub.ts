// EPUB books: the zip is opened with JSZip, the spine gives the reading order,
// every XHTML file becomes light Markdown (headings, paragraphs, lists) and the
// table of contents supplies chapter titles for files that have no heading.
import JSZip from "jszip";
import RNFS from "react-native-fs";

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", mdash: "—", ndash: "–",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", laquo: "«", raquo: "»", copy: "©", reg: "®", deg: "°",
  eacute: "é", egrave: "è", agrave: "à", igrave: "ì", ograve: "ò", ugrave: "ù", uacute: "ú", oacute: "ó", iacute: "í", aacute: "á",
  ccedil: "ç", ntilde: "ñ", uuml: "ü", ouml: "ö", auml: "ä", szlig: "ß", euro: "€", middot: "·", bull: "•", times: "×",
};

export function decodeEntities(s: string) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => NAMED[n.toLowerCase()] ?? m);
}

const BLOCK = "p|div|section|article|blockquote|figure|figcaption|table|thead|tbody|tr|dd|dt|dl|header|footer|aside|main|address|pre|center";

/** HTML/XHTML → light Markdown (headings, paragraphs, list items, quotes, bold/italic). */
export function htmlToMarkdown(html: string): string {
  let h = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "")
    .replace(/<(script|style|head|svg|nav|noscript|iframe|object|video|audio|canvas|form|button|select|textarea)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<(img|input|meta|link|source|track|wbr)\b[^>]*>/gi, "");
  h = h
    .replace(/<h([1-6])\b[^>]*>/gi, (_, l) => `\n\n${"#".repeat(Math.min(3, Number(l)))} `)
    .replace(/<\/h[1-6]\s*>/gi, "\n\n")
    .replace(/<blockquote\b[^>]*>/gi, "\n\n> ")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/li\s*>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<hr\b[^>]*\/?>/gi, "\n\n---\n\n")
    .replace(/<td\b[^>]*>/gi, " ")
    .replace(/<\/td\s*>/gi, " ")
    .replace(new RegExp(`<(?:${BLOCK})\\b[^>]*>`, "gi"), "\n\n")
    .replace(new RegExp(`</(?:${BLOCK})\\s*>`, "gi"), "\n\n")
    .replace(/<(b|strong)\b[^>]*>([^<\n]{1,300})<\/\1\s*>/gi, "**$2**")
    .replace(/<(i|em)\b[^>]*>([^<\n]{1,300})<\/\1\s*>/gi, "*$2*")
    .replace(/<[^>]+>/g, "");
  h = decodeEntities(h);
  return h
    .replace(/[ \t\r\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^#{1,3} \s*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

type Manifest = Record<string, { href: string; type: string; props: string }>;

const attr = (tag: string, name: string) => {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i")) || tag.match(new RegExp(`\\b${name}\\s*=\\s*'([^']*)'`, "i"));
  return m ? decodeEntities(m[1]) : "";
};

const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/") + 1) : "");
const join = (base: string, rel: string) => {
  let r = decodeURIComponent(rel.replace(/#.*$/, ""));
  if (r.startsWith("/")) return r.slice(1);
  const parts = (base + r).split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "..") out.pop();
    else if (p !== "." && p !== "") out.push(p);
  }
  return out.join("/");
};

const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export type EpubBook = { title: string; text: string; chapters: number };

export async function extractEpub(localPath: string): Promise<EpubBook> {
  const b64 = await RNFS.readFile(localPath, "base64");
  const zip = await JSZip.loadAsync(b64, { base64: true });
  const container = await zip.file("META-INF/container.xml")?.async("text");
  const opfPath = container ? attr(container.match(/<rootfile\b[^>]*>/i)?.[0] ?? "", "full-path") : "";
  const opfFile = opfPath && zip.file(opfPath);
  if (!opfFile) throw new Error("Not a valid EPUB: the package file is missing.");
  const opf = await opfFile.async("text");
  const base = dirOf(opfPath);

  const manifest: Manifest = {};
  for (const tag of opf.match(/<item\b[^>]*>/gi) ?? []) {
    const id = attr(tag, "id");
    if (id) manifest[id] = { href: attr(tag, "href"), type: attr(tag, "media-type"), props: attr(tag, "properties") };
  }
  const spine: string[] = [];
  for (const tag of opf.match(/<itemref\b[^>]*>/gi) ?? []) {
    const it = manifest[attr(tag, "idref")];
    if (it && /html|xml/i.test(it.type) && !/nav/.test(it.props)) spine.push(join(base, it.href));
  }
  if (!spine.length) throw new Error("This EPUB has no readable pages.");
  const title = decodeEntities((opf.match(/<dc:title\b[^>]*>([\s\S]*?)<\/dc:title>/i)?.[1] ?? "").replace(/<[^>]+>/g, "").trim());

  // table of contents: EPUB 3 nav document, or the EPUB 2 NCX
  const toc = new Map<string, string>(); // file path -> first title pointing at it
  const navItem = Object.values(manifest).find((m) => /\bnav\b/.test(m.props));
  const ncxItem = Object.values(manifest).find((m) => /dtbncx/i.test(m.type)) ||
    (() => { const id = attr(opf.match(/<spine\b[^>]*>/i)?.[0] ?? "", "toc"); return id ? manifest[id] : undefined; })();
  const addToc = (href: string, label: string, from: string) => {
    const path = join(dirOf(from), href);
    const t = label.replace(/\s+/g, " ").trim();
    if (t && !toc.has(path)) toc.set(path, t);
  };
  if (navItem) {
    const navPath = join(base, navItem.href);
    const nav = await zip.file(navPath)?.async("text");
    const tocNav = nav?.match(/<nav\b[^>]*epub:type\s*=\s*"toc"[^>]*>([\s\S]*?)<\/nav>/i)?.[1] ?? nav ?? "";
    for (const a of tocNav.match(/<a\b[^>]*>[\s\S]*?<\/a>/gi) ?? []) {
      addToc(attr(a, "href"), decodeEntities(a.replace(/<[^>]+>/g, "")), navPath);
    }
  } else if (ncxItem) {
    const ncxPath = join(base, ncxItem.href);
    const ncx = await zip.file(ncxPath)?.async("text");
    for (const np of ncx?.match(/<navPoint\b[\s\S]*?<content\b[^>]*>/gi) ?? []) {
      const label = np.match(/<text>([\s\S]*?)<\/text>/i)?.[1] ?? "";
      const src = attr(np.match(/<content\b[^>]*>/i)?.[0] ?? "", "src");
      addToc(src, decodeEntities(label), ncxPath);
    }
  }

  const parts: string[] = [];
  let chapters = 0;
  for (const path of spine) {
    const f = zip.file(path);
    if (!f) continue;
    let md = htmlToMarkdown(await f.async("text"));
    if (!md) continue;
    const ttl = toc.get(path);
    if (ttl) {
      const firstLine = md.split("\n")[0];
      const headed = /^#{1,6}\s/.test(firstLine) && norm(firstLine.replace(/^#+\s*/, "")) === norm(ttl);
      if (!headed) md = `## ${ttl}\n\n${md}`;
      chapters++;
    } else if (/^#{1,6}\s/.test(md.split("\n")[0])) chapters++;
    parts.push(md);
  }
  const text = parts.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!text) throw new Error("No text found in this EPUB.");
  return { title, text, chapters };
}
