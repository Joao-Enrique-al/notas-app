// Constantes, geometria e exportação compartilhadas pelo app.
export const C = {
  bg: '#E8EDF1', ink: '#17212B', muted: '#6B7885', line: '#C9D2DA',
  accent: '#0E7C86', accentSoft: '#D5ECEE', danger: '#B3372F', paper: '#FFFFFF',
};
export const COLORS = ['#17212B', '#0E7C86', '#2F5BEA', '#B3372F', '#E07B00', '#7A3FC4', '#1E8E4E'];
export const HL_COLORS = ['#FFE14D', '#8CF0A8', '#7FD4FF', '#FF9EC4'];
export const NB_COLORS = ['#0E7C86', '#2F5BEA', '#B3372F', '#E07B00', '#7A3FC4', '#1E8E4E'];
export const PAPERS = [
  { key: 'blank', label: 'Em branco' },
  { key: 'lined', label: 'Pautado' },
  { key: 'grid', label: 'Quadriculado' },
  { key: 'dots', label: 'Pontilhado' },
];
export const PAGE_W = 820;
export const PAGE_H = 1160;
export const STORAGE_KEY = 'notas-app:v2';
export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
export const newPage = (paper = 'lined') => ({ id: uid(), paper, w: PAGE_W, h: PAGE_H, bg: null, items: [] });
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ───────── Traços ─────────
export function smoothPath(pts) {
  if (!pts.length) return '';
  if (pts.length === 1) return `M${pts[0].x} ${pts[0].y} L${pts[0].x + 0.1} ${pts[0].y + 0.1}`;
  let d = `M${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i].x + pts[i + 1].x) / 2, my = (pts[i].y + pts[i + 1].y) / 2;
    d += ` Q${pts[i].x} ${pts[i].y} ${mx} ${my}`;
  }
  const l = pts[pts.length - 1];
  return d + ` L${l.x} ${l.y}`;
}

export function samplePoints(it) {
  if (it.type === 'pen' || it.type === 'hl' || it.type === 'lasso') return it.pts;
  if (it.type === 'text') return [{ x: it.x, y: it.y }, { x: it.x + it.text.length * it.size * 0.55, y: it.y + it.size }];
  const a = it.pts[0], b = it.pts[it.pts.length - 1], out = [];
  const seg = (p, q) => { for (let t = 0; t <= 1; t += 0.05) out.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t }); };
  if (it.type === 'line') seg(a, b);
  else if (it.type === 'rect') {
    const c = [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }, a];
    for (let i = 0; i < 4; i++) seg(c[i], c[i + 1]);
  } else {
    const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2, rx = Math.abs(b.x - a.x) / 2, ry = Math.abs(b.y - a.y) / 2;
    for (let t = 0; t < Math.PI * 2; t += 0.15) out.push({ x: cx + rx * Math.cos(t), y: cy + ry * Math.sin(t) });
  }
  return out;
}
export const hitsItem = (it, p, r) => samplePoints(it).some((q) => Math.hypot(q.x - p.x, q.y - p.y) <= r);

export function bbox(items, pad = 10) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  items.forEach((it) => samplePoints(it).forEach((q) => {
    x1 = Math.min(x1, q.x); y1 = Math.min(y1, q.y); x2 = Math.max(x2, q.x); y2 = Math.max(y2, q.y);
  }));
  return { x: x1 - pad, y: y1 - pad, w: x2 - x1 + pad * 2, h: y2 - y1 + pad * 2 };
}
export const inBox = (b, p) => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;

export function inPoly(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
export function lassoSelect(items, poly) {
  if (poly.length < 3) return [];
  return items.filter((it) => {
    const pts = samplePoints(it);
    return pts.filter((q) => inPoly(q, poly)).length >= pts.length * 0.5;
  }).map((it) => it.id);
}

export function moveItem(it, dx, dy) {
  if (it.type === 'text') return { ...it, x: it.x + dx, y: it.y + dy };
  return { ...it, pts: it.pts.map((q) => ({ x: q.x + dx, y: q.y + dy })) };
}
export function scaleItem(it, f, cx, cy) {
  const m = (q) => ({ x: cx + (q.x - cx) * f, y: cy + (q.y - cy) * f });
  if (it.type === 'text') { const q = m({ x: it.x, y: it.y }); return { ...it, x: q.x, y: q.y, size: it.size * f }; }
  return { ...it, pts: it.pts.map(m), width: it.width * f };
}

// ───────── Exportação ─────────
const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');

export function paperSvg(kind, w, h) {
  let o = '';
  if (kind === 'lined') {
    for (let y = 80; y < h; y += 36) o += `<line x1="0" y1="${y}" x2="${w}" y2="${y}" stroke="#C6D6E4"/>`;
    o += `<line x1="70" y1="0" x2="70" y2="${h}" stroke="#F0B8B4"/>`;
  } else if (kind === 'grid') {
    for (let x = 0; x < w; x += 30) o += `<line x1="${x}" y1="0" x2="${x}" y2="${h}" stroke="#D6E0E8"/>`;
    for (let y = 0; y < h; y += 30) o += `<line x1="0" y1="${y}" x2="${w}" y2="${y}" stroke="#D6E0E8"/>`;
  } else if (kind === 'dots') {
    for (let x = 30; x < w; x += 30) for (let y = 30; y < h; y += 30) o += `<circle cx="${x}" cy="${y}" r="1.5" fill="#AEBCC8"/>`;
  }
  return o;
}

export function itemSvg(it) {
  if (it.type === 'pen' || it.type === 'hl')
    return `<path d="${smoothPath(it.pts)}" stroke="${it.color}" stroke-width="${it.width}" stroke-opacity="${it.type === 'hl' ? 0.38 : 1}" fill="none" stroke-linecap="${it.type === 'hl' ? 'butt' : 'round'}" stroke-linejoin="round"/>`;
  if (it.type === 'text')
    return `<text x="${it.x}" y="${it.y + it.size}" fill="${it.color}" font-size="${it.size}" font-family="sans-serif">${esc(it.text)}</text>`;
  const a = it.pts[0], b = it.pts[it.pts.length - 1];
  const st = `stroke="${it.color}" stroke-width="${it.width}" fill="none"`;
  if (it.type === 'line') return `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" ${st}/>`;
  if (it.type === 'rect') return `<rect x="${Math.min(a.x, b.x)}" y="${Math.min(a.y, b.y)}" width="${Math.abs(b.x - a.x)}" height="${Math.abs(b.y - a.y)}" ${st}/>`;
  return `<ellipse cx="${(a.x + b.x) / 2}" cy="${(a.y + b.y) / 2}" rx="${Math.abs(b.x - a.x) / 2}" ry="${Math.abs(b.y - a.y) / 2}" ${st}/>`;
}

