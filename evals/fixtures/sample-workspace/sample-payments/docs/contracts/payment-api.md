---
fixture: true
kind: contract
---
# 결제 API 계약

> 테스트용 자료(FIXTURE) — 실제 프로젝트 정책이 아니다.

### `CON-200` 결제 승인 API 계약

- 상태: 확정
- 근거: docs/decisions/payment-api-owner.md
- 코드: src/payments/approve.ts

POST /payments/approve 는 멱등 키를 받아 승인 결과를 돌려준다. 이 계약의 책임 원본은 sample-payments 하나뿐이다.
