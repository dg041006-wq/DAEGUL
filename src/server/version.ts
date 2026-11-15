// 빌드 식별자: 배포 플랫폼 커밋 값 → 빌드된 index.html 해시 → 'dev'
// 화면은 이 값이 바뀌면 '새 버전' 안내를 띄운다.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function compute() {
  const env = process.env.BUILD_ID || process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT;
  if (env) return env.slice(0, 12);
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const p of [path.resolve(here, "../../dist-web/index.html"), path.resolve(here, "../../../dist-web/index.html")]) {
    if (fs.existsSync(p)) return crypto.createHash("sha1").update(fs.readFileSync(p)).digest("hex").slice(0, 12);
  }
  return "dev";
}

export const BUILD_ID = compute();