// SVG de uma página; se withPaper for falso, fica transparente (para sobrepor o PDF)
export function pageSvg(page, withPaper = true) {
  const bg = page.bg ? '' : `<rect width="100%" height="100%" fill="#fff"/>${withPaper ? paperSvg(page.paper, page.w, page.h) : ''}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${page.w}" height="${page.h}" viewBox="0 0 ${page.w} ${page.h}">${bg}${page.items.map(itemSvg).join('')}</svg>`;
}

// HTML para o expo-print: uma <div> por página, com a imagem do PDF ao fundo quando houver
export function notebookHtml(pages, images) {
  const W = pages[0].w;
  const body = pages.map((p, i) => {
    const h = Math.round(W * (p.h / p.w));
    const img = images[i] ? `<img src="data:image/jpeg;base64,${images[i]}"/>` : '';
    return `<div class="pg" style="height:${h}px">${img}${pageSvg(p)}</div>`;
  }).join('');
  return `<html><head><meta charset="utf-8"/><style>@page{margin:0}body{margin:0}
.pg{position:relative;width:${W}px;overflow:hidden;page-break-after:always}
.pg img,.pg svg{position:absolute;left:0;top:0;width:100%;height:100%}</style></head><body>${body}</body></html>`;
}

// ───────── Leitor de PDF (pdf.js dentro de uma WebView oculta) ─────────
const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174';
export const PDF_READER_HTML = `<!doctype html><html><head><meta charset="utf-8"/>
<script src="${PDFJS}/pdf.min.js"></script></head><body><script>
const post = (m) => window.ReactNativeWebView.postMessage(JSON.stringify(m));
async function run(b64) {
  try {
    if (!window.pdfjsLib) throw new Error('Sem internet para carregar o leitor de PDF.');
    const wr = await fetch('${PDFJS}/pdf.worker.min.js').then((r) => r.text());
    pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([wr], { type: 'text/javascript' }));
    const bin = atob(b64), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
    post({ t: 'count', n: pdf.numPages });
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const v1 = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: 1400 / v1.width });
      const c = document.createElement('canvas');
      c.width = vp.width; c.height = vp.height;
      await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      post({ t: 'page', i, ratio: v1.height / v1.width, data: c.toDataURL('image/jpeg', 0.82).split(',')[1] });
    }
    post({ t: 'done' });
  } catch (e) { post({ t: 'error', m: String(e && e.message || e) }); }
}
</script></body></html>`;
