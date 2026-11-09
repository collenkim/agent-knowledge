---
fixture: true
kind: experience
---
# 과거 수정 사례

> 테스트용 자료(FIXTURE) — 실제 프로젝트 정책이 아니다.

## 주문 중복 생성 수정 사례

- 상태: 검증됨
- 근거: tests/orders/duplicate.test.ts
- 코드: src/orders/create.ts
- 테스트: tests/orders/duplicate.test.ts

같은 멱등 키로 주문이 두 번 생성되던 결함을 수정하고 회귀 테스트를 추가했다.
