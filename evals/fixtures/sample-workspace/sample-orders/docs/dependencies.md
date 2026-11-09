---
fixture: true
---
# 주문 서비스 의존 관계

> 테스트용 자료(FIXTURE) — 실제 프로젝트 정책이 아니다.

### `DEP-001` 결제 승인 계약 의존

- 종류: dependency
- 상태: 확정
- 근거: docs/decisions/payment-dependency.md
- 계약: sample-payments:CON-200

주문 서비스는 결제 승인을 sample-payments의 계약에 의존한다.
