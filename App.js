import 'react-native-gesture-handler';
import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, FlatList, TextInput, Modal, StyleSheet, Alert,
  BackHandler, ActivityIndicator,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { StatusBar } from 'expo-status-bar';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import Editor from './Editor';
import PdfImporter from './PdfImporter';
import { C, NB_COLORS, PAGE_W, uid, newPage } from './lib';

// Mostra no terminal de onde vem cada erro (ajuda a diagnosticar)
if (global.ErrorUtils) {
  const prev = global.ErrorUtils.getGlobalHandler();
  global.ErrorUtils.setGlobalHandler((err, fatal) => {
    console.log('ERRO GLOBAL:', err && err.message, '\n', err && err.stack);
    prev(err, fatal);
  });
}

const DATA_FILE = FileSystem.documentDirectory + 'notas-data.json';

// No Expo Go o arquivo escolhido fica numa pasta que o FileSystem não pode ler;
// o fetch lê qualquer file:// e não depende dessa permissão.
async function readFileBase64(uri) {
  try {
    return await FileSystem.readAsStringAsync(uri, { encoding: 'base64' });
  } catch (err) {
    const blob = await (await fetch(uri)).blob();
    return await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result).split(',')[1]);
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(blob);
    });
  }
}

export default function App() {
  const [data, setData] = useState({ folders: [], notebooks: [] });
  const [loaded, setLoaded] = useState(false);
  const [openId, setOpenId] = useState(null);
  const [folderId, setFolderId] = useState(null);
  const [job, setJob] = useState(null); // importação de PDF em andamento
  const jobRef = useRef(null);
  const saveTimer = useRef(null);

  useEffect(() => {
    FileSystem.readAsStringAsync(DATA_FILE)
      .then((raw) => { try { setData(JSON.parse(raw)); } catch (e) {} })
      .catch(() => {}) // primeira abertura: ainda não existe arquivo
      .finally(() => setLoaded(true));
  }, []);

  useEffect(() => {
    if (!loaded) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => FileSystem.writeAsStringAsync(DATA_FILE, JSON.stringify(data)).catch(() => {}), 400);
  }, [data, loaded]);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (openId) { setOpenId(null); return true; }
      if (folderId) { setFolderId(data.folders.find((f) => f.id === folderId)?.parentId ?? null); return true; }
      return false;
    });
    return () => sub.remove();
  }, [openId, folderId, data.folders]);

  const setNotebooks = (fn) => setData((d) => ({ ...d, notebooks: fn(d.notebooks) }));
  const setFolders = (fn) => setData((d) => ({ ...d, folders: fn(d.folders) }));

  const createNotebook = (title, color) => {
    const nb = { id: uid(), title, color, folderId, pages: [newPage()], updated: Date.now() };
    setNotebooks((n) => [nb, ...n]);
    setOpenId(nb.id);
  };
  const createFolder = (title) => setFolders((f) => [...f, { id: uid(), title, parentId: folderId }]);
  const rename = (kind, id, title, color) => {
    if (kind === 'folder') setFolders((f) => f.map((x) => (x.id === id ? { ...x, title } : x)));
    else setNotebooks((n) => n.map((x) => (x.id === id ? { ...x, title, color } : x)));
  };
  const move = (nbId, target) => setNotebooks((n) => n.map((x) => (x.id === nbId ? { ...x, folderId: target } : x)));

  const deleteImages = (nbs) => nbs.forEach((nb) => nb.pages.forEach((p) => p.bg && FileSystem.deleteAsync(p.bg, { idempotent: true }).catch(() => {})));
  const removeNotebook = (id) => {
    setData((d) => { deleteImages(d.notebooks.filter((n) => n.id === id)); return { ...d, notebooks: d.notebooks.filter((n) => n.id !== id) }; });
  };
  const removeFolder = (id) => {
    setData((d) => {
      const ids = new Set([id]);
      let grew = true;
      while (grew) { grew = false; d.folders.forEach((f) => { if (ids.has(f.parentId) && !ids.has(f.id)) { ids.add(f.id); grew = true; } }); }
      deleteImages(d.notebooks.filter((n) => ids.has(n.folderId)));
      return { folders: d.folders.filter((f) => !ids.has(f.id)), notebooks: d.notebooks.filter((n) => !ids.has(n.folderId)) };
    });
  };
  const update = useCallback((nb) => setNotebooks((n) => n.map((x) => (x.id === nb.id ? nb : x))), []);

  // ── Importar PDF ──
  const importPdf = async () => {
    try {
      const res = await DocumentPicker.getDocumentAsync({ type: 'application/pdf', copyToCacheDirectory: true });
      if (res.canceled) return;
      const asset = res.assets[0];
      const b64 = await readFileBase64(asset.uri);
      if (b64.length > 45 * 1024 * 1024) return Alert.alert('PDF muito grande', 'Escolha um arquivo de até ~30 MB.');
      const id = uid();
      jobRef.current = { id, writes: [], pages: [] };
      setJob({ b64, name: asset.name.replace(/\.pdf$/i, ''), done: 0, total: 0 });
    } catch (e) { Alert.alert('Erro ao abrir o PDF', String(e.message || e)); }
  };
  const jobCount = (n) => setJob((j) => j && { ...j, total: n });
  const jobPage = (i, ratio, b64) => {
    try {
    const jr = jobRef.current;
    const uri = `${FileSystem.documentDirectory}pdf_${jr.id}_${i}.jpg`;
    jr.pages[i - 1] = { id: uid(), paper: 'blank', w: PAGE_W, h: Math.round(PAGE_W * ratio), bg: uri, items: [] };
    jr.writes.push(FileSystem.writeAsStringAsync(uri, b64, { encoding: 'base64' }));
    setJob((j) => j && { ...j, done: i });
    } catch (e) { console.log('Erro em jobPage:', e && e.stack); jobError(String(e && e.message || e)); }
  };
  const jobDone = async () => {
    const jr = jobRef.current, name = job.name;
    await Promise.all(jr.writes);
    const nb = { id: uid(), title: name, color: NB_COLORS[1], folderId, pages: jr.pages, updated: Date.now() };
    setNotebooks((n) => [nb, ...n]);
    setJob(null); jobRef.current = null; setOpenId(nb.id);
  };
  const jobError = (msg) => { setJob(null); Alert.alert('Não foi possível importar o PDF', msg); };

  const current = data.notebooks.find((n) => n.id === openId);

  return (
    <SafeAreaProvider>
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: C.bg }}>
      <StatusBar style="dark" />
      {current ? (
        <Editor key={current.id} notebook={current} onChange={update} onBack={() => setOpenId(null)} />
      ) : (
        <Home
          data={data} folderId={folderId} setFolderId={setFolderId} onOpen={setOpenId}
          onCreateNotebook={createNotebook} onCreateFolder={createFolder} onImport={importPdf}
          onRename={rename} onMove={move} onDeleteNotebook={removeNotebook} onDeleteFolder={removeFolder}
        />
      )}
      {job && (
        <>
          <PdfImporter b64={job.b64} onCount={jobCount} onPage={jobPage} onDone={jobDone} onError={jobError} />
          <View style={s.busy}>
            <ActivityIndicator color="#fff" size="large" />
            <Text style={s.busyTxt}>Importando “{job.name}”</Text>
            <Text style={s.busyTxt}>{job.total ? `Página ${job.done} de ${job.total}` : 'Preparando…'}</Text>
          </View>
        </>
      )}
    </GestureHandlerRootView>
    </SafeAreaProvider>
  );
}

