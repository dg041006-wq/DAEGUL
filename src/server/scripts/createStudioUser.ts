// 스튜디오 계정 만들기 (스테이신 운영자 또는 테스트 업체)
// STUDIO_EMAIL=ops@example.com STUDIO_NAME=대표 STUDIO_PASSWORD='10자 이상' STUDIO_WORKSPACE=스테이신 STUDIO_OPS=true npm run studio:create-user
import { pool, q1, tx } from "../db/pool.js";
import { migrate } from "../db/migrate.js";
import { hashPassword } from "../auth/password.js";

const email = process.env.STUDIO_EMAIL, name = process.env.STUDIO_NAME ?? "사용자", pw = process.env.STUDIO_PASSWORD ?? "";
const wsName = process.env.STUDIO_WORKSPACE ?? "스테이신", ops = process.env.STUDIO_OPS === "true";
if (!email || pw.length < 10) {
  console.error("STUDIO_EMAIL과 10자 이상의 STUDIO_PASSWORD가 필요합니다.");
  process.exit(1);
}
await migrate(false);
await tx(async (c) => {
  if (await q1(`SELECT 1 FROM studio_users WHERE lower(email)=lower($1)`, [email], c)) throw new Error("이미 있는 이메일입니다.");
  const ws = await q1<any>(`INSERT INTO studio_workspaces(name, kind) VALUES ($1,$2) RETURNING id`, [wsName, ops ? "internal" : "vendor"], c);
  const u = await q1<any>(`INSERT INTO studio_users(email,name,password_hash,is_ops) VALUES ($1,$2,$3,$4) RETURNING id`, [email, name, hashPassword(pw), ops], c);
  await q1(`INSERT INTO studio_members(workspace_id,user_id,role) VALUES ($1,$2,'owner')`, [ws.id, u.id], c);
});
console.log(`스튜디오 계정 생성: ${email} (${ops ? "스테이신 운영" : "업체"} · ${wsName})`);
await pool.end();
