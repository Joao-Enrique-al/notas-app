import React, { useRef } from 'react';
import { View } from 'react-native';
import { WebView } from 'react-native-webview';
import { PDF_READER_HTML } from './lib';

// WebView invisível: carrega o pdf.js, renderiza cada página em JPEG e devolve ao app.
export default function PdfImporter({ b64, onCount, onPage, onDone, onError }) {
  const ref = useRef(null);
  const started = useRef(false);

  const start = () => {
    if (started.current) return;
    started.current = true;
    ref.current?.injectJavaScript(`run(${JSON.stringify(b64)}); true;`);
  };

  const onMessage = (e) => {
    let m;
    try { m = JSON.parse(e.nativeEvent.data); } catch { return; }
    if (m.t === 'count') onCount(m.n);
    else if (m.t === 'page') onPage(m.i, m.ratio, m.data);
    else if (m.t === 'done') onDone();
    else if (m.t === 'error') onError(m.m);
  };

  return (
    <View style={{ position: 'absolute', width: 1, height: 1, opacity: 0 }} pointerEvents="none">
      <WebView
        ref={ref}
        originWhitelist={['*']}
        source={{ html: PDF_READER_HTML, baseUrl: 'https://localhost/' }}
        javaScriptEnabled
        mixedContentMode="always"
        onLoadEnd={start}
        onMessage={onMessage}
        onError={() => onError('Falha ao carregar o leitor de PDF. Verifique a internet.')}
      />
    </View>
  );
}
