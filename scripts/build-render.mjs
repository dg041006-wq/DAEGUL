// 렌더 워커용 브라우저 번들 생성 (편집기와 같은 scene.ts). 결과: dist-render/render.js
import { build } from "esbuild";
import fs from "node:fs";

export async function buildRenderBundle(outfile = "dist-render/render.js") {
  const r = await build({
    entryPoints: ["src/web/studio/render/entry.ts"],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "chrome120",
    minify: true,
    write: false,
    logLevel: "silent",
  });
  fs.mkdirSync("dist-render", { recursive: true });
  fs.writeFileSync(outfile, r.outputFiles[0].contents);
  return outfile;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  buildRenderBundle().then((f) => console.log("render bundle:", f));
}
