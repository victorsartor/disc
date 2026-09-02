import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron';
import renderer from 'vite-plugin-electron-renderer';

// O plugin sempre emite ESM nos processos do Electron. O Electron aceita
// preload em ESM, mas so com extensao .mjs e sandbox desligado (ver main.ts).
const preloadOut = {
  build: { rollupOptions: { output: { entryFileNames: '[name].mjs' } } },
};

export default defineConfig({
  // O tokenizer de mensagem mora em server/src/texto.ts e e importado pelos
  // DOIS lados - ver o comentario em src/lib/texto.ts. Em dev o Vite serve
  // modulo por HTTP e recusa caminho fora da raiz do projeto por padrao;
  // sem isto o `npm run dev` quebra com "outside of Vite serving allow
  // list". No build nao faz diferenca: la o arquivo so entra no bundle.
  server: { fs: { allow: ['..'] } },
  build: {
    // O worklet de audio PRECISA virar arquivo, nunca data: URI.
    //
    // Abaixo do assetsInlineLimit (4 kB) o Vite embute o asset como
    // `data:text/javascript`, e a CSP do index.html (`script-src 'self'`)
    // recusa data: exatamente como recusava o blob: que existia antes.
    // Nos dois casos o addModule falha SO EM PRODUCAO, o isolamento cai no
    // loopback do sistema inteiro e quem assiste volta a se ouvir - foi o
    // bug da 0.30.0. Como arquivo ele fica em ./assets, mesma origem do
    // documento, e passa no 'self'.
    assetsInlineLimit: (arquivo: string) =>
      arquivo.endsWith('.worklet.js') ? false : undefined,
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'index.html'),
        overlay: resolve(__dirname, 'overlay.html'),
      },
    },
  },
  plugins: [
    react(),
    electron([
      {
        entry: 'electron/main.ts',
        vite: {
          // O processo main roda em Node, entao process.env seria lido em
          // RUNTIME - e num app instalado essa variavel nao existe. Isso
          // grava a URL no bundle na hora do build.
          define: {
            'process.env.VITE_SERVER_URL': JSON.stringify(
              process.env.VITE_SERVER_URL ?? 'http://localhost:3000',
            ),
          },
          build: {
            rollupOptions: {
              // uiohook-napi carrega um binario .node via node-gyp-build,
              // que resolve prebuilds/ a partir do __dirname do PACOTE.
              // Embutido no bundle esse caminho deixa de existir e o
              // require do binding falha em runtime. Tem que ficar externo
              // (e fora do asar - ver asarUnpack no package.json).
              //
              // electron-updater e CommonJS com require dinamico (fs-extra,
              // js-yaml). Empacotar isso em ESM quebra em runtime - fica
              // externo e vai como dependencia de producao.
              external: ['uiohook-napi', 'electron-updater'],
            },
          },
        },
      },
      { entry: 'electron/preload.ts', vite: preloadOut },
      { entry: 'electron/overlay-preload.ts', vite: preloadOut },
    ]),
    renderer(),
  ],
});
