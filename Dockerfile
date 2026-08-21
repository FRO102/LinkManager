FROM node:20-alpine

WORKDIR /app

# Instala dependências primeiro (cache de layers do Docker)
COPY package.json ./
RUN npm install --omit=dev

# Copia o resto do código da app
COPY server.js ./
COPY public ./public

# Pasta onde os dados (links.json) vão ficar persistidos
RUN mkdir -p /app/data
ENV DATA_DIR=/app/data
ENV PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "server.js"]
