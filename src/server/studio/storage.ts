// 비공개 파일 저장소. 기본은 로컬 디렉터리(운영에서는 영구 디스크 또는 S3 호환 저장소 어댑터로 교체).
// 파일은 인증된 라우트를 통해서만 내려가며, 저장 키는 추측 불가능한 UUID.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { q1, type Db, pool } from "../db/pool.js";
import { studioConfig } from "./config.js";

export interface StoredFile {
  id: string;
  workspace_id: string | null;
  kind: string;
  storage_key: string;
  mime: string;
  bytes: number;
  sha256: string;
  width: number | null;
  height: number | null;
}

function keyPath(key: string) {
  const p = path.resolve(studioConfig.storageDir, key);
  if (!p.startsWith(path.resolve(studioConfig.storageDir) + path.sep)) throw new Error("invalid storage key");
  return p;
}

export async function putFile(
  o: { workspaceId: string | null; kind: string; mime: string; data: Buffer; width?: number | null; height?: number | null; ext: string },
  db: Db = pool,
): Promise<StoredFile> {
  const id = crypto.randomUUID();
  const key = `${o.workspaceId ?? "catalog"}/${o.kind}/${id}.${o.ext}`;
  const p = keyPath(key);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, o.data, { flag: "wx" });
  const sha = crypto.createHash("sha256").update(o.data).digest("hex");
  return (await q1<StoredFile>(
    `INSERT INTO studio_files(id, workspace_id, kind, storage_key, mime, bytes, sha256, width, height)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [id, o.workspaceId, o.kind, key, o.mime, o.data.length, sha, o.width ?? null, o.height ?? null],
    db,
  ))!;
}

export async function readFile(f: Pick<StoredFile, "storage_key">): Promise<Buffer> {
  return fs.readFile(keyPath(f.storage_key));
}

export async function getFileRow(id: string, db: Db = pool) {
  return q1<StoredFile>(`SELECT * FROM studio_files WHERE id=$1 AND deleted_at IS NULL`, [id], db);
}

export async function deleteFileData(f: Pick<StoredFile, "storage_key" | "id">) {
  await fs.rm(keyPath(f.storage_key), { force: true });
  await pool.query(`UPDATE studio_files SET deleted_at=now() WHERE id=$1`, [f.id]);
}
