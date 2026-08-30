---
name: electron-desktop
description: Template de app desktop Electron — stack, estrutura de pastas, modelo de processos (main/renderer/preload), conceitos-chave de IPC e segurança, passos de setup, alvos de build por plataforma e boas práticas. Usar ao iniciar um novo app Electron do zero ou ao decidir a estrutura base de um projeto desktop cross-platform.
risk: safe
source: community
date_added: '2026-08-30'
---

# Template de App Desktop Electron

Princípios para montar um app desktop cross-platform com Electron e tecnologias web modernas.

## Usar essa skill quando

- Iniciar um novo app Electron do zero
- Definir a estrutura de pastas e o modelo de processos de um projeto desktop
- Escolher stack (bundler, UI, packaging) para distribuição cross-platform

## Stack

| Componente | Tecnologia |
|-----------|------------|
| Framework | Electron 28+ |
| UI | React 18 |
| Linguagem | TypeScript |
| Estilo | Tailwind CSS |
| Bundler | Vite + electron-builder |
| IPC | Comunicação type-safe |

## Estrutura de diretórios

```
project-name/
├── electron/
│   ├── main.ts          # Processo main
│   ├── preload.ts       # Script de preload
│   └── ipc/             # Handlers de IPC
├── src/
│   ├── App.tsx
│   ├── components/
│   │   ├── TitleBar.tsx # Barra de título custom
│   │   └── ...
│   └── hooks/
├── public/
└── package.json
```

## Modelo de processos

| Processo | Papel |
|---------|-------|
| Main | Node.js, acesso ao sistema |
| Renderer | Chromium, UI React |
| Preload | Ponte, isolamento de contexto |

## Conceitos-chave

| Conceito | Propósito |
|---------|-----------|
| contextBridge | Exposição segura de API |
| ipcMain/ipcRenderer | Comunicação entre processos |
| nodeIntegration: false | Segurança |
| contextIsolation: true | Segurança |

## Passos de setup

1. `npm create vite {{name}} -- --template react-ts`
2. Instalar: `npm install -D electron electron-builder vite-plugin-electron`
3. Criar o diretório `electron/`
4. Configurar o processo main
5. `npm run electron:dev`

## Alvos de build

| Plataforma | Saída |
|-----------|-------|
| Windows | NSIS, Portable |
| macOS | DMG, ZIP |
| Linux | AppImage, DEB |

## Boas práticas

- Usar o script de preload como ponte main/renderer
- IPC type-safe com handlers tipados
- Barra de título custom para aparência nativa
- Tratar o estado da janela (maximizar, minimizar)
- Auto-update com electron-updater

Para o aprofundamento (IPC seguro, hardening, packaging, code signing, debugging, testes), veja a skill `electron-development`.
