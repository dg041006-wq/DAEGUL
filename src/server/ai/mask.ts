// 모델에 보내기 전 불필요한 연락처·식별정보 마스킹
const PHONE = /(?:\+?82[-\s]?)?0?1[016789][-\s.]?\d{3,4}[-\s.]?\d{4}/g;
const LANDLINE = /\b0\d{1,2}[-\s.]\d{3,4}[-\s.]\d{4}\b/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const RRN = /\b\d{6}[-\s]?[1-4]\d{6}\b/g; // 주민등록번호 형태
const ACCOUNT = /\b\d{3,6}-\d{2,6}-\d{2,8}\b/g; // 계좌번호 형태

export function maskPII(text: string | null | undefined): string {
  if (!text) return "";
  return text
    .replace(RRN, "[주민번호]")
    .replace(EMAIL, "[이메일]")
    .replace(PHONE, "[전화번호]")
    .replace(LANDLINE, "[전화번호]")
    .replace(ACCOUNT, "[계좌번호]");
}

/** 푸시/로그용: 원문 대신 길이만 */
export function redactForLog(text: string | null | undefined) {
  return text ? `[${text.length}자]` : "[빈 메시지]";
}
