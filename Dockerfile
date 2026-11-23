# STAYSCENE OFFICE + Styling Studio — 단일 컨테이너 (API + 화면 + 워커/정기 보고 + 스튜디오 렌더 워커)
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
# 스튜디오 3D 렌더 워커: 헤드리스 Chromium(SwiftShader 소프트웨어 WebGL) + 한글 글꼴(비교 이미지 라벨)
RUN apt-get update && apt-get install -y --no-install-recommends chromium fonts-noto-cjk ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production PORT=3000 RUN_WORKER_IN_PROCESS=true TZ=UTC \
    STUDIO_CHROMIUM_PATH=/usr/bin/chromium STUDIO_STORAGE_DIR=/var/data/studio
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist-server ./dist-server
COPY --from=build /app/dist-web ./dist-web
COPY --from=build /app/dist-render ./dist-render
COPY --from=build /app/src/server/db/migrations ./src/server/db/migrations
# 기본 카탈로그(CC0 소파)와 샘플 프로젝트 사진
COPY --from=build /app/samples/assets ./samples/assets
COPY --from=build /app/samples/room ./samples/room
COPY package.json ./
RUN mkdir -p /var/data/studio && chown -R node:node /var/data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist-server/server/index.js"]
