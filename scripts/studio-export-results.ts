// 렌더 결과 묶음 내보내기: 시점별 전달용 이미지(축소) + 원본 대비 + 렌더 입력 스냅샷(재현 근거)
// 실행: DATABASE_URL=... STUDIO_STORAGE_DIR=... npx tsx scripts/studio-export-results.ts <projectId> <outDir>
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { pool, q } from "../src/server/db/pool.js";
import { getFileRow, readFile } from "../src/server/studio/storage.js";

const [projectId, outDir = "docs/studio-results"] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const jobs = await q<any>(
  `SELECT DISTINCT ON (v.name, p.sort) j.*, v.name AS variant, vv.version, p.label, p.sort, p.master_file_id
     FROM studio_render_jobs j JOIN studio_variant_versions vv ON vv.id=j.variant_version_id JOIN studio_variants v ON v.id=vv.variant_id JOIN studio_photos p ON p.id=j.photo_id
    WHERE j.project_id=$1 AND j.status='done' ORDER BY v.name, p.sort, j.finished_at DESC`,
  [projectId],
);
const manifest: any[] = [];
const resize = (b: Buffer) => sharp(b).resize(1600).jpeg({ quality: 88 }).toBuffer();
for (const j of jobs) {
  const tag = `${j.variant === "A안" ? "A" : j.variant === "B안" ? "B" : j.variant}_view${j.sort}`;
  fs.writeFileSync(path.join(outDir, `${tag}.jpg`), await resize(await readFile((await getFileRow(j.outputs.deliveryFileId))!)));
  const origPath = path.join(outDir, `original_view${j.sort}.jpg`);
  if (!fs.existsSync(origPath)) fs.writeFileSync(origPath, await resize(await readFile((await getFileRow(j.master_file_id))!)));
  manifest.push({
    file: `${tag}.jpg`,
    variant: `${j.variant} v${j.version}`,
    view: j.label,
    inputHash: j.input_hash,
    rendererVersion: j.inputs.rendererVersion,
    calibration: { status: j.inputs.photo.calibStatus, camera: j.inputs.photo.camera },
    masksRev: j.inputs.photo.masksRev,
    viewAdjust: j.inputs.photo.viewAdjust,
    state: j.inputs.variant.state,
    assets: Object.values(j.inputs.assets).map((a: any) => ({ name: a.name, versionId: a.versionId, version: a.version, verification: a.verification, fileSha256: a.fileSha })),
    evidence: j.inputs.evidence,
    qa: j.outputs.qa,
    release: j.outputs.release,
    renderMs: j.duration_ms,
  });
}
fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify({ exportedAt: new Date().toISOString(), note: "배치 시뮬레이션. 이미지는 전달용 JPEG를 긴 변 1600px로 줄인 사본. 원본 크기 마스터와 재현 입력은 manifest의 inputHash로 식별.", jobs: manifest }, null, 1));
console.log(`${jobs.length} results → ${outDir}`);
await pool.end();
