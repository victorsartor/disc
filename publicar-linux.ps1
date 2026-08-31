# Compila o app pra Linux e publica no MESMO feed de atualizacao do
# publicar.ps1 (a pasta atualizacoes/), so que o arquivo de baixo e o
# AppImage.
#
#   .\publicar-linux.ps1
#
# Antes de rodar, suba a versao em client/package.json - a mesma versao dos
# dois lados. O electron-updater compara versao por plataforma
# (latest.yml pro Windows, latest-linux.yml pro Linux), entao publicar so
# um dos dois deixa a outra plataforma pra tras sem avisar ninguem.
#
# POR QUE DOCKER: electron-builder nao cruza pra Linux rodando em Windows
# nativo - falta ferramenta de empacotar AppImage (mksquashfs) que so
# existe em Linux. A imagem electronuserland/builder tem tudo isso pronto;
# rodar o build dentro dela e o mesmo resultado de ter uma maquina Linux.
#
# npm ci roda de novo AQUI DENTRO do container, num volume Docker separado
# (nao em client/node_modules do disco) - os binarios nativos de um build
# Linux nao servem pro build Windows, e vice-versa. Misturar os dois
# quebraria o proximo `publicar.ps1`.
#
# ARQUIVO EM ASCII PURO, DE PROPOSITO. Mesmo motivo do publicar.ps1: no
# PowerShell 5.1 um acento no meio de uma string quebra o parser bem longe
# de onde o caractere esta.

$ErrorActionPreference = "Stop"

$raiz = $PSScriptRoot
$clientDir = Join-Path $raiz "client"
$releaseLinux = Join-Path $clientDir "release-linux"
$destino = Join-Path $raiz "atualizacoes"

# --- Docker precisa estar de pe -------------------------------------------
docker info *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Docker Desktop nao esta rodando. Abra ele e tente de novo." -ForegroundColor Red
    exit 1
}

# --- Dominio: sai do .env, que e quem manda ------------------------------
$dominio = (Get-Content (Join-Path $raiz ".env") |
    Select-String '^PUBLIC_URL=(.+)$').Matches.Groups[1].Value.Trim()

if (-not $dominio) {
    Write-Host "Nao achei PUBLIC_URL no .env." -ForegroundColor Red
    exit 1
}

# Nome e versao saem do package.json, nao ficam escritos aqui - mesma razao
# do publicar.ps1: o nome do AppImage e "<productName>-<versao>.AppImage".
$pkg = Get-Content (Join-Path $raiz "client\package.json") | ConvertFrom-Json
$versao = $pkg.version
$nome = $pkg.build.productName
$appImage = "$nome-$versao.AppImage"

Write-Host ""
Write-Host "Publicando $nome $versao (Linux)" -ForegroundColor Cyan
Write-Host "  servidor : $dominio"
Write-Host ""

# --- Ja existe essa versao publicada? ------------------------------------
# Mesmo motivo do publicar.ps1: republicar a mesma versao com bytes
# diferentes deixa o latest-linux.yml apontando pra um sha512 que nao bate
# com o AppImage que alguem ja baixou pela metade.
if (Test-Path (Join-Path $destino $appImage)) {
    Write-Host "A versao $versao ja esta publicada pro Linux." -ForegroundColor Yellow
    Write-Host "Suba a versao em client/package.json antes de publicar de novo." -ForegroundColor Yellow
    exit 1
}

# --- Volumes Docker persistentes ------------------------------------------
# node_modules do Linux fica isolado do node_modules do Windows (ver
# comentario do topo). Os caches de Electron/electron-builder ficam de um
# build pro outro so pra nao rebaixar ~110 MB toda vez.
foreach ($vol in @("disneia-linux-modules", "disneia-linux-cache-electron", "disneia-linux-cache-builder")) {
    docker volume create $vol *> $null
}

# --- Compila dentro do container ------------------------------------------
Write-Host "Compilando (dentro do container Linux)..." -ForegroundColor Cyan

docker run --rm `
    -v "${clientDir}:/project" `
    -v "disneia-linux-modules:/project/node_modules" `
    -v "disneia-linux-cache-electron:/root/.cache/electron" `
    -v "disneia-linux-cache-builder:/root/.cache/electron-builder" `
    -e "VITE_SERVER_URL=$dominio" `
    -e "ELECTRON_CACHE=/root/.cache/electron" `
    -e "ELECTRON_BUILDER_CACHE=/root/.cache/electron-builder" `
    -w /project `
    electronuserland/builder:20 `
    bash -lc "npm ci --no-audit --no-fund && npm run build && npx electron-builder --linux AppImage --publish never -c.directories.output=release-linux"

if ($LASTEXITCODE -ne 0) { throw "o build falhou" }

# --- Copia o que o electron-updater precisa ------------------------------
# latest-linux.yml : versao e hash, e o que o app le pra decidir se atualiza
# .AppImage        : o executavel - o AppImage inteiro E o pacote, sem
#                     instalador separado, e sem .blockmap (o updater baixa
#                     o arquivo inteiro de novo no Linux, nao so o que mudou)
New-Item -ItemType Directory -Force -Path $destino | Out-Null

$arquivos = @("latest-linux.yml", $appImage)

foreach ($arq in $arquivos) {
    $origem = Join-Path $releaseLinux $arq
    if (-not (Test-Path $origem)) {
        Write-Host "Nao achei $arq em client\release-linux." -ForegroundColor Red
        exit 1
    }
    Copy-Item $origem $destino -Force
    Write-Host "  copiado: $arq" -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "Publicado." -ForegroundColor Green
Write-Host ""
Write-Host "Confira que o servidor esta servindo:" -ForegroundColor Cyan
Write-Host "  $dominio/atualizacoes/latest-linux.yml" -ForegroundColor White
Write-Host ""
Write-Host "Quem abrir o app no Linux agora recebe a $versao sozinho." -ForegroundColor DarkGray
Write-Host ""
