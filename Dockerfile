# Playwright's image ships Chromium + all of its system libraries.
FROM mcr.microsoft.com/playwright:v1.56.0-noble

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg fonts-noto-color-emoji fonts-noto-cjk \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY asset-mirror ./asset-mirror

ENV NODE_ENV=production \
    PORT=3000 \
    STORAGE_DIR=/data \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN mkdir -p /data && chown -R pwuser:pwuser /data /app/asset-mirror
USER pwuser
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
