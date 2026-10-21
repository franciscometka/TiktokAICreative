# Lote 7 — imagem ÚNICA para o Render Web Service (API) e o Render Background Worker.
# Mesma versão do código nos dois serviços; muda só o comando:
#   API:    npm run start:api
#   Worker: npm run worker
#
# Contém: Node 22, dependências do Chrome Headless Shell (Remotion), o Chrome Headless Shell
# baixado na build (versão fixada pelo Remotion) e o FFmpeg/ffprobe do pacote
# @remotion/compositor-linux-x64-gnu (instalado pelo npm ci). Nenhum segredo entra na imagem.

FROM node:22.12-bookworm-slim

# Bibliotecas que o Chrome Headless Shell precisa no Debian (lista da documentação do Remotion)
# + fontes para render de legendas/emoji. Sem pacotes extras.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      libnss3 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 libgbm1 libasound2 libxrandr2 \
      libxkbcommon0 libxfixes3 libxcomposite1 libxdamage1 libpango-1.0-0 libcairo2 libcups2 \
      fonts-noto-color-emoji \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Build reproduzível: lockfile obrigatório. tsx (devDependency) executa o TypeScript em runtime.
COPY package.json package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund

COPY . .

# Chrome Headless Shell do Remotion (fica em node_modules/.remotion). Só download na BUILD.
RUN npm run render:setup

ENV NODE_ENV=production \
    RENDERER=remotion \
    WORKER_TMP_ROOT=/tmp/tiktok-ai \
    PORT=4000

# Usuário sem privilégios; /tmp para o workspace temporário dos jobs.
RUN mkdir -p /tmp/tiktok-ai && chown -R node:node /tmp/tiktok-ai /app/node_modules/.remotion
USER node

EXPOSE 4000
# Padrão = worker; o Render Web Service sobrescreve com `npm run start:api`.
CMD ["npm", "run", "worker"]
