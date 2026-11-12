# AI 호텔 추천 — Data Collection Agent v1

부산을 기본으로 공공 숙박정보를 정규화·저장하고 결손 분석과 RAG 문서를 생성하는 TypeScript strict/Node.js 파이프라인입니다. 사용자 요청마다 실행하는 추천 Agent는 구현하지 않았습니다. 일반 함수로 충분해 LangGraph·LLM 프레임워크를 도입하지 않았습니다.

## 실행

Node.js 22 이상과 npm이 필요합니다.

```bash
npm ci
npm run build
npm test
npm run demo
```

DB 없이 demo를 실행하면 합성 호텔 30개·객실 60개를 **메모리**에서 처리하고 `reports/latest.json`에 보고서를 씁니다. 메모리 데이터는 프로세스 종료 시 사라집니다. Fixture는 실제 호텔 데이터가 아닙니다. DB와 실수집은 다음과 같습니다.

```bash
docker compose up -d
cp .env.example .env
# .env의 DATABASE_URL 설정; 실제 수집은 TOUR_API_KEY도 설정
npm run migrate
npm run demo
npm run demo
npm run collect
```

위 demo/live 명령은 실행 예시입니다. 실제 수집과 추천에 사용할 DB는 Fixture 검증 DB와 분리하세요. Fixture는 source=fixture로 식별되며 현재 읽기 Repository는 이를 자동 제외하지 않습니다.

기본 로컬 DB 비밀번호는 개발용입니다. 변경 시 POSTGRES_PASSWORD와 DATABASE_URL을 함께 설정하세요. migrate는 PostgreSQL 및 pgvector 권한이 필요하며 core와 vector 마이그레이션을 하나의 트랜잭션으로 적용합니다. 기존 데이터를 삭제하지 않으며 적용된 마이그레이션의 checksum 변경을 거부합니다. 실패 원인을 해결한 후 재실행할 수 있습니다. 실제 API 키는 소스나 채팅에 넣지 말고 `.env`에 설정하세요. API 키는 data.go.kr에서 해당 서비스 활용신청 후 발급받습니다.

```bash
# 별도 임시 스키마를 만들고 해당 스키마만 정리하는 실DB 테스트
TEST_DATABASE_URL=postgresql://hotel:hotel@127.0.0.1:5432/hotel npm run test:postgres
# 전체 테스트 + 실제 PostgreSQL 테스트
TEST_DATABASE_URL=postgresql://hotel:hotel@127.0.0.1:5432/hotel npm test
```

기본 테스트는 실제 DB 테스트 두 개를 skip하며 PGlite 기반 FK/스키마 검증과 Mock HTTP·브라우저·임베딩 테스트를 실행합니다. `build`는 타입 검사입니다. 스케줄링은 cron/작업 스케줄러에서 `npm run collect`를 호출할 수 있습니다. 내장 스케줄러와 변경 이벤트 구독기는 없으며, 중복 실행을 피하는 스케줄 설정이 필요합니다. runCollection은 외부 워커에서 직접 호출할 수 있습니다.

## 구조와 실행 흐름

```mermaid
flowchart LR
  API[TourAPI 또는 Fixture] --> N[정규화]
  N --> D[중복 판정 및 트랜잭션 Upsert]
  D --> G[결손·최신성·충돌 분석]
  G --> B[허가된 BrowserTool 또는 Pending]
  B --> E[스키마·근거 검증 및 저장]
  E --> R[검증된 사실 기반 Context·Metadata]
  R --> I[Context hash·모델 확인 후 Embedding]
  I --> Q[품질 보고서·작업 이력]
```

