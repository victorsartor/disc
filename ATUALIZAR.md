# Atualizando o app

A Disneia se atualiza sozinha. Quem abrir o app com uma versão velha vê uma
tela de carregamento, baixa a nova, e o app reinicia já atualizado — sem
ninguém precisar mandar `.exe` por WhatsApp de novo.

## Como funciona

O feed de atualização é servido pelo **seu próprio Caddy**, na rota
`/atualizacoes`, com o certificado do Tailscale. Não tem GitHub Releases nem
nada público: quem não está na tailnet não alcança o endereço.

```
   você                          servidor (seu PC)              amigo
   ────                          ─────────────────              ─────
   .\publicar.ps1        ──▶     atualizacoes/
     ├ compila                     ├ latest.yml        ◀──  abre o app
     └ copia 3 arquivos            ├ Disneia Setup      ──▶  tela de
                                   │   0.7.0.exe             atualização
                                   └ ...exe.blockmap    ──▶  reinicia
                                                              atualizado
```

O `latest.yml` é o que o app lê: versão e hash. Se a versão de lá for maior
que a instalada, ele baixa. O `.blockmap` deixa ele baixar **só os blocos que
mudaram** em vez dos 75 MB inteiros — uma correção pequena vira poucos MB.

## Publicando uma atualização

### 1. Sobe a versão

Em [client/package.json](client/package.json):

```json
"version": "0.3.0"
```

**Esse é o passo que decide se alguém atualiza.** O app compara versão; se
você publicar sem subir, ninguém recebe nada.

### 2. Roda o publicar

```powershell
.\publicar.ps1
```

Ele compila com a URL certa (lida do `.env`) e copia os três arquivos pra
`atualizacoes/`. Se a versão já estiver publicada, ele recusa — republicar a
mesma versão com bytes diferentes quebra o download de quem estiver no meio.

### 3. Confere

Abra no navegador:

```
https://SEU_DOMINIO/atualizacoes/latest.yml
```

Tem que aparecer a versão nova. Se der 404, o Caddy não está com a pasta
montada — suba de novo:

```powershell
docker compose -f docker-compose.tailscale.yml up -d caddy
```

Pronto. Quem abrir o app a partir de agora recebe sozinho.

## O que o amigo vê

| Situação | O que acontece |
| --- | --- |
| Sem atualização | Nada. O app abre direto, sem tela extra |
| Tem atualização | Tela com a barra de progresso, `0.6.0 → 0.7.0`, o % e os MB |
| Terminou de baixar | "Tudo pronto", e o app reinicia sozinho |
| Servidor fora do ar | Nada. O app abre normalmente na versão que já tem |
| Download travou | Depois de 20s aparece "Continuar sem atualizar" |

A tela vem **antes do login** de propósito: não adianta entrar numa sala com
uma versão que o resto do grupo já deixou pra trás.

E ela nunca prende ninguém. Se o servidor estiver fora, o app abre igual. Se
o download travar no meio, tem como pular. O pior caso é a pessoa continuar
na versão antiga — nunca ficar sem app.

## Onde cada coisa mora

| Arquivo | Papel |
| --- | --- |
| [client/electron/updater.ts](client/electron/updater.ts) | Checa, baixa e instala. Roda no processo main |
| [client/src/components/Updater.tsx](client/src/components/Updater.tsx) | A tela de carregamento |
| [client/src/lib/useUpdate.ts](client/src/lib/useUpdate.ts) | Estado no renderer + quando bloquear o app |
| [infra/Caddyfile.tailscale](infra/Caddyfile.tailscale) | Serve `/atualizacoes` |
| [publicar.ps1](publicar.ps1) | Compila e publica |
| `atualizacoes/` | Os arquivos servidos (fora do git — são 75 MB por versão) |

## Duas coisas que valem saber

**A rota `/atualizacoes` não pede login.** E não tem como pedir: o app checa
atualização antes de existir sessão. Quem protege isso é a tailnet, não a
allowlist de e-mail. De fora ninguém chega até lá.

**O app não é assinado.** Sem assinatura, o `electron-updater` pula a
verificação — ou seja, quem controla o servidor controla o que roda na
máquina de quem instalou. Num grupo fechado, com o servidor sendo o seu PC,
tudo bem. Mas é uma escolha, não um descuido: assinar exigiria um
certificado de code signing pago.

## Se der errado

| Sintoma | Causa provável |
| --- | --- |
| Ninguém atualiza | Esqueceu de subir a versão no `package.json` |
| 404 no `latest.yml` | Caddy sem a pasta montada — `up -d caddy` |
| "Continuar sem atualizar" aparece sempre | Servidor lento ou fora do ar durante o download |
| Baixa e não instala | Antivírus segurando o `.exe` (não é assinado) |
| Atualiza toda vez que abre | A versão publicada é maior que a que o build gerou — confira o `package.json` |

## Se um dia renomear o app de novo

Renomear (`productName` / `appId` no `package.json`) **não quebra** a
atualização — testado na virada de Concord para Disneia: o app antigo baixou
o instalador novo, instalou e reabriu já com o nome novo.

O que acontece é que o app velho **fica instalado do lado**, com atalho e
entrada de desinstalação próprios, ocupando os mesmos ~230 MB. O NSIS
identifica a instalação pelo `appId`; com um `appId` novo ele não reconhece
a antiga e instala do zero em vez de substituir.

Some junto o `userData`, que também é derivado do nome: **sessão e
configurações voltam ao padrão** e todo mundo loga de novo.

Nada disso é impeditivo, mas cada um tem que desinstalar o app velho na mão:
Configurações do Windows → Aplicativos → o nome antigo → Desinstalar.

Pra ver o que o app está fazendo, os logs do updater saem no console do
processo main (`--enable-logging` no atalho, ou rode o `.exe` pelo terminal).
