---
kind: reference
status: unverified
---
# 공용 지식

여러 프로젝트가 함께 쓰는 지식의 원본이다. [config/sources.example.yaml](../config/sources.example.yaml)의 `shared-knowledge` 원본이 이 폴더를 프로젝트 `shared`로 색인한다. 검색하려면 호출자가 `shared`를 범위에 넣어야 한다([범위와 필터](../docs/retrieval.md#범위와-필터)).

## 둘 것

- 시스템 지도: 어떤 프로젝트가 있고 서로 어떻게 이어지는가
- 용어: 여러 프로젝트에서 같은 뜻으로 써야 하는 말
- 책임 구분: 어느 구성 요소가 무엇을 맡는가([responsibilities.md](responsibilities.md))

## 두지 말 것

- 프로젝트 내부 지식
- 프로젝트 간 계약이나 다른 저장소 문서의 사본
- 현재 단계, 잠금, 승인, 재시도, 체크포인트 같은 실행 상태
- 비밀값, 개인별 경로
- 승인받지 않은 정책

## 작성 규칙

형식은 [docs/knowledge-model.md](../docs/knowledge-model.md)를 따른다. 확인되지 않은 내용은 `status: unverified`로 둔다. 확정 상태는 해석 가능한 근거가 있을 때만 쓴다.
