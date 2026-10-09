import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, TextInput, Modal, StyleSheet, Share, Alert, Image, ActivityIndicator, ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as RNGH from 'react-native-gesture-handler';

const { Gesture, GestureDetector, PointerType } = RNGH;
// A versão 3 do Gesture Handler trocou a API de "builder" por hooks; este código aceita as duas.
const V3 = typeof RNGH.usePanGesture === 'function';
const STYLUS = PointerType ? PointerType.STYLUS : 1;
const WIDTHS = [1, 2, 3, 5, 8, 12, 16, 20];
import Svg, { Path, Line, Rect, Ellipse, Circle, G, Text as SvgText } from 'react-native-svg';
import * as FileSystem from 'expo-file-system/legacy';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import {
  C, COLORS, HL_COLORS, PAPERS, PAGE_W, PAGE_H, uid, newPage, clamp, smoothPath, hitsItem, bbox, inBox,
  lassoSelect, moveItem, scaleItem, pageSvg, notebookHtml,
} from './lib';

const INPUT_MODES = [
  { key: 'auto', label: 'Auto', hint: 'Dedo desenha até a caneta ser detectada; depois o dedo só move a página.' },
  { key: 'pen', label: 'Só caneta', hint: 'Só a caneta desenha. O dedo move a página.' },
  { key: 'both', label: 'Dedo e caneta', hint: 'Dedo e caneta desenham.' },
];

function ItemView({ it, dash, z = 1 }) {
  if (it.type === 'lasso')
    return <Path d={smoothPath(it.pts) + ' Z'} stroke={C.accent} strokeWidth={2 / z} strokeDasharray={`${8 / z},${6 / z}`} fill={C.accent} fillOpacity={0.08} />;
  if (it.type === 'pen' || it.type === 'hl')
    return <Path d={smoothPath(it.pts)} stroke={it.color} strokeWidth={it.width} strokeOpacity={it.type === 'hl' ? 0.38 : 1}
      strokeLinecap={it.type === 'hl' ? 'butt' : 'round'} strokeLinejoin="round" fill="none" />;
  if (it.type === 'text') return <SvgText x={it.x} y={it.y + it.size} fill={it.color} fontSize={it.size}>{it.text}</SvgText>;
  const a = it.pts[0], b = it.pts[it.pts.length - 1];
  const common = { stroke: it.color, strokeWidth: it.width, fill: 'none', strokeLinecap: 'round' };
  if (it.type === 'line') return <Line x1={a.x} y1={a.y} x2={b.x} y2={b.y} {...common} />;
  if (it.type === 'rect') return <Rect x={Math.min(a.x, b.x)} y={Math.min(a.y, b.y)} width={Math.abs(b.x - a.x)} height={Math.abs(b.y - a.y)} {...common} />;
  return <Ellipse cx={(a.x + b.x) / 2} cy={(a.y + b.y) / 2} rx={Math.abs(b.x - a.x) / 2} ry={Math.abs(b.y - a.y) / 2} {...common} />;
}

function Paper({ kind, w, h }) {
  const els = [];
  if (kind === 'lined') {
    for (let y = 80; y < h; y += 36) els.push(<Line key={y} x1={0} y1={y} x2={w} y2={y} stroke="#C6D6E4" strokeWidth={1} />);
    els.push(<Line key="m" x1={70} y1={0} x2={70} y2={h} stroke="#F0B8B4" strokeWidth={1} />);
  } else if (kind === 'grid') {
    for (let x = 0; x < w; x += 30) els.push(<Line key={'x' + x} x1={x} y1={0} x2={x} y2={h} stroke="#D6E0E8" strokeWidth={1} />);
    for (let y = 0; y < h; y += 30) els.push(<Line key={'y' + y} x1={0} y1={y} x2={w} y2={y} stroke="#D6E0E8" strokeWidth={1} />);
  } else if (kind === 'dots') {
    for (let x = 30; x < w; x += 30) for (let y = 30; y < h; y += 30) els.push(<Circle key={x + '-' + y} cx={x} cy={y} r={1.5} fill="#AEBCC8" />);
  }
  return <>{els}</>;
}

