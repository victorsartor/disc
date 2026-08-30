---
name: salvar
description: >
  Salva o trabalho da Disneia no GitHub (commit + push). Use quando o usuário disser
  "salvar", "salva no github", "commit", "push", "/salvar" ou pedir backup do trabalho.
---

# /salvar — Salvar no GitHub

Skill de uma função só: garantir que o trabalho está no GitHub, sem susto e sem
arrastar pro commit o que não devia ir.

## O terreno

Um repositório só, sem submódulo e sem projeto aninhado:

| | |
|---|---|
| Remote | `https://github.com/victorsartor/disc.git` |
| Branch | `main` (única; não existe `develop` nem `homologacao`) |
| CI | **nenhum** — não há workflow que rode typecheck depois do push |

Não existe CI é o fato mais importante desta skill: **o que quebrar aqui só vai
ser descoberto na máquina de alguém.** Por isso o passo 3 abaixo não é opcional.

Publicar atualização pro app é outra coisa, e **não acontece no push** — quem
faz é o `publicar.ps1`. Ver a seção "Salvar ≠ publicar" no fim.

## Workflow

### Passo 1 — Ver o que mudou

```
git status --short
```

Sem mudança: responder "Tá tudo sincronizado, sem mudança nova" e parar.

Olhar a lista com atenção antes de seguir. Duas coisas que aparecem aqui e
**nunca podem entrar num commit**:

- `.env` — tem `GOOGLE_CLIENT_SECRET`, `LIVEKIT_API_SECRET`, `SESSION_SECRET`
- `certs/` — chave privada do certificado do Tailscale

As duas estão no `.gitignore`, então em situação normal nem aparecem. Se
aparecerem, alguma coisa quebrou no ignore — **parar e avisar o usuário**, não
commitar em volta.

### Passo 2 — Puxar antes

```
git pull
```

Antes de commitar, não depois. Barato, e evita descobrir a divergência só na
hora do push.

### Passo 3 — Conferir que compila

Não há CI. Este passo é o único gate que existe:

```
cd client; npx tsc --noEmit
cd server; npx tsc --noEmit
```

Erro de tipo em qualquer um dos dois: **não commitar**. Consertar primeiro, ou
avisar o usuário e perguntar se ele quer commitar assim mesmo (às vezes ele
quer — trabalho pela metade que ele vai retomar). Nunca decidir isso sozinho.

Mexeu em `client/src` ou `client/electron`? Vale rodar o build inteiro, que é
rápido e pega coisa que o `tsc` sozinho não pega (asset que não resolve, import
que o Vite não acha):

```
cd client; npm run build
```

### Passo 4 — Preparar caminho por caminho

**Nunca `git add .`, `git add -A` nem `git commit -a`.** Adicionar caminho por
caminho:

```
git add client/src/lib/sounds.ts client/src/lib/useRoom.ts
```

Depois conferir o que foi de fato preparado, e mostrar pro usuário:

```
git diff --cached --name-only
```

Isso é o que impede segredo esquecido e arquivo de outra frente de trabalho de
pegarem carona.

### Passo 5 — Mensagem

Perguntar:

> "Isso aqui vai pro `victorsartor/disc`, branch `main`. Quer descrever a
> mudança ou eu escrevo?"

Se o usuário não escrever, gerar seguindo o estilo que o repositório já tem
(rodar `git log -3` pra conferir antes). O padrão desse histórico:

- Título em português, minúsculo depois da primeira palavra, **sem acento**,
  dizendo o que mudou pra quem usa o app — não o nome do arquivo mexido.
  Ex: "Portao de ruido no microfone, tela inteira, e a barra de titulo fora"
- Corpo separado em blocos, cada um começando com a coisa em CAIXA ALTA, e
  explicando **por que** quebrou, não só o que foi trocado.
- Rodapé: `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`

Corpo longo vai por heredoc, nunca por `-m` repetido:

```
git commit -F - <<'EOF'
Titulo aqui

Corpo aqui.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
```

### Passo 6 — Commit e push

```
git commit -F - <<'EOF'
...
EOF
git push
```

Confirmar com o link:

> "Salvo. Ver em https://github.com/victorsartor/disc"

## Salvar ≠ publicar

Push **não** entrega nada pros amigos. O app deles não olha o GitHub: olha o
feed em `https://sar-pc.taild0e099.ts.net/atualizacoes/latest.yml`, servido pelo
Caddy da máquina do Victor.

Pra uma mudança chegar em quem usa o app, além do commit:

1. Subir a versão em `client/package.json` (o `electron-updater` compara
   número; publicar sem subir não atualiza ninguém)
2. Rodar `.\publicar.ps1` — ele compila e copia `latest.yml`, o `.exe` e o
   `.blockmap` pra `atualizacoes/`
3. Conferir que o servidor está servindo mesmo:
   `curl -sk https://sar-pc.taild0e099.ts.net/atualizacoes/latest.yml`

Se o usuário disser "salvar" mas o que ele quer é que o amigo receba, **os dois
passos são necessários** — perguntar qual dos dois ele quer, ou fazer os dois e
dizer o que fez.

Os instaladores em `atualizacoes/` e `client/release/` **não são versionados**
(estão no `.gitignore`, 75 MB cada). Retenção combinada: manter a versão atual e
uma anterior como backup, apagar o resto.

## Regras

- Nunca `--force`, nunca `git reset --hard`, nunca `git clean` sem o usuário
  pedir com essas palavras
- Push rejeitado por divergência: resolver com `git pull --rebase`, nunca com
  `--force`
- `git` sem `user.name` / `user.email` configurados: perguntar e configurar com
  `git config --global`, uma vez
- Está no Windows com PowerShell 5.1: `&&` não existe entre comandos. Usar `;`
  ou `if ($?) { }`
