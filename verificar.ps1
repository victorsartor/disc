# Checagem rápida do servidor caseiro.
#   .\verificar.ps1
#
# Roda no notebook servidor, depois que o Docker Desktop subiu.

$dominio = $env:DISC_DOMINIO
if (-not $dominio) {
    $dominio = Read-Host "Qual o seu dominio (ex: seuservidor.duckdns.org)"
}

Write-Host ""
Write-Host "Verificando $dominio" -ForegroundColor Cyan
Write-Host ""

# 1. Docker de pe?
try {
    docker info *> $null
    if ($?) { Write-Host "[ok]    Docker Desktop rodando" -ForegroundColor Green }
} catch {
    Write-Host "[FALHA] Docker Desktop nao esta rodando. Abra ele e espere a baleia ficar verde." -ForegroundColor Red
    exit 1
}

# 2. Containers no ar?
$subiram = docker compose -f docker-compose.home.yml ps --services --filter "status=running"
$esperados = @("duckdns", "caddy", "livekit", "redis", "ingress", "server")
foreach ($s in $esperados) {
    if ($subiram -contains $s) {
        Write-Host "[ok]    container $s" -ForegroundColor Green
    } else {
        Write-Host "[FALHA] container $s parado" -ForegroundColor Red
    }
}

# 3. O dominio aponta pra ca?
$meuIp = (Invoke-RestMethod -Uri "https://api.ipify.org?format=json").ip
try {
    $dns = (Resolve-DnsName $dominio -Type A -ErrorAction Stop | Select-Object -First 1).IPAddress
} catch {
    $dns = "nao resolveu"
}

Write-Host ""
Write-Host "IP desta rede : $meuIp"
Write-Host "IP do dominio : $dns"

if ($dns -eq $meuIp) {
    Write-Host "[ok]    DuckDNS atualizado" -ForegroundColor Green
} else {
    Write-Host "[FALHA] O dominio aponta pro IP errado. Espere 5 min ou veja: docker compose -f docker-compose.home.yml logs duckdns" -ForegroundColor Red
}

# 4. O servidor responde de fora?
Write-Host ""
try {
    $r = Invoke-RestMethod -Uri "https://$dominio/health" -TimeoutSec 12
    if ($r.ok) { Write-Host "[ok]    Servidor respondendo com HTTPS valido" -ForegroundColor Green }
} catch {
    Write-Host "[FALHA] Sem resposta em https://$dominio/health" -ForegroundColor Red
    Write-Host "        Quase sempre e porta nao redirecionada no roteador," -ForegroundColor Yellow
    Write-Host "        ou o certificado ainda sendo emitido (espere 1 min)." -ForegroundColor Yellow
}

Write-Host ""
