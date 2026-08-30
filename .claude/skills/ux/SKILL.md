---
name: ux
description: >
  Auditoria de usabilidade de interface INTERATIVA (não é revisão visual). Pontua a UI
  renderizada contra as 10 heurísticas de Nielsen mais regras de interação, com severidade
  e correção localizada para cada achado. Use quando uma tela "não é boa de usar", é difícil
  de aprender, precisa de um parágrafo de instrução pra ser entendida, ou antes de entregar
  qualquer coisa interativa.
risk: unknown
source: https://github.com/connerkward/ckw-design-skill/tree/main/deterministic-design/design-ux
source_repo: connerkward/ckw-design-skill
source_type: community
date_added: 2026-07-01
license: MIT
license_source: https://github.com/connerkward/ckw-design-skill/blob/main/LICENSE
author: Conner K Ward
adaptado_em: 2026-08-30
adaptacao: >
  Skill original citava três irmãs (design-spatial, design-thinking, design-system) que não
  existem neste projeto. As regras que vinham delas foram trazidas pra dentro. Seção de
  render adaptada pro app Electron.
---

# ux — auditoria de usabilidade (avaliação heurística)

Usabilidade ≠ estética. Uma tela pode estar bonita e ainda assim ser ruim de
usar. Esta skill verifica se alguém de primeira viagem consegue fazer a tarefa
**sem que ninguém explique como** — não se as cores combinam.

Use quando uma tela "não é boa de usar", quando ela precisa de um parágrafo de
instrução, ou antes de entregar qualquer coisa interativa.

## Regra 0 — olhos frescos, na coisa renderizada

**Nunca se auto-avaliar.** Quem constrói racionaliza a própria interface: os
atalhos que você inventou parecem óbvios porque você os inventou.

1. Renderizar a UI **de verdade**, no estado de primeira abertura — não uma
   captura arrumada à mão, não uma descrição do que ela faz.
2. Capturar o caminho da tarefa principal, passo a passo.
3. Quem pontua tem que ser **um juiz separado** (um subagente que não
   construiu a tela).

Uma lista de mudanças descritas não é auditoria. Auditoria é um juiz de fora
caçando o que está errado na tela real.

### Como renderizar, neste projeto

A Disneia é um app Electron, não uma página. Não dá pra abrir um `.html` e
olhar — a tela depende de sessão, de canal de voz e de outras pessoas na sala.

- Para subir o app: usar a skill `run`, que já sabe o caminho deste projeto.
- Estado de primeira abertura aqui é **antes do login** e **fora de qualquer
  canal** — é o que o amigo novo vê. Auditar direto com a call cheia esconde
  justamente os buracos de primeira viagem.
- Alguns estados só existem com duas pessoas (alguém falando, alguém
  compartilhando tela, volume individual). Esses precisam do teste em dupla —
  não dá pra pontuar de memória, e chutar aqui é pior que não auditar.
- Testar **largo e estreito**: a janela tem mínimo de 900x600 e o palco divide
  altura com o chat. O que estoura, estoura no estreito.

## O procedimento

