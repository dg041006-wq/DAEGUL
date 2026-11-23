#!/usr/bin/env bash
# 로컬 확인용 서버 재시작 (빌드된 화면 + API + 렌더 워커). 운영 배포에는 사용하지 않는다.
pkill -f "src/server/index.ts" 2>/dev/null; sleep 1
export DATABASE_URL=${DATABASE_URL:-postgres://postgres:postgres@localhost:5432/stayscene}
export SESSION_SECRET=${SESSION_SECRET:-dev-session-secret-dev-session-secret-xx}
export STUDIO_STORAGE_DIR=${STUDIO_STORAGE_DIR:-data/studio}
nohup npx tsx src/server/index.ts > "${LOG:-/tmp/stayscene-dev.log}" 2>&1 &
for i in $(seq 1 30); do curl -sf localhost:${PORT:-3000}/api/health >/dev/null && { echo "server up"; exit 0; }; sleep 1; done
echo "server failed"; tail -20 "${LOG:-/tmp/stayscene-dev.log}"; exit 1