function Home({ data, folderId, setFolderId, onOpen, onCreateNotebook, onCreateFolder, onImport, onRename, onMove, onDeleteNotebook, onDeleteFolder }) {
  const [query, setQuery] = useState('');
  const [modal, setModal] = useState(null); // {mode:'newNb'|'newFolder'|'rename', kind?, id?}
  const [title, setTitle] = useState('');
  const [nbColor, setNbColor] = useState(NB_COLORS[0]);
  const [moving, setMoving] = useState(null);

  const q = query.trim().toLowerCase();
  const folder = data.folders.find((f) => f.id === folderId);

  let entries;
  if (q) {
    entries = data.notebooks
      .filter((n) => n.title.toLowerCase().includes(q) || n.pages.some((p) => p.items.some((i) => i.type === 'text' && i.text.toLowerCase().includes(q))))
      .map((n) => ({ kind: 'nb', item: n }));
  } else {
    entries = [
      ...data.folders.filter((f) => (f.parentId ?? null) === folderId).map((f) => ({ kind: 'folder', item: f })),
      ...data.notebooks.filter((n) => (n.folderId ?? null) === folderId).sort((a, b) => b.updated - a.updated).map((n) => ({ kind: 'nb', item: n })),
    ];
  }

  const save = () => {
    const t = title.trim() || 'Sem título';
    if (modal.mode === 'newNb') onCreateNotebook(t, nbColor);
    else if (modal.mode === 'newFolder') onCreateFolder(t);
    else onRename(modal.kind, modal.id, t, nbColor);
    setModal(null);
  };
  const openModal = (m, t = '', c = NB_COLORS[0]) => { setTitle(t); setNbColor(c); setModal(m); };

  const longPress = (e) => {
    const { kind, item } = e;
    const del = () => Alert.alert(kind === 'folder' ? 'Excluir pasta?' : 'Excluir caderno?',
      kind === 'folder' ? 'Tudo que está dentro dela será perdido.' : 'Todas as páginas serão perdidas.', [
        { text: 'Cancelar', style: 'cancel' },
        { text: 'Excluir', style: 'destructive', onPress: () => (kind === 'folder' ? onDeleteFolder(item.id) : onDeleteNotebook(item.id)) },
      ]);
    const buttons = [{ text: 'Renomear', onPress: () => openModal({ mode: 'rename', kind: kind === 'folder' ? 'folder' : 'nb', id: item.id }, item.title, item.color) }];
    if (kind === 'nb') buttons.push({ text: 'Mover para pasta…', onPress: () => setMoving(item.id) });
    buttons.push({ text: 'Excluir', style: 'destructive', onPress: del }, { text: 'Cancelar', style: 'cancel' });
    Alert.alert(item.title, undefined, buttons);
  };

  return (
    <SafeAreaView style={s.screen}>
      <View style={s.homeHead}>
        <View style={{ flex: 1 }}>
          {folder && (
            <TouchableOpacity onPress={() => setFolderId(folder.parentId ?? null)}><Text style={s.back}>← Voltar</Text></TouchableOpacity>
          )}
          <Text style={s.h1} numberOfLines={1}>{folder ? folder.title : 'Meus cadernos'}</Text>
        </View>
      </View>
      <View style={s.actions}>
        <TouchableOpacity style={s.btn} onPress={() => openModal({ mode: 'newNb' })}><Text style={s.btnTxt}>Novo caderno</Text></TouchableOpacity>
        <TouchableOpacity style={s.btnAlt} onPress={onImport}><Text style={s.btnAltTxt}>Importar PDF</Text></TouchableOpacity>
        <TouchableOpacity style={s.btnAlt} onPress={() => openModal({ mode: 'newFolder' })}><Text style={s.btnAltTxt}>Nova pasta</Text></TouchableOpacity>
      </View>
      <TextInput value={query} onChangeText={setQuery} placeholder="Buscar por título ou texto" style={[s.input, { marginHorizontal: 16 }]} />
      <FlatList
        data={entries}
        keyExtractor={(e) => e.kind + e.item.id}
        contentContainerStyle={{ padding: 16, gap: 12 }}
        ListEmptyComponent={<Text style={s.empty}>{q ? 'Nada encontrado.' : 'Aqui está vazio. Crie um caderno, uma pasta ou importe um PDF para anotar.'}</Text>}
        renderItem={({ item: e }) => (
          <TouchableOpacity style={s.card} onPress={() => (e.kind === 'folder' ? setFolderId(e.item.id) : onOpen(e.item.id))} onLongPress={() => longPress(e)}>
            <View style={[s.spine, { backgroundColor: e.kind === 'folder' ? C.muted : e.item.color }]} />
            <View style={{ flex: 1 }}>
              <Text style={s.cardTitle} numberOfLines={1}>{e.kind === 'folder' ? `Pasta · ${e.item.title}` : e.item.title}</Text>
              {e.kind === 'nb' && (
                <Text style={s.cardMeta}>
                  {e.item.pages.length} {e.item.pages.length === 1 ? 'página' : 'páginas'}{e.item.pages[0]?.bg ? ' · PDF' : ''} · editado em {new Date(e.item.updated).toLocaleDateString('pt-BR')}
                </Text>
              )}
            </View>
          </TouchableOpacity>
        )}
      />
      <Text style={s.hint}>Segure um item para renomear, mover ou excluir.</Text>

      <Modal visible={!!modal} transparent animationType="fade" onRequestClose={() => setModal(null)}>
        <View style={s.modalBg}><View style={s.modal}>
          <Text style={s.modalTitle}>{modal?.mode === 'newNb' ? 'Novo caderno' : modal?.mode === 'newFolder' ? 'Nova pasta' : 'Renomear'}</Text>
          <TextInput autoFocus value={title} onChangeText={setTitle} placeholder="Título" style={s.input} />
          {modal?.kind !== 'folder' && modal?.mode !== 'newFolder' && (
            <View style={[s.row, { marginVertical: 12, justifyContent: 'flex-start' }]}>
              {NB_COLORS.map((c) => (
                <TouchableOpacity key={c} onPress={() => setNbColor(c)} style={[s.swatch, { backgroundColor: c }, nbColor === c && s.swatchOn]} />
              ))}
            </View>
          )}
          <View style={s.row}>
            <TouchableOpacity onPress={() => setModal(null)} style={s.btnGhost}><Text style={s.btnGhostTxt}>Cancelar</Text></TouchableOpacity>
            <TouchableOpacity onPress={save} style={s.btn}><Text style={s.btnTxt}>Salvar</Text></TouchableOpacity>
          </View>
        </View></View>
      </Modal>

      <Modal visible={!!moving} transparent animationType="fade" onRequestClose={() => setMoving(null)}>
        <View style={s.modalBg}><View style={s.modal}>
          <Text style={s.modalTitle}>Mover para…</Text>
          <TouchableOpacity style={s.moveOpt} onPress={() => { onMove(moving, null); setMoving(null); }}><Text style={s.moveTxt}>Início</Text></TouchableOpacity>
          {data.folders.map((f) => (
            <TouchableOpacity key={f.id} style={s.moveOpt} onPress={() => { onMove(moving, f.id); setMoving(null); }}><Text style={s.moveTxt}>{f.title}</Text></TouchableOpacity>
          ))}
          <TouchableOpacity onPress={() => setMoving(null)} style={[s.btnGhost, { alignSelf: 'flex-end' }]}><Text style={s.btnGhostTxt}>Cancelar</Text></TouchableOpacity>
        </View></View>
      </Modal>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  homeHead: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: 16 },
  back: { color: C.accent, fontWeight: '700', marginBottom: 4 },
  h1: { fontSize: 26, fontWeight: '800', color: C.ink },
  actions: { flexDirection: 'row', gap: 8, padding: 16, flexWrap: 'wrap' },
  card: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff', borderRadius: 10, padding: 14, gap: 14, borderWidth: 1, borderColor: C.line },
  spine: { width: 8, alignSelf: 'stretch', borderRadius: 4 },
  cardTitle: { fontSize: 17, fontWeight: '700', color: C.ink },
  cardMeta: { marginTop: 4, color: C.muted, fontSize: 13 },
  empty: { color: C.muted, textAlign: 'center', marginTop: 48, paddingHorizontal: 24, lineHeight: 20 },
  hint: { textAlign: 'center', color: C.muted, fontSize: 12, paddingBottom: 12 },
  input: { backgroundColor: '#fff', borderRadius: 8, borderWidth: 1, borderColor: C.line, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, color: C.ink },
  btn: { backgroundColor: C.accent, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8 },
  btnTxt: { color: '#fff', fontWeight: '700' },
  btnAlt: { backgroundColor: '#fff', paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: C.accent },
  btnAltTxt: { color: C.accent, fontWeight: '700' },
  btnGhost: { paddingHorizontal: 16, paddingVertical: 10 },
  btnGhostTxt: { color: C.muted, fontWeight: '700' },
  row: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 8, marginTop: 12 },
  swatch: { width: 28, height: 28, borderRadius: 14, borderWidth: 2, borderColor: 'transparent' },
  swatchOn: { borderColor: C.ink, transform: [{ scale: 1.15 }] },
  modalBg: { flex: 1, backgroundColor: 'rgba(23,33,43,0.45)', justifyContent: 'center', padding: 24 },
  modal: { backgroundColor: '#fff', borderRadius: 12, padding: 18 },
  modalTitle: { fontSize: 18, fontWeight: '800', color: C.ink, marginBottom: 12 },
  moveOpt: { padding: 14, borderRadius: 8, borderWidth: 1, borderColor: C.line, marginBottom: 8 },
  moveTxt: { color: C.ink, fontWeight: '600' },
  busy: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(23,33,43,0.75)', alignItems: 'center', justifyContent: 'center', gap: 10 },
  busyTxt: { color: '#fff', fontWeight: '700' },
});