export default function Editor({ notebook, onChange, onBack }) {
  const [pageIdx, setPageIdx] = useState(0);
  const [tool, setTool] = useState('pen');
  const [color, setColor] = useState(COLORS[0]);
  const [hlColor, setHlColor] = useState(HL_COLORS[0]);
  const [width, setWidth] = useState(3);
  const [live, setLiveState] = useState(null);
  const [vt, setVtState] = useState({ s: 1, tx: 0, ty: 0 });
  const [viewport, setViewport] = useState({ w: 0, h: 0 });
  const [undoStack, setUndoStack] = useState([]);
  const [redoStack, setRedoStack] = useState([]);
  const [sel, setSel] = useState([]);
  const [moveOff, setMoveOff] = useState(null);
  const [inputMode, setInputMode] = useState('auto');
  const [stylusSeen, setStylusSeen] = useState(false);
  const [textAt, setTextAt] = useState(null);
  const [textValue, setTextValue] = useState('');
  const [paperModal, setPaperModal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [viewOnly, setViewOnly] = useState(false); // modo "parar de editar": só zoom e movimento

  const page = notebook.pages[pageIdx] || notebook.pages[0];

  const R = useRef({});
  R.current = { tool, color, hlColor, width, page, pageIdx, notebook, sel, inputMode, stylusSeen, onChange, viewport, viewOnly };
  const vtRef = useRef(vt);
  const liveRef = useRef(null);
  const G_ = useRef({ mode: 'none', lastStylus: 0, snap: null, cur: null, changed: false, start: null, pl: null, off: null, pinching: false }).current;

  // Aplica zoom/posição mantendo sempre um pedaço da página visível (evita "perder" a folha)
  const setView = (v) => {
    const { page: pg, viewport: vp } = R.current;
    let { s, tx, ty } = v;
    if (vp.w && vp.h) {
      const m = 80;
      tx = clamp(tx, m - pg.w * s, vp.w - m);
      ty = clamp(ty, m - pg.h * s, vp.h - m);
    }
    const next = { s, tx, ty };
    vtRef.current = next;
    setVtState(next);
  };
  const setLive = (l) => { liveRef.current = l; setLiveState(l); };

  const setItems = useCallback((items, extra = {}) => {
    const { notebook: nb, pageIdx: pi, onChange: oc } = R.current;
    const pages = nb.pages.map((p, i) => (i === pi ? { ...p, ...extra, items } : p));
    oc({ ...nb, pages, updated: Date.now() });
  }, []);

  const commit = useCallback((items) => {
    setUndoStack((s) => [...s, R.current.page.items]);
    setRedoStack([]);
    setItems(items);
  }, [setItems]);

  const fit = useCallback(() => {
    if (!viewport.w) return;
    const s = clamp((viewport.w / page.w) * 0.97, 0.2, 4);
    setView({ s, tx: (viewport.w - page.w * s) / 2, ty: 8 });
  }, [viewport.w, page.w]);

  const zoomBy = (f) => {
    const v = vtRef.current, vp = R.current.viewport;
    const cx = vp.w / 2, cy = vp.h / 2;
    const s = clamp(v.s * f, 0.2, 8);
    setView({ s, tx: cx - ((cx - v.tx) / v.s) * s, ty: cy - ((cy - v.ty) / v.s) * s });
  };

  // ── Modo visualização: zoom e movimento calculados direto dos toques ──
  const T = useRef({ prev: null, downAt: 0, downX: 0, downY: 0, maxMove: 0, lastTap: 0, lastX: 0, lastY: 0 }).current;
  const readTouches = (ev) => ev.nativeEvent.touches
    .map((p) => ({ id: p.identifier, x: p.locationX, y: p.locationY }))
    .sort((a, b) => a.id - b.id);
  const touchStart = (ev) => {
    if (!R.current.viewOnly) return;
    const cur = readTouches(ev);
    if (cur.length === 1) { T.downAt = Date.now(); T.downX = cur[0].x; T.downY = cur[0].y; T.maxMove = 0; }
    else T.maxMove = 999; // com 2+ dedos nunca é "toque"
    T.prev = cur;
  };
  const touchMove = (ev) => {
    if (!R.current.viewOnly) return;
    const cur = readTouches(ev), prev = T.prev;
    T.prev = cur;
    if (!prev || prev.length !== cur.length || prev.some((p, i) => p.id !== cur[i].id)) return;
    const v = vtRef.current;
    if (cur.length === 1) {
      T.maxMove = Math.max(T.maxMove, Math.hypot(cur[0].x - T.downX, cur[0].y - T.downY));
      setView({ ...v, tx: v.tx + cur[0].x - prev[0].x, ty: v.ty + cur[0].y - prev[0].y });
      return;
    }
    const [a, b] = cur, [pa, pb] = prev;
    const d = Math.hypot(a.x - b.x, a.y - b.y), pd = Math.hypot(pa.x - pb.x, pa.y - pb.y);
    if (!pd || !d) return;
    const s = clamp(v.s * (d / pd), 0.2, 8), k = s / v.s;
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, pmx = (pa.x + pb.x) / 2, pmy = (pa.y + pb.y) / 2;
    // o ponto da página sob o meio dos dedos continua sob o meio dos dedos
    setView({ s, tx: mx - (pmx - v.tx) * k, ty: my - (pmy - v.ty) * k });
  };
  const touchEnd = (ev) => {
    if (!R.current.viewOnly) return;
    const rest = readTouches(ev);
    T.prev = rest.length ? rest : null;
    if (rest.length) return;
    const now = Date.now();
    if (T.maxMove < 10 && now - T.downAt < 250) { // foi um toque rápido
      if (now - T.lastTap < 320 && Math.hypot(T.downX - T.lastX, T.downY - T.lastY) < 40) {
        T.lastTap = 0; // toque duplo: amplia no ponto tocado ou volta ao ajuste
        const v = vtRef.current, vp = R.current.viewport, pg = R.current.page;
        const base = clamp((vp.w / pg.w) * 0.97, 0.2, 4);
        if (v.s > base * 1.4) fit();
        else {
          const s = clamp(base * 2.5, 0.2, 8);
          setView({ s, tx: T.downX - ((T.downX - v.tx) / v.s) * s, ty: T.downY - ((T.downY - v.ty) / v.s) * s });
        }
      } else { T.lastTap = now; T.lastX = T.downX; T.lastY = T.downY; }
    }
  };
  const toggleView = () => {
    G_.mode = 'none'; G_.pinching = false; G_.pl = null; T.prev = null;
    setLive(null); setMoveOff(null); setSel([]); setTextAt(null);
    setViewOnly((v) => !v);
  };

  useEffect(() => { fit(); }, [fit, pageIdx]);
  useEffect(() => { setUndoStack([]); setRedoStack([]); setSel([]); }, [pageIdx]);

  const undo = () => {
    if (!undoStack.length) return;
    setRedoStack((s) => [...s, page.items]);
    setItems(undoStack[undoStack.length - 1]);
    setUndoStack((s) => s.slice(0, -1)); setSel([]);
  };
  const redo = () => {
    if (!redoStack.length) return;
    setUndoStack((s) => [...s, page.items]);
    setItems(redoStack[redoStack.length - 1]);
    setRedoStack((s) => s.slice(0, -1)); setSel([]);
  };

  const toDoc = (x, y) => { const v = vtRef.current; return { x: (x - v.tx) / v.s, y: (y - v.ty) / v.s }; };

  const eraseAt = (p) => {
    const r = 16 / vtRef.current.s;
    const keep = G_.cur.filter((it) => !hitsItem(it, p, r));
    if (keep.length !== G_.cur.length) { G_.cur = keep; G_.changed = true; setItems(keep); }
  };

  // Callbacks de toque (compartilhados entre as duas versões do Gesture Handler)
  const cb = {
    begin: (ev) => {
      const r = R.current;
      if (G_.pinching && ev.pointerType !== STYLUS) { G_.mode = 'ignore'; return; }
      const stylus = ev.pointerType === STYLUS;
      const now = Date.now();
      G_.mode = 'none';
      if (stylus) { G_.lastStylus = now; if (!r.stylusSeen) setStylusSeen(true); }
      else if (now - G_.lastStylus < 800) { G_.mode = 'ignore'; return; } // rejeição de palma
      if (r.tool === 'hand') { G_.mode = 'scroll'; return; } // ferramenta Mover
      const touchDraws = r.inputMode === 'both' || (r.inputMode === 'auto' && !r.stylusSeen);
      if (!stylus && !touchDraws) { G_.mode = 'scroll'; return; }
      const p = toDoc(ev.x, ev.y);
      const t = r.tool;
      if (t === 'text') { G_.mode = 'text'; G_.start = p; return; }
      if (t === 'eraser') { G_.mode = 'erase'; G_.cur = r.page.items; G_.snap = r.page.items; G_.changed = false; eraseAt(p); return; }
      if (t === 'lasso') {
        if (r.sel.length) {
          const bb = bbox(r.page.items.filter((i) => r.sel.includes(i.id)));
          if (inBox(bb, p)) { G_.mode = 'move'; G_.start = p; G_.off = null; return; }
        }
        setSel([]); G_.mode = 'lasso'; setLive({ id: 'lasso', type: 'lasso', pts: [p] }); return;
      }
      G_.mode = 'draw';
      const hl = t === 'hl';
      setLive({ id: uid(), type: t, color: hl ? r.hlColor : r.color, width: hl ? Math.max(r.width * 4, 14) : r.width, pts: [p] });
    },
    update: (ev) => {
      if (ev.pointerType === STYLUS) G_.lastStylus = Date.now();
      // Com 2 ou mais dedos quem manda é o pinch; o pan para na hora, senão o centro
      // dos dedos "salta" quando o segundo dedo encosta e a página vai para outro lugar.
      if ((G_.pinching && ev.pointerType !== STYLUS) || (ev.numberOfPointers || 1) > 1) {
        if (G_.mode !== 'erase' && G_.mode !== 'ignore') {
          G_.mode = 'ignore'; G_.off = null; setLive(null); setMoveOff(null);
        }
        return;
      }
      const m = G_.mode;
      if (m === 'scroll') { const v = vtRef.current; setView({ ...v, tx: v.tx + (ev.changeX || 0), ty: v.ty + (ev.changeY || 0) }); return; }
      if (m === 'none' || m === 'ignore' || m === 'text') return;
      const p = toDoc(ev.x, ev.y);
      if (m === 'erase') { eraseAt(p); return; }
      if (m === 'move') { G_.off = { dx: p.x - G_.start.x, dy: p.y - G_.start.y }; setMoveOff(G_.off); return; }
      const l = liveRef.current;
      if (!l) return;
      if (l.type === 'pen' || l.type === 'hl' || l.type === 'lasso') {
        const last = l.pts[l.pts.length - 1];
        if (Math.hypot(last.x - p.x, last.y - p.y) < 1.2 / vtRef.current.s) return;
        setLive({ ...l, pts: [...l.pts, p] });
      } else setLive({ ...l, pts: [l.pts[0], p] });
    },
    finalize: (ev, success) => {
      // v2 manda "success"; v3 manda ev.canceled
      const ok = typeof success === 'boolean' ? success : !(ev && ev.canceled);
      const m = G_.mode, r = R.current, l = liveRef.current, off = G_.off;
      G_.mode = 'none'; G_.off = null;
      setLive(null); setMoveOff(null);
      if (m === 'erase') {
        if (G_.changed) { setUndoStack((s) => [...s, G_.snap]); setRedoStack([]); }
        return;
      }
      if (!ok) return; // gesto cancelado (ex.: segundo dedo entrou)
      if (m === 'draw' && l) {
        if (l.pts.length > 1 || l.type === 'pen' || l.type === 'hl') commit([...r.page.items, l]);
      } else if (m === 'lasso' && l) {
        setSel(lassoSelect(r.page.items, l.pts));
      } else if (m === 'move' && off) {
        commit(r.page.items.map((it) => (r.sel.includes(it.id) ? moveItem(it, off.dx, off.dy) : it)));
      } else if (m === 'text' && G_.start) {
        setTextAt(G_.start); setTextValue('');
      }
    },
    pinchStart: () => {
      G_.pinching = true; G_.pl = null;
      if (G_.mode !== 'erase') { G_.mode = 'ignore'; setLive(null); setMoveOff(null); }
    },
    pinchUpdate: (ev) => {
      G_.pinching = true;
      const cur = { sc: ev.scale || 1, fx: ev.focalX, fy: ev.focalY };
      const prev = G_.pl; G_.pl = cur;
      if (!prev) return;
      const ratio = cur.sc / prev.sc;
      if (!isFinite(ratio) || ratio <= 0) return;
      const v = vtRef.current;
      const s = clamp(v.s * ratio, 0.2, 8);
      const k = s / v.s;
      // Se o foco "saltar" de repente (dedo extra/palma), não arrasta a página junto
      const jumped = Math.hypot(cur.fx - prev.fx, cur.fy - prev.fy) > 100;
      const px = jumped ? cur.fx : prev.fx, py = jumped ? cur.fy : prev.fy;
      // O ponto da página que estava sob o foco anterior passa a ficar sob o foco atual
      setView({ s, tx: cur.fx - (px - v.tx) * k, ty: cur.fy - (py - v.ty) * k });
    },
    pinchFinalize: () => { G_.pinching = false; G_.pl = null; },
  };

  let gesture;
  if (V3) {
    // V3 é uma constante de módulo, então a ordem dos hooks nunca muda entre renders.
    const draw = RNGH.usePanGesture({ runOnJS: true, enabled: !viewOnly, minDistance: 0, maxPointers: 1, onBegin: cb.begin, onUpdate: cb.update, onFinalize: cb.finalize });
    const pinch = RNGH.usePinchGesture({ runOnJS: true, enabled: !viewOnly, onActivate: cb.pinchStart, onUpdate: cb.pinchUpdate, onFinalize: cb.pinchFinalize });
    gesture = RNGH.useSimultaneousGestures(draw, pinch);
  } else {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    gesture = useMemo(() => {
      const draw = Gesture.Pan().runOnJS(true).enabled(!viewOnly).minDistance(0).maxPointers(1)
        .onBegin(cb.begin).onUpdate(cb.update).onFinalize(cb.finalize);
      const pinch = Gesture.Pinch().runOnJS(true).enabled(!viewOnly).onStart(cb.pinchStart).onUpdate(cb.pinchUpdate).onFinalize(cb.pinchFinalize);
      return Gesture.Simultaneous(draw, pinch);
    }, [viewOnly]);
  }

  // ── ações ──
  const addText = () => {
    if (textValue.trim() && textAt)
      commit([...page.items, { id: uid(), type: 'text', x: textAt.x, y: textAt.y, text: textValue.trim(), color, size: 18 + width * 2 }]);
    setTextAt(null);
  };
  const addPage = () => {
    const pages = [...notebook.pages, newPage(page.bg ? 'lined' : page.paper)];
    onChange({ ...notebook, pages, updated: Date.now() });
    setPageIdx(pages.length - 1);
  };
  const deletePage = () => {
    if (notebook.pages.length === 1) return Alert.alert('Não é possível excluir', 'O caderno precisa ter pelo menos uma página.');
    Alert.alert('Excluir página?', 'Esta ação não pode ser desfeita.', [
      { text: 'Cancelar', style: 'cancel' },
      { text: 'Excluir', style: 'destructive', onPress: () => {
        onChange({ ...notebook, pages: notebook.pages.filter((_, i) => i !== pageIdx), updated: Date.now() });
        setPageIdx(Math.max(0, pageIdx - 1));
      } },
    ]);
  };
  const clearPage = () => Alert.alert('Limpar página?', 'Todos os traços serão removidos.', [
    { text: 'Cancelar', style: 'cancel' }, { text: 'Limpar', style: 'destructive', onPress: () => commit([]) },
  ]);
  const safeName = () => (notebook.title.replace(/[^\w\-]+/g, '_').replace(/^_+|_+$/g, '') || 'caderno');
  // Salva o arquivo na pasta do app e compartilha a partir dela (o Expo Go não deixa
  // compartilhar arquivos do cache; assim funciona no Expo Go e no APK).
  const exportSvg = async () => {
    try {
      const uri = `${FileSystem.documentDirectory}${safeName()}_pagina${pageIdx + 1}.svg`;
      await FileSystem.writeAsStringAsync(uri, pageSvg(page));
      await Sharing.shareAsync(uri, { mimeType: 'image/svg+xml', dialogTitle: notebook.title });
    } catch (err) {
      Alert.alert('Não foi possível exportar', String(err.message || err));
    }
  };
  const exportPdf = async () => {
    try {
      setBusy(true);
      const images = [];
      for (const p of notebook.pages)
        images.push(p.bg ? await FileSystem.readAsStringAsync(p.bg, { encoding: 'base64' }) : null);
      const first = notebook.pages[0];
      const { base64 } = await Print.printToFileAsync({
        html: notebookHtml(notebook.pages, images), width: first.w, height: Math.round(first.h), base64: true,
      });
      const uri = `${FileSystem.documentDirectory}${safeName()}.pdf`;
      await FileSystem.writeAsStringAsync(uri, base64, { encoding: 'base64' });
      await Sharing.shareAsync(uri, { mimeType: 'application/pdf', UTI: 'com.adobe.pdf', dialogTitle: notebook.title });
    } catch (e) {
      Alert.alert('Não foi possível exportar', String(e.message || e));
    } finally { setBusy(false); }
  };

  const selItems = page.items.filter((i) => sel.includes(i.id));
  const selBox = selItems.length ? bbox(selItems) : null;
  const duplicateSel = () => {
    const copies = selItems.map((it) => ({ ...moveItem(it, 30, 30), id: uid() }));
    commit([...page.items, ...copies]); setSel(copies.map((c) => c.id));
  };
  const scaleSel = (f) => {
    if (!selBox) return;
    const cx = selBox.x + selBox.w / 2, cy = selBox.y + selBox.h / 2;
    commit(page.items.map((it) => (sel.includes(it.id) ? scaleItem(it, f, cx, cy) : it)));
  };
  const deleteSel = () => { commit(page.items.filter((i) => !sel.includes(i.id))); setSel([]); };
  const recolorSel = () => commit(page.items.map((it) => (sel.includes(it.id) && it.type !== 'hl' ? { ...it, color } : it)));

  // camadas
  const rest = useMemo(() => page.items.filter((i) => !sel.includes(i.id)), [page.items, sel]);
  const layerRest = useMemo(() => rest.map((it) => <ItemView key={it.id} it={it} />), [rest]);
  const layerPaper = useMemo(() => (page.bg ? null : <Paper kind={page.paper} w={page.w} h={page.h} />), [page.bg, page.paper, page.w, page.h]);

  const modeInfo = INPUT_MODES.find((m) => m.key === inputMode);
  const cycleMode = () => {
    const next = INPUT_MODES[(INPUT_MODES.findIndex((m) => m.key === inputMode) + 1) % INPUT_MODES.length];
    setInputMode(next.key);
    Alert.alert(`Entrada: ${next.label}`, next.hint);
  };

  const Tool = ({ id, label }) => (
    <TouchableOpacity onPress={() => { setTool(id); if (id !== 'lasso') setSel([]); }} style={[s.tool, tool === id && s.toolOn]}>
      <Text style={[s.toolTxt, tool === id && { color: '#fff' }]}>{label}</Text>
    </TouchableOpacity>
  );
  const palette = tool === 'hl' ? HL_COLORS : COLORS;
  const showColors = !['eraser', 'lasso', 'hand'].includes(tool);
  const showWidth = !['eraser', 'lasso', 'hand'].includes(tool);
  const activeColor = tool === 'hl' ? hlColor : color;
  const off = moveOff || { dx: 0, dy: 0 };

  return (
    <SafeAreaView style={s.screen}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.hscroll} contentContainerStyle={s.topbar} keyboardShouldPersistTaps="handled">
        <TouchableOpacity onPress={onBack} style={s.iconBtn}><Text style={s.iconTxt}>Voltar</Text></TouchableOpacity>
        <Text style={s.topTitle} numberOfLines={1}>{notebook.title}</Text>
        {!viewOnly && (
          <>
            <TouchableOpacity onPress={undo} style={[s.iconBtn, !undoStack.length && s.dim]}><Text style={s.iconTxt}>Desfazer</Text></TouchableOpacity>
            <TouchableOpacity onPress={redo} style={[s.iconBtn, !redoStack.length && s.dim]}><Text style={s.iconTxt}>Refazer</Text></TouchableOpacity>
          </>
        )}
      </ScrollView>

      {!viewOnly && (
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.hscroll} contentContainerStyle={s.toolbar}>
        <Tool id="hand" label="Mover" /><Tool id="pen" label="Caneta" /><Tool id="hl" label="Marca-texto" />
        <Tool id="eraser" label="Borracha" /><Tool id="lasso" label="Laço" /><Tool id="line" label="Linha" />
        <Tool id="rect" label="Retângulo" /><Tool id="ellipse" label="Elipse" /><Tool id="text" label="Texto" />
      </ScrollView>
      )}

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.hscroll} contentContainerStyle={s.optbar} keyboardShouldPersistTaps="handled">
        {viewOnly ? (
          <Text style={s.selTxt}>Visualizando · 1 dedo move · 2 dedos dão zoom · toque duplo amplia</Text>
        ) : sel.length > 0 ? (
          <>
            <Text style={s.selTxt}>{sel.length} selecionado(s)</Text>
            <TouchableOpacity onPress={duplicateSel} style={s.pill}><Text style={s.pillTxt}>Duplicar</Text></TouchableOpacity>
            <TouchableOpacity onPress={() => scaleSel(1.15)} style={s.pill}><Text style={s.pillTxt}>Maior</Text></TouchableOpacity>
            <TouchableOpacity onPress={() => scaleSel(0.87)} style={s.pill}><Text style={s.pillTxt}>Menor</Text></TouchableOpacity>
            <TouchableOpacity onPress={recolorSel} style={s.pill}><Text style={s.pillTxt}>Pintar</Text></TouchableOpacity>
            <TouchableOpacity onPress={deleteSel} style={[s.pill, { backgroundColor: C.danger }]}><Text style={[s.pillTxt, { color: '#fff' }]}>Excluir</Text></TouchableOpacity>
          </>
        ) : (
          <>
            <TouchableOpacity onPress={cycleMode} style={s.pill}><Text style={s.pillTxt}>Entrada: {modeInfo.label}{stylusSeen ? ' ●' : ''}</Text></TouchableOpacity>
            {showColors && palette.map((c) => (
              <TouchableOpacity key={c} onPress={() => (tool === 'hl' ? setHlColor(c) : setColor(c))}
                style={[s.swatch, { backgroundColor: c }, activeColor === c && s.swatchOn]} />
            ))}
            {showColors && <View style={s.sep} />}
            {showWidth && (
              <>
                <TouchableOpacity onPress={() => setWidth((w) => Math.max(1, w - 1))} style={s.step}><Text style={s.stepTxt}>−</Text></TouchableOpacity>
                {WIDTHS.map((w) => (
                  <TouchableOpacity key={w} onPress={() => setWidth(w)} style={[s.wChip, width === w && s.wChipOn]}>
                    <View style={{ width: w + 2, height: w + 2, borderRadius: (w + 2) / 2, backgroundColor: width === w ? '#fff' : C.ink }} />
                  </TouchableOpacity>
                ))}
                <TouchableOpacity onPress={() => setWidth((w) => Math.min(24, w + 1))} style={s.step}><Text style={s.stepTxt}>+</Text></TouchableOpacity>
                <Text style={s.widthTxt}>{width}px</Text>
                <View style={s.sep} />
              </>
            )}
          </>
        )}
        <TouchableOpacity onPress={() => zoomBy(1 / 1.3)} style={s.step}><Text style={s.stepTxt}>−</Text></TouchableOpacity>
        <TouchableOpacity onPress={fit} style={s.pill}><Text style={s.pillTxt}>{Math.round(vt.s * 100)}% · ajustar</Text></TouchableOpacity>
        <TouchableOpacity onPress={() => zoomBy(1.3)} style={s.step}><Text style={s.stepTxt}>+</Text></TouchableOpacity>
      </ScrollView>

      <View style={{ flex: 1 }}>
      <GestureDetector gesture={gesture}>
        <View style={s.viewport} onLayout={(e) => setViewport({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}
          onTouchStart={touchStart} onTouchMove={touchMove} onTouchEnd={touchEnd} onTouchCancel={touchEnd}>
          <View pointerEvents="none" style={{
            position: 'absolute', left: 0, top: 0, width: page.w, height: page.h, backgroundColor: '#fff',
            transformOrigin: 'top left', transform: [{ translateX: vt.tx }, { translateY: vt.ty }, { scale: vt.s }],
          }}>
            {page.bg ? <Image source={{ uri: page.bg }} style={{ position: 'absolute', width: page.w, height: page.h }} /> : null}
            <Svg width={page.w} height={page.h} style={StyleSheet.absoluteFill} pointerEvents="none">
              {layerPaper}
              {layerRest}
              <G x={off.dx} y={off.dy}>
                {selItems.map((it) => <ItemView key={it.id} it={it} />)}
              </G>
              {selBox && (
                <Rect x={selBox.x + off.dx} y={selBox.y + off.dy} width={selBox.w} height={selBox.h}
                  stroke={C.accent} strokeWidth={1.5 / vt.s} strokeDasharray={`${6 / vt.s},${4 / vt.s}`} fill="none" />
              )}
              {live && <ItemView it={live} z={vt.s} />}
            </Svg>
          </View>
        </View>
      </GestureDetector>
        <TouchableOpacity onPress={toggleView} activeOpacity={0.85} style={[s.fab, viewOnly && s.fabOn]}>
          <Text style={[s.fabTxt, viewOnly && { color: '#fff' }]}>{viewOnly ? 'Voltar a editar' : 'Parar de editar'}</Text>
        </TouchableOpacity>
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.hscroll} contentContainerStyle={s.pagebar}>
        <TouchableOpacity disabled={pageIdx === 0} onPress={() => setPageIdx(pageIdx - 1)} style={[s.iconBtn, pageIdx === 0 && s.dim]}><Text style={s.iconTxt}>Anterior</Text></TouchableOpacity>
        <Text style={s.pageNum}>{pageIdx + 1} de {notebook.pages.length}</Text>
        <TouchableOpacity disabled={pageIdx >= notebook.pages.length - 1} onPress={() => setPageIdx(pageIdx + 1)} style={[s.iconBtn, pageIdx >= notebook.pages.length - 1 && s.dim]}><Text style={s.iconTxt}>Próxima</Text></TouchableOpacity>
        <TouchableOpacity onPress={addPage} style={s.iconBtn}><Text style={s.iconTxt}>Nova página</Text></TouchableOpacity>
        {!page.bg && <TouchableOpacity onPress={() => setPaperModal(true)} style={s.iconBtn}><Text style={s.iconTxt}>Papel</Text></TouchableOpacity>}
        <TouchableOpacity onPress={() => Alert.alert('Mais opções', undefined, [
          { text: 'Exportar caderno em PDF', onPress: exportPdf },
          { text: 'Exportar página em SVG', onPress: exportSvg },
          { text: 'Limpar página', onPress: clearPage },
          { text: 'Excluir página', style: 'destructive', onPress: deletePage },
          { text: 'Cancelar', style: 'cancel' },
        ])} style={s.iconBtn}><Text style={s.iconTxt}>Mais</Text></TouchableOpacity>
      </ScrollView>

      <Modal visible={!!textAt} transparent animationType="fade" onRequestClose={() => setTextAt(null)}>
        <View style={s.modalBg}><View style={s.modal}>
          <Text style={s.modalTitle}>Adicionar texto</Text>
          <TextInput autoFocus value={textValue} onChangeText={setTextValue} placeholder="Digite sua anotação" style={s.input} multiline />
          <View style={s.row}>
            <TouchableOpacity onPress={() => setTextAt(null)} style={s.btnGhost}><Text style={s.btnGhostTxt}>Cancelar</Text></TouchableOpacity>
            <TouchableOpacity onPress={addText} style={s.btn}><Text style={s.btnTxt}>Inserir</Text></TouchableOpacity>
          </View>
        </View></View>
      </Modal>

      <Modal visible={paperModal} transparent animationType="fade" onRequestClose={() => setPaperModal(false)}>
        <View style={s.modalBg}><View style={s.modal}>
          <Text style={s.modalTitle}>Tipo de papel</Text>
          {PAPERS.map((p) => (
            <TouchableOpacity key={p.key} style={[s.paperOpt, page.paper === p.key && s.paperOptOn]}
              onPress={() => { setItems(page.items, { paper: p.key }); setPaperModal(false); }}>
              <Text style={s.paperTxt}>{p.label}</Text>
            </TouchableOpacity>
          ))}
        </View></View>
      </Modal>

      {busy && (
        <View style={s.busy}><ActivityIndicator color="#fff" size="large" /><Text style={s.busyTxt}>Gerando PDF…</Text></View>
      )}
    </SafeAreaView>
  );
}

