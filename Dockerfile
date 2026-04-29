# rw2026-bestip Dockerfile
FROM node:18-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm install --production --no-audit --no-fund && npm cache clean --force

FROM node:18-alpine
ENV NODE_ENV=production PORT=3000 FILE_PATH=/app/tmp
RUN apk add --no-cache openssl curl gcompat iproute2 coreutils bash unzip ca-certificates tzdata procps && update-ca-certificates
RUN addgroup -S appgroup && adduser -S appuser -G appgroup && mkdir -p /app/tmp && chown -R appuser:appgroup /app
COPY --from=deps /app/node_modules /app/node_modules
COPY --chown=appuser:appgroup . /app
WORKDIR /app
ENTRYPOINT ["node", "/app/index.js"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "const http=require('http');const req=http.get('http://localhost:'+process.env.PORT+'/health',(r)=>{process.exit(r.statusCode===200?0:1)});req.on('error',()=>process.exit(1))"
USER appuser
EXPOSE 3000