| 경로 | 역할 |
|---|---|
| src/model.ts | Zod 호텔·객실·필드·근거·검증 상태, 병합 |
| src/collector.ts | TourAPI 목록/상세/객실 페이지, FixtureCollector |
| src/normalize.ts | 보수적인 값 정규화, 내부 ID, 중복 판정 |
| src/quality.ts | 최신성 판정, 가중 우선순위, 필드별 품질 보고서 |
| src/browser.ts | 공통 브라우저 계약, Mock, 허가·근거 검증 |
| src/repository.ts / postgres.ts | 메모리·PostgreSQL 저장, 읽기 전용 검색 계약 구현 |
| src/rag.ts | 사실 기반 문서·Metadata, 변경 감지, EmbeddingProvider |
| src/contracts.ts | Search / Price / RAG Zod 계약 |
| src/pipeline.ts / cli.ts | 작업 실행·실패 보존·JSON 로그·품질 보고서 |
| migrations/ | core 관계형 구조와 pgvector 마이그레이션 |
| tests/ | 수집·정규화·무결성·브라우저·RAG·실DB 검증 |
| docs/SOURCES.md | 공식 문서, 실제 연결 결과, 매핑 제약, ego 연결 방법 |

## 최종 DB 관계

```mermaid
erDiagram
 hotels ||--o{ rooms : contains
 hotels ||--o{ hotel_source_ids : identifies
 hotels ||--o{ hotel_amenities : has
 rooms ||--o{ room_beds : has
 rooms ||--o{ room_source_ids : identifies
 hotels ||--o{ attribute_evidence : supports
 rooms o|--o{ attribute_evidence : supports
 hotels ||--o{ rag_chunks : indexes
 rooms o|--o{ rag_chunks : indexes
 hotels o|--o{ collection_jobs : targets
```

9개 주요 테이블에 `schema_migrations`를 추가합니다. hotels/rooms는 SQL 필터용 주요 컬럼과 필드별 value/status/evidence JSONB를 함께 유지합니다. JSONB는 null·false·충돌·근거를 보존하는 원본이며 scalar 컬럼만으로 verified를 판단하면 안 됩니다. 호텔·객실 연결은 FK, 객실 근거와 Chunk는 복합 FK로 소유 관계를 보장합니다. 외부 ID는 내부 UUID와 분리되어 source별 UNIQUE로 관리됩니다. room_beds는 침대 크기와 개수를 분리합니다. 가격 테이블은 만들지 않았으며 향후 rate_plans/rate_offers에서 room_id를 참조하면 됩니다.

한 호텔의 정규화 데이터·객실·source ID·근거·시설은 한 트랜잭션으로 저장합니다. 중복 판정 구간에 advisory lock을 사용합니다. source+external ID가 같거나 이름·주소와 전화/근접 좌표가 함께 일치하면 병합하며 그 외 유사 후보는 reviewCandidates로 표시합니다. 같은 객실명으로 병합하지 않습니다. 결측 재수집은 기존 값을 지우지 않으며 다른 값은 conflicting으로 기록하고 각 evidence의 observedValue를 보존합니다. 근거 이력은 append-only이며 같은 근거를 재실행으로 중복 삽입하지 않습니다. 충돌 해소·폐업/삭제·객실 소멸 동기화는 수동 검토 및 후속 기능입니다.

## 품질과 RAG

각 필드는 verified/unverified/missing/conflicting/stale을 값과 별도로 관리합니다. 180일 경과는 조회·분석 시 stale로 계산하며 원래 근거를 덮어쓰지 않습니다. false도 확보된 값입니다. 우선순위는 `priority(field,status,weights)`로 변경할 수 있습니다. 품질 보고서는 확보율과 상태별 건수를 별도로 제공하고 호텔/객실별 검증 완성도를 계산합니다.

RAG Context는 템플릿 방식의 읽을 수 있는 필드·값 문장으로 생성하며 LLM 추론을 사용하지 않습니다. verified이면서 최신인 속성만 포함하고 호텔과 객실을 다른 Chunk로 만듭니다. Metadata는 ID·도시·검증 속성·출처와 근거를 저장하며 임베딩하지 않습니다. Context를 Unicode/공백 정규화한 SHA-256과 provider 모델/버전/차원을 함께 비교합니다. Metadata 변경은 저장만 하고 재임베딩하지 않으며 Context 변경은 해당 Chunk만 갱신합니다. 모델/버전/차원이 바뀌면 다시 생성합니다. 가격은 문서 입력에 포함하지 않습니다.