1. **Nomear a tarefa principal** que a tela existe pra cumprir (ex: "entrar num
   canal de voz e começar a compartilhar a tela"). A auditoria é relativa a
   essa tarefa, não a beleza abstrata.
2. **Renderizar o estado inicial e percorrer a tarefa**, capturando cada passo,
   largo e estreito.
3. **Pontuar cada heurística** da tabela: passou / violou, **severidade**
   (bloqueio / grave / leve), o achado **localizado** (que elemento, que tela) e
   uma correção concreta. Quem pontua é o juiz separado.
4. **Priorizar**: bloqueios → graves → leves; agrupar correções que mexem na
   mesma superfície.
5. **Corrigir, depois RE-RENDERIZAR e RE-PONTUAR.** Não dar por consertado sem
   auditar de novo a tela nova.

## Heurísticas — pontuar cada uma (Nielsen, 1994)

| # | Heurística | O que checar nesta UI |
|---|---|---|
| 1 | **Visibilidade do estado** | Toda ação tem retorno visível; estado/seleção/modo sempre legível; progresso em operação lenta. |
| 2 | **Corresponder ao mundo real** | Metáforas e convenções conhecidas — não gestos próprios que a pessoa precisa aprender. |
| 3 | **Controle e liberdade** | Desfazer, cancelar, sair de qualquer estado; reversível por padrão. |
| 4 | **Consistência e padrões** | A mesma coisa se parece e se comporta igual; convenção da plataforma respeitada (Ctrl+Z, Delete, arrastar). |
| 5 | **Prevenção de erro** | Estado inválido impossível; ação destrutiva confirmada ou trivialmente reversível. |
| 6 | **Reconhecer, não lembrar** | Opção e affordance **visíveis** — sem decorar. *Parede de instrução é falha desta heurística: se você precisa explicar em prosa "role pra dar zoom" ou "clique duas vezes", a affordance está faltando.* |
| 7 | **Flexibilidade e eficiência** | Padrão carrega o novato; atalho para o experiente; primeira execução boa sem nada configurado. |
| 8 | **Estética e minimalismo** | Sinal acima de enfeite; nada irrelevante competindo; a **superfície principal** carrega o maior peso visual. |
| 9 | **Reconhecer, diagnosticar e sair do erro** | Erro em português claro (não `stderr` cru), e um caminho de saída. |
| 10 | **Ajuda e documentação** | Raramente necessária se 1–9 valem; orientada à tarefa, no contexto, não uma aula no topo da página. |

## Regras de interação (compõem com a tabela, não repetem)

- **Não-me-faça-pensar (Krug):** a affordance se explica sozinha; a UI se
  ensina. Parágrafo de instrução ⇒ dívida de affordance (liga com a #6).
- **Fitts / tempo de trânsito:** o controle fica perto de onde a tarefa deixou o
  cursor. A propriedade de um objeto selecionado pertence **ao lado do objeto**
  (dock, popover), não num painel distante — cada edição não pode ser uma
  viagem de ida e volta.
- **Descobribilidade de gesto:** todo gesto não-óbvio (roda do mouse, arrastar
  a borda, duplo clique) precisa de uma **affordance visível** (alça, pista no
  hover, ícone) ou ele não existe pra maioria.
- **Peso visual corresponde ao uso:** a superfície que a pessoa *opera* deve ser
  a heroína visual — não uma tira fina embaixo de um preview passivo grande.
- **Revelação progressiva:** o essencial primeiro; o avançado sob demanda. Mas
  revelar progressivamente ≠ esconder a ferramenta principal.
- **Tempo do tooltip:** atrasar o *primeiro* tooltip de um grupo (~300–700ms de
  intenção de hover) pra que varrer o cursor sobre os controles não pisque
  dicas; depois que um abriu, **os vizinhos aparecem na hora** enquanto a
  pessoa varre a fileira. Disparar em todo hover é ruído; re-atrasar em cada
  vizinho é lerdeza.
- **Restaurar posição de rolagem:** voltar devolve a pessoa onde ela estava, não
  ao topo. O navegador faz isso sozinho; o bug é *quebrar* com reset manual de
  scroll.
- **Idempotência no envio:** ação que muda estado carrega chave de idempotência,
  pra que duplo clique, retentativa ou rede instável não dupliquem o efeito.
  Casa com "desabilitar o botão durante a requisição" — a chave é a garantia do
  servidor, o desabilitar é a cortesia do cliente.

*(Tooltip, restaurar rolagem e idempotência vêm do Web Interface Guidelines,
`vercel-labs/web-interface-guidelines` @ `4e799d4`, 2026-04-06.)*

## Formato de saída

Uma tabela pontuada — `Heurística | Achado (localizado) | Severidade | Correção` —
seguida da lista priorizada (bloqueios primeiro).

Severidade:
- **bloqueio** = impede concluir a tarefa, ou engana ativamente
- **grave** = atrasa ou confunde
- **leve** = acabamento

## Limites

- Não pontuar de memória nem por descrição: sem a tela renderizada na frente,
  não é auditoria — é palpite. Se não deu pra renderizar, dizer isso em vez de
  entregar uma tabela inventada.
- Estado que só existe com duas pessoas (voz, tela compartilhada, volume por
  pessoa) exige teste em dupla; marcar como não verificado em vez de supor.
- Verificar comando, dependência e comportamento de serviço externo antes de
  aplicar mudança.
