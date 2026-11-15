# 과거 기록 가져오기 형식

대표가 직접 보관·정리한 과거 상담 기록을 가져올 때 사용하는, **이 앱이 정의한** JSON 형식입니다.
카카오나 상담 공급사의 일괄 내보내기 기능이 있다고 가정하지 않습니다. 가져온 데이터는 출처(`source_label`)와 기간이 기록되고 화면에 표시됩니다.

설정 → 데이터 보관 → 과거 기록 가져오기 (대표 전용), 또는 `POST /api/imports`.

```json
{
  "conversations": [
    {
      "external_conversation_id": "2026-09-가평펜션",
      "customer_id": "고객 식별용 임의 문자열(전화번호 등 개인정보 대신)",
      "customer_name": "가평 펜션",
      "messages": [
        { "id": "1", "sender": "customer", "text": "객실 촬영 문의드려요", "sent_at": "2026-09-03T10:12:00+09:00" },
        { "id": "2", "sender": "staff", "text": "안녕하세요, 스테이신입니다.", "sent_at": "2026-09-03T10:40:00+09:00" }
      ]
    }
  ]
}
```

- `sender`: `customer` | `staff` | `bot`
- `sent_at`: 시간대가 포함된 ISO 8601
- 같은 `external_conversation_id` + `id` 조합은 다시 가져와도 중복 저장되지 않습니다.
- 가져온 기록은 샘플이 아닌 실제 기록으로 분류되지만, '카카오 실연동' 상태를 바꾸지 않습니다.
