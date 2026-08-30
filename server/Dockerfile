# ── build ────────────────────────────────────────────────────────────────
# Este estágio existe só para compilar o better-sqlite3, que é módulo nativo.
# O toolchain C++ pesa ~430 MB e não serve para nada depois da compilação.
FROM node:22-bookworm-slim AS build

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
# Duas etapas de propósito. O tsx está em devDependencies, então
# `npm install --omit=dev tsx` o deixaria de fora e o `npx` do runtime
# tentaria baixá-lo da internet a cada boot — lento e frágil.
# --no-save põe ele em node_modules sem depender de onde está declarado.
# O compilador do TypeScript não vem: o tsx usa esbuild por dentro.
RUN npm install --omit=dev && npm install --no-save tsx

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
