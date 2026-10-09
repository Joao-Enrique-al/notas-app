#!/usr/bin/env bash
# Cria um projeto NOVO e LIMPO no Expo SDK 57 e copia o app para dentro dele.
# Uso: coloque este arquivo na mesma pasta de App.js, Editor.js, PdfImporter.js e lib.js
# e rode:  bash setup.sh
set -e

SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$SRC/../notas-sdk57"

for f in App.js Editor.js PdfImporter.js lib.js; do
  [ -f "$SRC/$f" ] || { echo "Faltou o arquivo $f ao lado do setup.sh"; exit 1; }
done

if [ -e "$DEST" ]; then
  echo "A pasta $DEST já existe. Apague ou renomeie e rode de novo."; exit 1
fi

echo "==> Criando projeto Expo SDK 57"
npx --yes create-expo-app@latest "$DEST" --template blank@sdk-57 --no-install \
  || npx --yes create-expo-app@latest "$DEST" --template blank --no-install

cd "$DEST"

echo "==> Instalando dependências base"
npm install

echo "==> Instalando bibliotecas do app (o Expo escolhe as versões do SDK 57)"
npx expo install react-native-svg react-native-gesture-handler react-native-webview \
  react-native-safe-area-context expo-document-picker expo-file-system expo-print \
  expo-sharing expo-status-bar

echo "==> Copiando o código do app"
cp "$SRC/App.js" "$SRC/Editor.js" "$SRC/PdfImporter.js" "$SRC/lib.js" "$DEST/"

echo "==> Alinhando versões e verificando o projeto"
npx expo install --fix || true
npx expo-doctor || true

echo
echo "Pronto. Versão do SDK deste projeto:"
grep '"expo":' package.json
echo
echo "Agora rode:"
echo "  cd \"$DEST\" && npx expo start -c"
