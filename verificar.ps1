# Checagem rapida do servidor. Roda no PC que hospeda, com o Docker aberto.
#
#   .\verificar.ps1
#
# ARQUIVO EM ASCII PURO, DE PROPOSITO. O PowerShell 5.1 le arquivo UTF-8 sem
# BOM como ANSI, e um acento no meio de uma string quebra o parser bem longe
# de onde o caractere esta - erro que nao ajuda em nada a achar a causa.

$ErrorActionPreference = "Stop"
$compose = "docker-compose.tailscale.yml"
$falhas = 0

function Ok($msg)    { Write-Host "[ok]    $msg" -ForegroundColor Green }
function Falha($msg) { Write-Host "[FALHA] $msg" -ForegroundColor Red; $script:falhas++ }
function Aviso($msg) { Write-Host "[aviso] $msg" -ForegroundColor Yellow }

Write-Host ""
Write-Host "=== Concord: checagem do servidor ===" -ForegroundColor Cyan
Write-Host ""

# 1. Docker de pe --------------------------------------------------------
docker info *> $null
if ($?) {
    Ok "Docker Desktop rodando"
} else {
    Falha "Docker Desktop nao esta rodando. Abra ele e espere a baleia ficar verde."
    Write-Host ""
    exit 1
}

# 2. Tailscale conectado -------------------------------------------------
$dominio = $null
try {
    $ts = tailscale status --json | ConvertFrom-Json
    if ($ts.BackendState -eq "Running") {
        $dominio = $ts.Self.DNSName.TrimEnd(".")
        Ok "Tailscale conectado como $dominio"
    } else {
        Falha "Tailscale nao esta conectado (estado: $($ts.BackendState))"
    }
} catch {
    Falha "Nao consegui falar com o Tailscale. Ele esta instalado e logado?"
}

# 3. Certificado ainda valido -------------------------------------------
# O Tailscale emite cert de 90 dias. Vencido, o login do Google para de
# funcionar sem erro claro no app - so uma tela que nao volta.
$cert = Join-Path $PSScriptRoot "certs\tailscale.crt"
if (Test-Path $cert) {
    $c = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 $cert
    $dias = [math]::Floor(($c.NotAfter - (Get-Date)).TotalDays)
    if ($dias -lt 0)      { Falha "Certificado VENCIDO. Rode: tailscale cert $dominio" }
    elseif ($dias -lt 14) { Aviso "Certificado vence em $dias dias. Renove: tailscale cert $dominio" }
    else                  { Ok "Certificado valido por mais $dias dias" }
} else {
    Falha "Certificado nao encontrado em certs\. Rode: .\preparar-tailscale.ps1"
}

# 4. Containers no ar ----------------------------------------------------
$rodando = docker compose -f $compose ps --services --filter "status=running"
foreach ($s in @("caddy", "livekit", "redis", "ingress", "server")) {
    if ($rodando -contains $s) { Ok "container $s" }
    else { Falha "container $s parado. Veja: docker compose -f $compose logs $s" }
}

# 5. O servidor responde de fora -----------------------------------------
# 302 e o certo aqui: /auth/login redireciona pro Google.
if ($dominio) {
    try {
        $r = Invoke-WebRequest "https://$dominio/auth/login" -MaximumRedirection 0 `
             -UseBasicParsing -TimeoutSec 10 -ErrorAction SilentlyContinue
        $codigo = $r.StatusCode
    } catch {
        $codigo = $_.Exception.Response.StatusCode.value__
    }
    if ($codigo -eq 302) { Ok "Login respondendo (redireciona pro Google)" }
    else { Falha "Login respondeu $codigo, esperado 302" }
}

# 6. Quem esta na allowlist ----------------------------------------------
$env_ = Join-Path $PSScriptRoot ".env"
if (Test-Path $env_) {
    $linha = Select-String -Path $env_ -Pattern "^ALLOWED_EMAILS=" | Select-Object -First 1
    if ($linha) {
        $lista = ($linha.Line -replace "^ALLOWED_EMAILS=", "").Split(",") | Where-Object { $_ }
        Ok "$($lista.Count) e-mail(s) liberado(s):"
        foreach ($e in $lista) { Write-Host "          $($e.Trim())" -ForegroundColor Gray }
    } else {
        Falha "ALLOWED_EMAILS nao existe no .env - ninguem consegue entrar"
    }
}

# 7. Quem esta na tailnet ------------------------------------------------
if ($ts) {
    # Sem nenhum outro dispositivo, a chave Peer nem existe no JSON - e um
    # PSObject.Properties em cima de null devolve uma entrada fantasma.
    $peers = if ($null -eq $ts.Peer) { @() } else { @($ts.Peer.PSObject.Properties.Value) }
    if ($peers.Count -eq 0) {
        Aviso "Nenhum outro dispositivo na tailnet ainda"
    } else {
        Ok "$($peers.Count) dispositivo(s) na tailnet:"
        foreach ($p in $peers) {
            $via = if ($p.CurPeer -or $p.Relay -eq "") { "direct" } else { "relay ($($p.Relay))" }
            $estado = if ($p.Online) { $via } else { "offline" }
            $cor = if ($p.Online -and $via -eq "direct") { "Gray" } else { "Yellow" }
            Write-Host "          $($p.HostName) - $estado" -ForegroundColor $cor
        }
        Write-Host "          (relay aguenta voz, mas nao os 20 Mbps da tela)" -ForegroundColor DarkGray
    }
}

Write-Host ""
if ($falhas -eq 0) {
    Write-Host "Tudo certo. Pode chamar a galera." -ForegroundColor Green
} else {
    Write-Host "$falhas problema(s) acima." -ForegroundColor Red
}
Write-Host ""
