// Web pages shared as links: the page is loaded in a hidden WebView and this
// script, run inside it, keeps the article (headings, paragraphs, lists) and
// drops menus, headers, footers and sidebars. Nothing leaves the phone but the
// page request itself.

/** the URL in a shared text, when the text is essentially a link */
export function sharedLink(text: string): string | null {
  const m = text.match(/https?:\/\/[^\s<>"')\]]+/i);
  if (!m) return null;
  const rest = text.replace(m[0], "").trim();
  return rest.length <= 300 ? m[0].replace(/[.,;:!?]+$/, "") : null;
}

export const READER_JS = `
(function () {
  function run() {
    try {
      var kill = 'script,style,noscript,nav,header,footer,aside,form,iframe,svg,button,select,textarea,video,audio,canvas,' +
        '[role=navigation],[role=banner],[role=contentinfo],[role=complementary],[role=dialog],[aria-hidden=true],' +
        '.nav,.navbar,.menu,.sidebar,.footer,.header,.cookie,.consent,.share,.social,.comments,.related,.advert,.ad,.ads,.breadcrumb,' +
        '#siteNotice,.sitenotice,#centralNotice,.mw-indicators,.noprint,.banner,.hatnote,.navbox,.infobox,.toc,#toc,.mw-editsection,.reference,.reflist,[class*=cookie],[id*=cookie],[class*=newsletter],[class*=paywall]';
      document.querySelectorAll(kill).forEach(function (e) { try { e.remove(); } catch (x) {} });
      var root = document.querySelector('article') || document.querySelector('main') || document.querySelector('[role=main]') ||
        document.querySelector('#content, .content, .post, .entry-content, .article-body, .mw-parser-output');
      if (!root) {
        var best = null, bestLen = 0;
        document.querySelectorAll('div,section,td').forEach(function (el) {
          var len = 0;
          for (var i = 0; i < el.children.length; i++) {
            var c = el.children[i];
            if (c.tagName === 'P') len += c.textContent.trim().length;
          }
          if (len > bestLen) { best = el; bestLen = len; }
        });
        root = best && bestLen > 200 ? best : document.body;
      }
      var h1 = document.querySelector('h1');
      var title = ((h1 && h1.textContent) || document.title || '').replace(/\\s+/g, ' ').trim();
      var out = [];
      var BLOCKS = 'p,h1,h2,h3,h4,h5,h6,li,blockquote,pre';
      function txt(el) { return (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim(); }
      function walk(node) {
        for (var i = 0; i < node.children.length; i++) {
          var el = node.children[i];
          var tag = el.tagName.toLowerCase();
          if (/^h[1-6]$/.test(tag)) { var t = txt(el); if (t) out.push('#'.repeat(Math.min(3, +tag[1])) + ' ' + t); }
          else if (tag === 'p') { var p = txt(el); if (p) out.push(p); }
          else if (tag === 'li') { var l = txt(el); if (l) out.push('- ' + l); }
          else if (tag === 'blockquote') { var q = txt(el); if (q) out.push('> ' + q); }
          else if (tag === 'pre') { var c = (el.textContent || '').trim(); if (c) out.push(c); }
          else if (tag === 'br' || tag === 'hr' || tag === 'img' || tag === 'figure' || tag === 'picture' || tag === 'figcaption' || tag === 'table') { if (tag === 'table') { var tt = txt(el); if (tt) out.push(tt); } }
          else if (el.querySelector(BLOCKS)) walk(el);
          else { var s = txt(el); if (s && s.length > 1) out.push(s); }
        }
      }
      walk(root);
      var text = out.join('\\n\\n');
      if (text.length < 200) text = (document.body.innerText || '').trim();
      if (title && text.slice(0, 600).indexOf(title) < 0) text = '# ' + title + '\\n\\n' + text;
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'article', title: title, text: text, url: location.href }));
    } catch (e) {
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'article-error', message: String(e) }));
    }
  }
  if (document.readyState === 'complete') setTimeout(run, 1200); else window.addEventListener('load', function () { setTimeout(run, 1200); });
})();
true;
`;
