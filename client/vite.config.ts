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
  build: {
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
              external: ['uiohook-napi'],
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
