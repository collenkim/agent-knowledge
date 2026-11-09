---
fixture: true
kind: overview
status: 확정
status_basis: knowledge/decisions/shared-scope.md
---
# 샘플 시스템 지도

> 테스트용 자료(FIXTURE) — 실제 프로젝트 정책이 아니다.

## 프로젝트 구성

sample-orders는 주문 접수와 취소를 맡고, sample-payments는 결제 승인을 맡는다.
두 프로젝트는 결제 승인 API 계약으로만 연결된다.

## 공용 지식 관리 위치

시스템 지도와 용어, 책임 구분만 sample-shared에 둔다.
