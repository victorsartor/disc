---
name: mapear-rotinas
description: >
  Mapeia tarefas repetitivas que o usuário faz no dia a dia e gera skills personalizadas pra
  automatizá-las. Faz uma entrevista curta sobre o que o usuário repete toda semana, propõe
  skills concretas e cria as aprovadas em `.claude/skills/`. Use quando o usuário pedir
  "/mapear-rotinas", "criar skills personalizadas", "automatizar minhas tarefas" ou "o que dá pra automatizar".
adaptado_em: "2026-08-30"
adaptacao: >
  Passo 2 e Passo 4 citavam templates/skills/catalogo.md e _memoria/preferencias.md
  e _memoria/empresa.md — arquivos de outro workspace (o "MazyOS") que não existem
  neste repositório. Reescritos pra usar o que existe de fato aqui.
---

# /mapear-rotinas — Mapeamento de tarefas repetitivas em skills

Skill de descoberta + criação. O objetivo é transformar o que o usuário repete em automações ativas.

## Workflow

### Passo 1 — Entrevista de descoberta

Fazer 3 perguntas, uma por vez:

1. "Quais 3 tarefas você repete toda semana e gostaria de não ter que pensar mais? (ex: 'criar carrossel', 'mandar relatório pro cliente', 'fazer briefing')"
2. "Pra cada uma delas, qual o input típico? (ex: 'um link de notícia', 'um arquivo de planilha', 'um nome de cliente')"
3. "E o que você espera de output? (ex: '5 slides em PNG', 'um email pronto pra enviar', 'um PDF resumindo')"

### Passo 2 — Conferir o que já existe

Olhar a lista de skills disponíveis nesta sessão (nativas do Claude Code +
o que já está em `.claude/skills/` deste projeto) pra ver se alguma das
tarefas mencionadas já é coberta. Se sim, sugerir a existente em vez de criar
uma nova:

> "A tarefa X já é resolvida pela skill `/<nome>` que já existe aqui. Quer
> ativar ela em vez de criar uma nova?"

Não existe catálogo central de skills validadas neste workspace — a
conferência é olhar o que está instalado agora, não ler um arquivo à parte.

### Passo 3 — Proposta de skills

Pra cada tarefa que NÃO tem cobertura existente, propor uma skill no formato:

```
### /<nome-da-skill>
**O que faz:** [uma frase]
**Input:** [o que recebe]
**Output:** [o que entrega]
**Dependências:** [arquivos do _memoria/, identidade/, ou ferramentas externas]
```

Mostrar todas as propostas juntas e perguntar:
> "Quais skills dessa lista você quer que eu crie agora? (pode escolher todas, algumas, ou nenhuma — também pode pedir ajustes)"

### Passo 4 — Criação das skills aprovadas

Pra cada skill aprovada:

1. Criar pasta `.claude/skills/<nome>/`
2. Criar `SKILL.md` com:
   - Frontmatter: `name`, `description` (descreve quando deve ser invocada)
   - Workflow estruturado em fases ou passos
   - Lista de dependências (arquivos de contexto, ferramentas externas)
   - Regras claras (o que sempre fazer, o que nunca fazer)
3. Se a skill precisar de templates ou exemplos, criar dentro da pasta da skill
4. Calibrar tom e regras pelo que já existe neste projeto: `CLAUDE.md` (se
   houver), o estilo dos commits recentes (`git log`), e a memória persistente
   do usuário (`~/.claude/projects/<projeto>/memory/`, listada em
   `MEMORY.md`) — não existe `_memoria/preferencias.md` nem `_memoria/empresa.md`
   aqui, isso é de outro workspace

### Passo 5 — Resumo

```
Criei [N] skills:
✓ /<nome1> — em .claude/skills/<nome1>/SKILL.md
✓ /<nome2> — em .claude/skills/<nome2>/SKILL.md
...

Pra usar: digita / e o nome da skill em qualquer sessão.
Pra ajustar uma skill depois: edita o SKILL.md correspondente.
```

## Regras

- Não criar skill pra tarefa que aconteceu uma vez só. Tem que ser repetível
- Não criar mais de 5 skills por sessão de mapeamento (se o usuário pedir mais, dividir em rodadas)
- Cada skill criada precisa ter um trigger claro (`description` precisa indicar quando invocar) — sem isso a skill nunca é encontrada
- Se a skill depender de uma ferramenta que o usuário não tem (ex: API do Notion sem MCP configurado), avisar antes de criar e oferecer a versão simplificada
