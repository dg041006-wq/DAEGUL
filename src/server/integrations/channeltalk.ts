// 경로 A 후보: 채널톡(상담톡 연결) — 아직 구현하지 않음.
//
// 2026년 채널톡 OpenAPI 신버전 전환 공지가 있으므로 과거 /v5 예제를 사용하지 않는다.
// 계약/테스트 계정 확보 후 https://api-doc.channel.io/ 의 현재 명세로 다음을 확인하고 구현한다:
//   - 웹훅 인증 방식(토큰/서명)과 재시도 정책
//   - 카카오 상담톡 유입 메시지가 웹훅/조회 API에 포함되는지, 상담원 답변 포함 여부
//   - 상담 ID·메시지 ID·사용자 식별값·발신자 유형·시각·상담 상태 필드
//   - 누락 내역 조회(백필) 엔드포인트와 속도 제한
//   - 발송 API의 카카오 세션/메시지 제약
// docs/INTEGRATION.md 체크리스트 참고. 검증 전에는 어떤 엔드포인트 경로도 코드에 넣지 않는다.
import type { ProviderAdapter } from "./types.js";

export class NotImplementedProvider extends Error {
  status = 501;
}

export const channelTalkAdapter: ProviderAdapter = {
  key: "channeltalk",
  implemented: false,
  verify() {
    return false;
  },
  eventId() {
    throw new NotImplementedProvider("채널톡 어댑터는 공식 명세 검증 전이라 비활성화되어 있습니다.");
  },
  normalize() {
    throw new NotImplementedProvider("채널톡 어댑터는 공식 명세 검증 전이라 비활성화되어 있습니다.");
  },
};
