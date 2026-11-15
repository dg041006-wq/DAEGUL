// 최초 대표 계정 생성 (공개 회원가입 없음).
// 사용법: OWNER_EMAIL=... OWNER_NAME=... OWNER_PASSWORD=... ORG_NAME=스테이신 npm run admin:create-owner
// 비밀번호는 셸 기록에 남지 않도록 .env 또는 일회성 환경변수로 전달하세요.
import { migrate } from "../db/migrate.js";
import { pool, q, q1, tx } from "../db/pool.js";
import { hashPassword } from "../auth/password.js";
import { createOrganization } from "../lib/org.js";

async function main() {
  const email = process.env.OWNER_EMAIL;
  const name = process.env.OWNER_NAME ?? "대표";
  const password = process.env.OWNER_PASSWORD;
  const orgName = process.env.ORG_NAME ?? "스테이신";
  if (!email || !password || password.length < 10) {
    console.error("OWNER_EMAIL, OWNER_PASSWORD(10자 이상) 환경변수가 필요합니다.");
    process.exit(1);
  }
  await migrate(false);
  const existing = await q1(`SELECT id FROM users WHERE lower(email)=lower($1)`, [email]);
  if (existing) {
    console.error("이미 존재하는 이메일입니다.");
    process.exit(1);
  }
  const orgId = await tx(async (c) => {
    const org = await q1<{ id: string }>(`SELECT id FROM organizations ORDER BY created_at LIMIT 1`, [], c);
    const oid = org?.id ?? (await createOrganization(orgName, c));
    const u = await q1<{ id: string }>(`INSERT INTO users(email, name, password_hash) VALUES ($1,$2,$3) RETURNING id`, [email.toLowerCase(), name, hashPassword(password)], c);
    await q(`INSERT INTO memberships(org_id, user_id, role) VALUES ($1,$2,'owner')`, [oid, u!.id], c);
    return oid;
  });
  console.log(`대표 계정 생성 완료 (조직 ${orgId})`);
  await pool.end();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
