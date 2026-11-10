---
fixture: true
kind: api-catalog
---
# 인증 API 목록

> 테스트용 자료(FIXTURE) — 실제 프로젝트 API가 아니다.

### `API-AUTH-01` 비밀번호 변경 API

- 범위: `PATCH /auth/password`
- 코드: src/auth/password.ts

PATCH /auth/password 요청은 현재 비밀번호와 새 비밀번호를 받는다. 재설정 토큰으로 바꾸는 요청은 토큰 만료 정책을 따른다.

### `API-AUTH-02` 로그인 API

- 범위: `POST /auth/login`
- 코드: src/auth/login.ts

POST /auth/login 요청은 계정과 비밀번호를 받아 세션을 만든다.

### `API-AUTH-03` 로그아웃 API

- 범위: `POST /auth/logout`
- 코드: src/auth/logout.ts

POST /auth/logout 요청은 현재 세션과 리프레시 토큰을 함께 폐기한다.
