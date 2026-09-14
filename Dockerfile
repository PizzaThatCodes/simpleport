FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install --yes --no-install-recommends miniupnpc \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY public ./public

RUN mkdir -p /data

ENV NODE_ENV=production \
    PORT=3000 \
    SIMPLEPORT_DATA_DIR=/data \
    MINIUPNPC_COMMAND=upnpc \
    SESSION_COOKIE_SECURE=false

EXPOSE 3000
VOLUME ["/data"]

CMD ["node", "server.js"]