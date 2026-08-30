# Convidar um amigo pro teste

Checklist pra hoje. Cada seção marcada **[pronto]** já foi conferida nesta
máquina — não precisa refazer, só confirmar se ainda bate.

> **O domínio mudou.** Era `victor.taild0e099.ts.net`, mas esse nome não
> existe mais no DNS da tailnet — a máquina foi renomeada em algum momento.
> O nome real é **`sar-pc.taild0e099.ts.net`**. Certificado, `.env`, servidor
> e app já foram refeitos pra ele. Só o console do Google ficou pra trás
> (passo 3).

## 1. Servidor — [pronto]

```
docker compose -f docker-compose.tailscale.yml ps
```

5 containers (`caddy`, `livekit`, `redis`, `ingress`, `server`) de pé,
domínio `sar-pc.taild0e099.ts.net`, certificado válido até 28/11/2026.

## 2. Allowlist do app — [pronto]

O e-mail do convidado já está em `.env` → `ALLOWED_EMAILS` (que fica fora do
git, junto com os outros segredos). Pra convidar mais alguém, acrescente na
mesma linha, separado por vírgula, e suba de novo:

```
docker compose -f docker-compose.tailscale.yml up -d server
```

## 3. Google OAuth — ⚠️ FAZER AGORA

**Esse é o único passo que ainda bloqueia o login.** A redirect URI cadastrada
aponta pro domínio antigo, que não resolve mais.

- [ ] [console.cloud.google.com](https://console.cloud.google.com) → APIs &
      Services → Credentials → seu OAuth Client → adicionar a redirect URI:
      ```
      https://sar-pc.taild0e099.ts.net/auth/callback
      ```
      (pode deixar a antiga lá, não atrapalha)
- [ ] OAuth consent screen → **Test users** → adicionar o e-mail do
      convidado (o mesmo que está no `ALLOWED_EMAILS`) — sem isso o Google
      barra ele antes mesmo da allowlist

## 4. Dar acesso na tailnet

Sem isso ele não alcança `sar-pc.taild0e099.ts.net` — é uma tailnet privada,
não tem IP público nem DNS normal por trás.

- [ ] Abrir [login.tailscale.com/admin/machines](https://login.tailscale.com/admin/machines)
- [ ] Na máquina `sar-pc` → **⋯** → **Share...** → gerar o link de convite
- [ ] Mandar o link pro amigo
- [ ] Ele instala o Tailscale ([tailscale.com/download](https://tailscale.com/download)),
      abre o link, aceita, loga com a conta dele (Google/Microsoft/GitHub —
      não precisa ser a mesma conta do grupo)
- [ ] Confirmar que ele apareceu:
      ```
      tailscale status
      ```

## 5. Mandar o instalador

Manda o **`Disneia Setup 0.6.0.exe`** (75 MB), que está em
`client/release/` e também em `atualizacoes/`.

Daqui pra frente ele não recebe mais `.exe` na mão: o app se atualiza sozinho
quando você publica (ver [ATUALIZAR.md](ATUALIZAR.md)).

> Se ele já tinha instalado o **Concord**, não precisa mandar nada — é só
> abrir o Concord que ele se atualiza pra Disneia sozinho. Mas o Concord
> velho fica instalado do lado, ocupando ~230 MB à toa: vale ele
> desinstalar em Configurações → Aplicativos → Concord → Desinstalar.
> A sessão também zera na virada de nome, então ele loga com o Google
> mais uma vez.

- [ ] Mandar o `.exe` pro amigo (Drive, WeTransfer, pendrive — o que for mais
      fácil; o Tailscale entre vocês dois ainda não está de pé nesse ponto,
      então Taildrop só funciona *depois* do passo 4)

## 6. Ele instala e loga

- [ ] Abre o instalador, roda a Disneia
- [ ] Login com Google → aceita o consentimento (tela vai avisar "app não
      verificado", é esperado em modo de teste — **Avançado** → **Ir para
      Disneia**)
- [ ] Deep link `disc://` devolve pro app depois do login

## 7. O que testar com os dois conectados

Isso é o que testar sozinho **não** cobre — é o motivo de testar em dupla:

- [ ] Voz entre os dois numa sala (qualidade, latência, hold-to-talk)
- [ ] Quem está ensurdecido aparece pro outro (`useRoom.ts`, feature nova)
- [ ] Chat com histórico
- [ ] Compartilhar tela — pelo botão do app primeiro; OBS/WHIP depois se
      quiser testar jogo em fullscreen exclusivo
- [ ] Travessia de NAT de verdade (o teste local nunca passa por isso)

## Se algo falhar

| Sintoma | Onde olhar |
| --- | --- |
| Login do Google dá erro `redirect_uri_mismatch` | Passo 3 — a URI nova não foi cadastrada |
| Login do Google dá "acesso bloqueado" | E-mail não está em Test users (passo 3) |
| Entra no Google mas o app recusa | E-mail fora do `ALLOWED_EMAILS` (passo 2) |
| App não conecta, fica carregando | Amigo não está na tailnet ainda (passo 4) |
| Conecta mas sem áudio entre vocês | `docker compose -f docker-compose.tailscale.yml logs -f livekit` |
| Certificado expirado | `.\preparar-tailscale.ps1` (o cert do Tailscale dura ~90 dias) |

> Se o domínio um dia parar de resolver de novo, compare os dois:
> ```powershell
> (tailscale status --json | ConvertFrom-Json).Self.DNSName   # o real
> Get-Content .env | Select-String '^DOMAIN='                 # o configurado
> ```
> Se divergirem, foi renomeação de máquina — refaça o passo do
> `preparar-tailscale.ps1` e a redirect URI do Google.
