FROM node:22-bookworm-slim
WORKDIR /app
COPY server.mjs telegram.mjs provisioner.mjs worker.mjs document-tools.mjs openai-connection.mjs user-profile.mjs ./
COPY public ./public
COPY prompts ./prompts
ENV HOST=0.0.0.0 PORT=3000 TALISMAN_DATA_DIR=/data
VOLUME /data
EXPOSE 3000
CMD ["node","server.mjs"]