export const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  topbar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 6, paddingVertical: 4 },
  topTitle: { minWidth: 60, maxWidth: 190, fontSize: 16, fontWeight: '700', color: C.ink, textAlign: 'center', marginHorizontal: 8 },
  iconBtn: { paddingHorizontal: 8, paddingVertical: 8, borderRadius: 8 },
  iconTxt: { color: C.accent, fontWeight: '600', fontSize: 13 },
  dim: { opacity: 0.35 },
  hscroll: { flexGrow: 0, flexShrink: 0 },
  toolbar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, gap: 6 },
  tool: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 18, backgroundColor: '#fff', borderWidth: 1, borderColor: C.line },
  toolOn: { backgroundColor: C.accent, borderColor: C.accent },
  toolTxt: { color: C.ink, fontSize: 13, fontWeight: '600' },
  optbar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8, gap: 8, minHeight: 50 },
  selTxt: { color: C.ink, fontWeight: '700' },
  pill: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 16, backgroundColor: '#fff', borderWidth: 1, borderColor: C.line },
  pillTxt: { color: C.ink, fontWeight: '600', fontSize: 13 },
  fab: { position: 'absolute', top: 12, right: 12, paddingHorizontal: 16, paddingVertical: 11, borderRadius: 24, backgroundColor: '#fff',
    borderWidth: 2, borderColor: C.accent, elevation: 8, shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 6, shadowOffset: { width: 0, height: 2 } },
  fabOn: { backgroundColor: C.accent },
  fabTxt: { color: C.accent, fontWeight: '800', fontSize: 14 },
  modeBtn: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 16, borderWidth: 1, borderColor: C.accent, marginLeft: 4 },
  modeBtnOn: { backgroundColor: C.accent },
  modeTxt: { color: C.accent, fontWeight: '700', fontSize: 13 },
  sep: { width: 1, height: 24, backgroundColor: C.line, marginHorizontal: 2 },
  wChip: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff', borderWidth: 1, borderColor: C.line },
  wChipOn: { backgroundColor: C.accent, borderColor: C.accent },
  swatch: { width: 26, height: 26, borderRadius: 13, borderWidth: 2, borderColor: 'transparent' },
  swatchOn: { borderColor: C.ink, transform: [{ scale: 1.15 }] },
  step: { width: 32, height: 32, borderRadius: 16, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: C.line },
  stepTxt: { fontSize: 18, color: C.ink, fontWeight: '700' },
  widthTxt: { minWidth: 36, textAlign: 'center', color: C.ink, fontWeight: '600' },
  viewport: { flex: 1, overflow: 'hidden', backgroundColor: '#CBD4DC' },
  pagebar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 4, paddingVertical: 4, gap: 2 },
  pageNum: { color: C.muted, fontWeight: '600', marginHorizontal: 4 },
  input: { backgroundColor: '#fff', borderRadius: 8, borderWidth: 1, borderColor: C.line, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, color: C.ink },
  btn: { backgroundColor: C.accent, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8 },
  btnTxt: { color: '#fff', fontWeight: '700' },
  btnGhost: { paddingHorizontal: 16, paddingVertical: 10 },
  btnGhostTxt: { color: C.muted, fontWeight: '700' },
  row: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 8, marginTop: 12 },
  modalBg: { flex: 1, backgroundColor: 'rgba(23,33,43,0.45)', justifyContent: 'center', padding: 24 },
  modal: { backgroundColor: '#fff', borderRadius: 12, padding: 18 },
  modalTitle: { fontSize: 18, fontWeight: '800', color: C.ink, marginBottom: 12 },
  paperOpt: { padding: 14, borderRadius: 8, borderWidth: 1, borderColor: C.line, marginBottom: 8 },
  paperOptOn: { backgroundColor: C.accentSoft, borderColor: C.accent },
  paperTxt: { color: C.ink, fontWeight: '600' },
  busy: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(23,33,43,0.6)', alignItems: 'center', justifyContent: 'center', gap: 12 },
  busyTxt: { color: '#fff', fontWeight: '700' },
});
