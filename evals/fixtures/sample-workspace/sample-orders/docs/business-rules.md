---
fixture: true
kind: business-rule
---
# 주문 업무 규칙

> 테스트용 자료(FIXTURE) — 실제 프로젝트 정책이 아니다.

### `BR-001` 주문 취소 가능 기간

- 상태: 확정
- 근거: docs/decisions/order-cancel.md
- 별칭: 취소기한
- 단계: implement test
- 코드: src/orders/cancel.ts
- 테스트: tests/orders/cancel.test.ts
- 정책: POL-100

결제 완료 후 24시간 안이고 배송 시작 전이면 고객이 주문을 취소할 수 있다.

### `BR-002` 재고 차감 시점

- 상태: 관찰
- 코드: src/orders/stock.ts

현재 코드는 결제 승인 응답을 받은 직후 재고를 차감한다.

### `BR-003` 장바구니 보관 기간

- 상태: 미확인

장바구니 보관 기간은 30일로 들었지만 아직 확인되지 않았다.

### `BR-004` 주문 확정 메일 즉시 발송

- 상태: 폐기

주문 확정 메일을 결제 직후 즉시 보낸다는 규칙은 더 이상 쓰지 않는다.

### `BR-005` 배송비 무료 기준

- 상태: 확정
- 근거: docs/decisions/shipping-fee.md
- 충돌: BR-006

주문 금액이 5만 원 이상이면 배송비가 무료다.

### `BR-006` 배송비 실제 계산

- 상태: 관찰
- 코드: src/orders/shipping.ts
- 충돌: BR-005

현재 코드는 주문 금액이 7만 원 이상일 때만 배송비를 면제한다.

### `BR-007` 주문 확정 메일 지연 발송

- 상태: 확정
- 근거: docs/decisions/order-mail.md
- 대체: BR-004
- 단계: implement

결제 승인 후 10분 뒤에 주문 확정 메일을 보낸다.
