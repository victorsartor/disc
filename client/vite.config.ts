import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron';
import renderer from 'vite-plugin-electron-renderer';

// PRELOAD EM CommonJS, e nao no ESM que o plugin emite por padrao.
//
// Preload em ESM obriga `sandbox: false` - o Electron nao carrega modulo ESM
// dentro do sandbox. Como os dois preloads daqui so falam com `electron` (e
// o process.platform, que o sandbox tambem oferece), o UNICO motivo pra
// sandbox estar desligado ate a 0.35 era o formato do modulo.
//
// SAO DUAS COISAS, e faltar qualquer uma das duas quebra em producao:
//
// 1. A EXTENSAO tem que ser .cjs. Nao adianta `[name].js`: este
//    package.json tem `"type": "module"`, entao um .js aqui dentro e lido
//    como ESM e o bundle CJS morre na primeira linha.
// 2. O FORMATO tem que ser cjs de verdade. E aqui mora a pegadinha: o
//    vite-plugin-electron decide `formats: ['es']` sozinho, justamente por
//    causa do `"type": "module"`, e `build.lib.formats` ganha de
//    `rollupOptions.output.format`. Pedir o formato pelo objeto de config
//    tambem nao resolve - o plugin usa `mergeConfig`, que CONCATENA arrays:
//    `['es']` + `['cjs']` viraria `['es','cjs']`, dois formatos gravando no
//    mesmo nome de arquivo.
//
// Por isso o override e um plugin que MUTA a config ja montada, depois do
// merge. Sem ele o arquivo sai chamado .cjs com `import` dentro - o pior dos
// mundos, porque o nome parece certo e o app so falha rodando.
const forcarCjs = {
  name: 'disneia:preload-cjs',
  config(cfg: { build?: { lib?: { formats?: string[] } } }) {
    if (cfg.build?.lib) cfg.build.lib.formats = ['cjs'];
  },
  // A conferencia, e nao so a intencao. Nome e conteudo do preload sao
  // decididos em lugares diferentes (o entryFileNames aqui embaixo e o
  // formats la em cima), e ja saiu um .cjs com `import` dentro enquanto eu
  // escrevia isto. Esse arquivo passa no build, entra no instalador e SO
  // falha quando a janela abre - com o preload morto, `window.disc` nao
  // existe e o app fica na tela de login pra sempre.
  //
  // Ler o que foi gravado e exigir que as duas metades concordem custa
  // estas linhas e transforma o pior tipo de falha (silenciosa, em
  // producao) num build vermelho.
  closeBundle() {
    for (const arq of ['preload.cjs', 'overlay-preload.cjs']) {
      const caminho = resolve(__dirname, 'dist-electron', arq);
      if (!existsSync(caminho)) continue;
      const código = readFileSync(caminho, 'utf8');
      if (/(^|\n)\s*(import|export)[\s{*]/.test(código)) {
        throw new Error(
          `${arq} saiu com sintaxe ESM. Preload no sandbox tem que ser ` +
          `CommonJS - confira o formats:['cjs'] no vite.config.ts.`,
        );
      }
      if (!código.includes('require(')) {
        throw new Error(`${arq} nao tem require() - nao parece CommonJS.`);
      }
    }
  },
};

const preloadOut = {
  build: { rollupOptions: { output: { entryFileNames: '[name].cjs' } } },
  plugins: [forcarCjs],
};

export default defineConfig({
  // O tokenizer de mensagem mora em server/src/texto.ts e e importado pelos
  // DOIS lados - ver o comentario em src/lib/texto.ts. Em dev o Vite serve
  // modulo por HTTP e recusa caminho fora da raiz do projeto por padrao;
  // sem isto o `npm run dev` quebra com "outside of Vite serving allow
  // list". No build nao faz diferenca: la o arquivo so entra no bundle.
  server: { fs: { allow: ['..'] } },
  build: {
    // As duas regras abaixo saem da MESMA causa - em producao a janela e
    // carregada por file:// (ver o loadFile no electron/main.ts) - e por
    // isso apontam para lados opostos. Errar qualquer uma das duas produz o
    // mesmo tipo de bug: passa no `npm run dev` e morre calado no app
    // instalado.
    assetsInlineLimit: (arquivo: string) => {
      // 1. Worklet PRECISA virar arquivo, nunca data: URI.
      //
      // Abaixo do limite padrao (4 kB) o Vite embute o asset como
      // `data:text/javascript`, e a CSP do index.html (`script-src 'self'`)
      // recusa data: exatamente como recusava o blob: que existia antes.
      // Nos dois casos o addModule falha SO EM PRODUCAO, o isolamento cai no
      // loopback do sistema inteiro e quem assiste volta a se ouvir - foi o
      // bug da 0.30.0. Como arquivo ele fica em ./assets, mesma origem do
      // documento, e passa no 'self'.
      //
      // A regex cobre os dois nomes em uso, que nao seguem a mesma
      // convencao: o nosso `anel-de-audio.worklet.js` e o
      // `workletProcessor.js` do pacote de supressao de ruido. Casar so
      // `.worklet.js` deixaria o segundo de fora - ele continuaria virando
      // arquivo, mas so por ter 64 kB e passar do limite padrao de 4 kB.
      // Depender do TAMANHO de um arquivo de terceiro pra CSP nao quebrar e
      // exatamente o tipo de acidente que esta regra existe pra evitar.
      if (/worklet[^/\\]*\.js$/i.test(arquivo)) return false;

      // 2. O wasm PRECISA virar data: URI, nunca arquivo - o contrario.
      //
      // Modulo wasm nao e carregado por <script>: alguem tem que ler os
      // BYTES e passar pro WebAssembly. Ler bytes de uma URL e fetch, e a
      // Fetch API nao existe em file: - o Chromium recusa o esquema. Como
      // data: URI os bytes ja chegam dentro do bundle e sao decodificados
      // na memoria (ver bytesDoDataUrl em src/lib/rnnoise.ts), sem rede
      // nenhuma e sem depender de como a pagina foi carregada.
      //
      // Custo: ~200 kB de base64 no bundle. Num app que ja carrega o
      // Electron inteiro, e troco pela garantia de dev e producao serem o
      // mesmo caminho.
      if (arquivo.endsWith('.wasm')) return true;

      return undefined;
    },
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
