---
fixture: true
kind: policy
---
# 주문 정책

> 테스트용 자료(FIXTURE) — 실제 프로젝트 정책이 아니다.

### `POL-100` 주문 취소 정책

- 상태: 확정
- 근거: docs/decisions/order-cancel.md

배송이 시작된 주문은 취소할 수 없다.

### `POL-101` 카드 번호 저장 금지

- 구분: 필수
- 상태: 확정
- 근거: docs/decisions/card-data.md

카드 번호 원문을 주문 데이터에 저장하지 않는다.
