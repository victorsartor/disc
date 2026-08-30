# Prepara o servidor para rodar na tailnet.
# Roda UMA vez (e de novo a cada ~80 dias, para renovar o certificado).
#
#   .\preparar-tailscale.ps1

$ErrorActionPreference = "Stop"

$ts = "C:\Program Files\Tailscale\tailscale.exe"
if (-not (Test-Path $ts)) {
    Write-Host "Tailscale nao encontrado." -ForegroundColor Red
    Write-Host "Instale em https://tailscale.com/download/windows e faca login." -ForegroundColor Yellow
    exit 1
}

# --- Nome e IP desta maquina na tailnet ---------------------------------
$statusJson = & $ts status --json | ConvertFrom-Json
$dominio = $statusJson.Self.DNSName.TrimEnd('.')
$ip = ($statusJson.Self.TailscaleIPs | Where-Object { $_ -notmatch ':' } | Select-Object -First 1)

if (-not $dominio -or -not $ip) {
    Write-Host "Nao consegui ler nome/IP da tailnet." -ForegroundColor Red
    Write-Host "Confirme que voce fez login: & '$ts' up" -ForegroundColor Yellow
    exit 1
}

Write-Host ""
Write-Host "Maquina na tailnet" -ForegroundColor Cyan
Write-Host "  dominio : $dominio"
Write-Host "  ip      : $ip"
Write-Host ""

# --- Certificado HTTPS de verdade, emitido pelo Tailscale ---------------
New-Item -ItemType Directory -Force -Path .\certs | Out-Null

Write-Host "Gerando certificado..." -ForegroundColor Cyan
& $ts cert --cert-file .\certs\tailscale.crt --key-file .\certs\tailscale.key $dominio

if (-not (Test-Path .\certs\tailscale.crt)) {
    Write-Host ""
    Write-Host "O certificado nao foi gerado." -ForegroundColor Red
    Write-Host "Va no painel do Tailscale e ligue as duas opcoes:" -ForegroundColor Yellow
    Write-Host "  https://login.tailscale.com/admin/dns" -ForegroundColor Yellow
    Write-Host "    - MagicDNS" -ForegroundColor Yellow
    Write-Host "    - HTTPS Certificates" -ForegroundColor Yellow
    exit 1
}

Write-Host "Certificado gerado em .\certs" -ForegroundColor Green

# --- Chaves do LiveKit, se ainda nao existirem --------------------------
if (Test-Path .\.env) {
    Write-Host ""
    Write-Host ".env ja existe - nao vou sobrescrever." -ForegroundColor Yellow
    Write-Host "Confira se estas linhas batem com o que esta no arquivo:" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "  DOMAIN=$dominio"
    Write-Host "  PUBLIC_URL=https://$dominio"
    Write-Host "  LIVEKIT_URL=wss://$dominio"
    Write-Host "  TAILSCALE_IP=$ip"
} else {
    Write-Host ""
    Write-Host "Gerando chaves do LiveKit..." -ForegroundColor Cyan
    $chaves = docker run --rm livekit/livekit-server generate-keys
    $apiKey = ($chaves | Select-String "API Key:").ToString().Split(":")[1].Trim()
    $apiSecret = ($chaves | Select-String "API Secret:").ToString().Split(":")[1].Trim()
    $sessao = -join ((48..57) + (97..102) | Get-Random -Count 64 | ForEach-Object { [char]$_ })

    Copy-Item .env.example .env
    (Get-Content .env) `
        -replace '^DOMAIN=.*', "DOMAIN=$dominio" `
        -replace '^PUBLIC_URL=.*', "PUBLIC_URL=https://$dominio" `
        -replace '^LIVEKIT_URL=.*', "LIVEKIT_URL=wss://$dominio" `
        -replace '^LIVEKIT_API_KEY=.*', "LIVEKIT_API_KEY=$apiKey" `
        -replace '^LIVEKIT_API_SECRET=.*', "LIVEKIT_API_SECRET=$apiSecret" `
        -replace '^SESSION_SECRET=.*', "SESSION_SECRET=$sessao" `
        -replace '^TAILSCALE_IP=.*', "TAILSCALE_IP=$ip" |
        Set-Content .env -Encoding utf8
    Write-Host ".env criado com dominio, chaves e segredo preenchidos." -ForegroundColor Green
}

Write-Host ""
Write-Host "---------------------------------------------------------" -ForegroundColor DarkGray
Write-Host "FALTA VOCE FAZER:" -ForegroundColor Cyan
Write-Host ""
Write-Host "1. No .env, preencha GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET"
Write-Host "   e ALLOWED_EMAILS."
Write-Host ""
Write-Host "2. No console do Google, adicione esta redirect URI:"
Write-Host "   https://$dominio/auth/callback" -ForegroundColor White
Write-Host ""
Write-Host "3. Suba o servidor:"
Write-Host "   docker compose -f docker-compose.tailscale.yml up -d" -ForegroundColor White
Write-Host ""
Write-Host "4. Compile o app apontando pra ca:"
Write-Host "   cd client" -ForegroundColor White
Write-Host "   `$env:VITE_SERVER_URL = `"https://$dominio`"" -ForegroundColor White
Write-Host "   npm run dist" -ForegroundColor White
Write-Host "---------------------------------------------------------" -ForegroundColor DarkGray
Write-Host ""