MockEmbeddingProvider는 8차원 결정적 해시 벡터이며 의미 검색 품질이 없습니다. 실제 공급자는 EmbeddingProvider를 구현해 runCollection에 주입하세요. 모든 벡터는 같은 DB의 pgvector 컬럼에 trigger로 동기화됩니다. 실제 모델 선정 전에는 차원을 고정한 ANN 인덱스를 만들지 않습니다. 모델별 호환성을 지켜 별도의 부분 인덱스를 설계해야 합니다. 임베딩 실패는 partial 작업으로 기록하며 변경된 문서의 예전 Context는 비활성화합니다. 이미 저장된 호텔 정보는 유지합니다.

안정적인 Chunk ID/Context를 BM25에 전달할 수 있습니다. BM25·Vector 검색·RRF·Reranker는 미구현입니다. PostgreSQL FTS를 BM25라고 표시하지 않습니다.

## 다른 Agent 연동

| Agent | 제공 계약 및 주의점 |
|---|---|
| Supervisor | HotelSearchFiltersSchema: city, 시설 boolean, beds[{type,count}], bathtub, shower, view, minOccupancy. 자연어 구조화는 후속 구현 |
| Hotel Search | HotelSearchRepository.findHotelsByFilters/getHotelDetails/getRooms/getRagChunks. 동일 객실 안에서 hard constraint를 모두 만족하고 verified·최신인 값만 통과 |
| Price | PriceLookupRequestSchema: hotelId, roomId?, checkIn/out, adults, children?, roomCount. Hotel/Room의 sources로 공급자 ID를 확인. 가격조회 자체는 없음 |
| Validation | Hotel/Room attributes의 value/status/evidence/observedValue와 RAG Metadata 근거를 사용. 객실 속성과 호텔 시설의 범위 유지 |

읽기 전용 Repository **인터페이스**로 의존하면 쓰기 메서드를 노출하지 않아도 됩니다. 현재 구현은 MVP 규모에서 호텔 목록을 읽어 필터링합니다. 대규모 SQL query pushdown, 별도 read-only DB 계정, Hybrid Search는 후속 작업입니다. Validation이 새로운 검증된 근거를 전달하는 쓰기 서비스 및 충돌 해소 정책도 후속 범위입니다.

## 검증 결과와 한계

2026-11-12에 TypeScript 검사, 기본 테스트 30개, 실제 PostgreSQL/pgvector 테스트 2개를 검증했습니다(실DB 명령은 core SQL 테스트와 함께 3개 통과). 실제 DB의 전체 Fixture 실행은 호텔 30·객실 60·Chunk 90·Mock 임베딩 90개, 재실행은 추가 임베딩 0개·중복 Upsert 30건·실패 0건입니다. Fixture만을 저장했고 실제 호텔·객실 수집은 **0건**입니다. 중복 통계는 작업 중 기존 엔터티와 병합된 입력 수이며 DB 내 잘못된 중복 엔터티 수가 아닙니다.

| 필드 | 합성 데이터 확보율 |
|---|---:|
| 주소 | 80% (24/30) |
| 좌표 쌍 | 73.3% (22/30) |
| 주차 | 66.7% (20/30) |
| 조식 | 0% |
| 침대 | 0% |
| 욕조 | 50% (30/60) |
| 객실 전망 | 0% |

출처 레코드 추적률 100%, 추가 수집 필요 호텔 30개입니다. 이 수치는 합성 테스트 결과이며 부산 호텔의 실제 완성도·수집 가능성을 나타내지 않습니다. 실제 필드별 결측률은 키를 설정해 수집한 후 보고서로 확인하세요. API 실요청은 HTTP 503으로 연결 실패했고 인증된 테스트는 미수행입니다. Linux 미지원 ego 실연동, 실제 Embedding API, 실시간 가격, BM25/추천 Agent 및 내장 예약 실행기는 구현하지 않았습니다. 자세한 출처·제약은 [SOURCES.md](docs/SOURCES.md)를 참고하세요.

다음 단계는 TourAPI 키 설정 및 실응답 필드 대조 → 부산 30개 실제 수집과 결측률 검토 → 지원 OS에서 허가된 ego 소스 연결 → 실제 Embedding 모델 및 인덱스 선정 → Hotel Search, Price, Validation, Supervisor 순차 구현입니다.
