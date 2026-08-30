# Compila o app e publica no feed de atualizacao do servidor.
#
#   .\publicar.ps1
#
# Antes de rodar, suba a versao em client/package.json. O electron-updater
# compara versao, entao publicar sem subir nao atualiza ninguem.
#
# ARQUIVO EM ASCII PURO, DE PROPOSITO. O PowerShell 5.1 le arquivo UTF-8 sem
# BOM como ANSI, e um acento no meio de uma string quebra o parser bem longe
# de onde o caractere esta.

$ErrorActionPreference = "Stop"

$raiz = $PSScriptRoot
$release = Join-Path $raiz "client\release"
$destino = Join-Path $raiz "atualizacoes"

# --- Dominio: sai do .env, que e quem manda ------------------------------
$dominio = (Get-Content (Join-Path $raiz ".env") |
    Select-String '^PUBLIC_URL=(.+)$').Matches.Groups[1].Value.Trim()

if (-not $dominio) {
    Write-Host "Nao achei PUBLIC_URL no .env." -ForegroundColor Red
    exit 1
}

# Nome e versao saem do package.json, nao ficam escritos aqui - o nome do
# instalador e "<productName> Setup <versao>.exe", entao renomear o app sem
# renomear isto quebraria a copia em silencio.
$pkg = Get-Content (Join-Path $raiz "client\package.json") | ConvertFrom-Json
$versao = $pkg.version
$nome = $pkg.build.productName

Write-Host ""
Write-Host "Publicando $nome $versao" -ForegroundColor Cyan
Write-Host "  servidor : $dominio"
Write-Host ""

# --- Ja existe essa versao publicada? ------------------------------------
# Republicar a mesma versao com bytes diferentes deixa o latest.yml apontando
# pra um sha512 que nao bate com o instalador que alguem ja baixou pela metade.
if (Test-Path (Join-Path $destino "$nome Setup $versao.exe")) {
    Write-Host "A versao $versao ja esta publicada." -ForegroundColor Yellow
    Write-Host "Suba a versao em client/package.json antes de publicar de novo." -ForegroundColor Yellow
    exit 1
}

# --- Compila -------------------------------------------------------------
# A URL entra no bundle na hora do build (ver vite.config.ts) e tambem vira
# o feed de atualizacao no app-update.yml. Sem ela o app aponta pra localhost.
$env:VITE_SERVER_URL = $dominio

Write-Host "Compilando..." -ForegroundColor Cyan
Push-Location (Join-Path $raiz "client")
try {
    npm run dist
    if ($LASTEXITCODE -ne 0) { throw "o build falhou" }
} finally {
    Pop-Location
}

# --- Copia o que o electron-updater precisa ------------------------------
# latest.yml  : versao e hash, e o que o app le pra decidir se atualiza
# .exe        : o instalador
# .blockmap   : mapa de blocos, deixa o app baixar so o que mudou
New-Item -ItemType Directory -Force -Path $destino | Out-Null

$arquivos = @(
    "latest.yml",
    "$nome Setup $versao.exe",
    "$nome Setup $versao.exe.blockmap"
)

foreach ($nome in $arquivos) {
    $origem = Join-Path $release $nome
    if (-not (Test-Path $origem)) {
        Write-Host "Nao achei $nome em client\release." -ForegroundColor Red
        exit 1
    }
    Copy-Item $origem $destino -Force
    Write-Host "  copiado: $nome" -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "Publicado." -ForegroundColor Green
Write-Host ""
Write-Host "Confira que o servidor esta servindo:" -ForegroundColor Cyan
Write-Host "  $dominio/atualizacoes/latest.yml" -ForegroundColor White
Write-Host ""
Write-Host "Quem abrir o app agora recebe a $versao sozinho." -ForegroundColor DarkGray
Write-Host ""
