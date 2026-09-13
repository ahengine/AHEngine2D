# syntax=docker/dockerfile:1.7

FROM node:24-alpine AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS dependencies
COPY package.json package-lock.json ./
RUN npm ci

FROM base AS builder
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:24-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    AH2D_AUTH_STORE_PATH=/var/lib/ah2d/auth-store.json \
    AH2D_COLLAB_DATA_DIR=/var/lib/ah2d/collaboration

RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 --ingroup nodejs nextjs \
    && mkdir -p /var/lib/ah2d/collaboration \
    && chown -R nextjs:nodejs /var/lib/ah2d

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# These files are read dynamically by authenticated route handlers and by the
# Universal Project validator, so they must remain beside standalone server.js.
COPY --from=builder --chown=nextjs:nodejs /app/AH2DEdtior.html ./AH2DEdtior.html
COPY --from=builder --chown=nextjs:nodejs /app/engine ./engine

USER nextjs

VOLUME ["/var/lib/ah2d"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/login || exit 1

CMD ["node", "server.js"]
