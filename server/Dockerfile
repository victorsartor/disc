# ── build ────────────────────────────────────────────────────────────────
# Este estágio existe só para compilar o better-sqlite3, que é módulo nativo.
# O toolchain C++ pesa ~430 MB e não serve para nada depois da compilação.
FROM node:22-bookworm-slim AS build

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
# tsx roda TypeScript direto (esbuild por dentro), então o compilador do
# TypeScript não precisa existir aqui. --omit=dev deixa os @types de fora.
RUN npm install --omit=dev tsx

# ── runtime ──────────────────────────────────────────────────────────────
# Sem compilador: o binário do better-sqlite3 vem pronto do estágio de cima.
# Mesma imagem base, então é a mesma glibc e o mesmo Node que compilaram.
FROM node:22-bookworm-slim

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src

EXPOSE 3000
CMD ["npx", "tsx", "src/index.ts"]
