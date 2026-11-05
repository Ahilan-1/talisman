FROM node:22-bookworm-slim AS node
FROM lscr.io/linuxserver/webtop:ubuntu-xfce
COPY --from=node /usr/local /usr/local
WORKDIR /opt/talisman
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY worker.mjs prompt.mjs ./
COPY assistant.mjs ./
COPY computer.mjs computer-service.mjs ./
COPY document-tools.mjs ./
COPY prompts ./prompts
COPY desktop/skills/ /opt/talisman/skills/
COPY desktop/services/ /custom-services.d/
RUN chmod +x /custom-services.d/*
