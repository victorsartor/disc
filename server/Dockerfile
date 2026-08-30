FROM node:22-bookworm-slim

# better-sqlite3 é módulo nativo — precisa de toolchain pra compilar
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev && npm install tsx typescript

COPY src ./src
COPY tsconfig.json ./

EXPOSE 3000
CMD ["npx", "tsx", "src/index.ts"]
