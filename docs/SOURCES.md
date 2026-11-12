# 데이터 소스 확인 기록 (2026-11-12)

## TourAPI

공식 문서: https://www.data.go.kr/data/15101578/openapi.do
콘텐츠랩: https://api.visitkorea.or.kr/ (JS 앱)

공식 포털의 현재 국문 서비스 경로는 `https://apis.data.go.kr/B551011/KorService2/`입니다. 수집기는 다음 기능을 순차 호출합니다.

| 엔드포인트 | 사용 목적 | 주요 매핑 필드 |
|---|---|---|
| searchStay2 | 숙박 목록, 페이지 순회 | contentid, title, addr1/addr2, mapx/mapy, tel, firstimage |
| detailCommon2 | 공통 상세 | 위 기본 필드, overview |
| detailIntro2 | 숙박 소개 (contentTypeId=32) | parkinglodging, fitness, sauna, businesscenter |
| detailInfo2 | 반복 객실 정보, 별도 페이지 순회 | roomcode, roomtitle, roomsize2, roombasecount, roommaxcount, roombath, roomintro |

이는 구현에서 기대하는 필드 목록입니다. **현재 인증된 실응답으로 필드 존재·의미·결측률을 검증하지 못했습니다.** Fixture는 이 형식을 따른 합성 응답이며 공식 응답 캡처가 아닙니다. 운영 수집 전에 발급된 키로 응답과 최신 활용가이드의 객실 필드 정의를 대조해야 합니다. 특히 roombath는 욕조로 매핑하는 기대 필드로, 실제 서비스 매뉴얼의 정의 확인이 필요합니다. 실응답 계약이 다른 경우 원문 정의에 맞게 normalizer를 수정해야 합니다.

- 인증: data.go.kr에서 해당 서비스 활용 신청 후 발급되는 serviceKey 쿼리 파라미터. .env에는 **일반(Decoding) 키**를 설정합니다. URLSearchParams가 한 번 인코딩합니다.
- 공통 요청: MobileOS=ETC, MobileApp=HotelDataCollector, _type=json. detailIntro2/detailInfo2는 contentTypeId=32.
- 현재 공식 문서는 areaCode/sigunguCode를 미사용·삭제 예정으로 표시합니다. `lDongRegnCd=26`(부산), 서울은 11을 사용합니다. 전국 확장은 지역별 실행으로 가능합니다. 정확한 코드는 ldongCode2와 최신 공식 법정동 코드로 확인합니다.
- 공식 포털 표시 개발 트래픽: 1,000. 일일·초당 제한 에러코드 22/23을 제공하므로 계정별 실제 한도를 마이페이지에서 확인해야 합니다. 기본 구현은 실행당 200회 예산, 호출 간격 300ms, 요청당 20초 timeout. **전역 일일 사용량 추적이나 자동 재시도는 미구현**입니다. cron 중복 실행을 피하고 계정 할당량에 맞춰 예산을 조정하세요.
- API 실패 시 서비스 코드/HTTP 코드만 로그에 기록합니다. 인증키가 포함된 URL·응답 본문·원시 네트워크 오류를 로그에 남기지 않습니다.
- 제공기관은 공식 출처지만 현장 검증을 의미하지 않습니다. TourAPI의 verified는 공식 공급자 레코드 확인 수준이며 evidence에 source와 recordId를 유지합니다. 향후 Validation Agent가 예약 상품 단위로 다시 검증해야 합니다.

### 실제 연결 시도

2026-11-12에 인증키를 **전송하지 않고** searchStay2에 부산 필터로 연결을 시도했습니다. HTTP 503 및 upstream connection timeout이 반환되었습니다. [보존한 오류 본문](tourapi-connectivity.txt). 이는 TourAPI의 인증 오류 또는 실제 호텔 데이터 응답으로 간주할 수 없습니다. 환경에 API 키가 없으므로 인증된 실연동은 수행하지 않았습니다. 라이브 수집 호텔·객실은 각각 **0건**입니다.

### 결측 및 보수적 해석

빈 문자열·불명확한 표현은 null입니다. 0/N은 false이며 null과 구분합니다. 주차 설명이 단순 Y/N이 아닌 자유문이면 자동 확정하지 않습니다. roombathfacility는 샤워 여부를 확정하지 않습니다. publicbath는 수영장으로 사용하지 않습니다. foodplace/cooking으로 조식 제공을 추론하지 않습니다. 객실명 Twin으로 침대 크기나 개수를 추론하지 않습니다. roomintro에 `2 Single Beds`, `싱글 침대 2개`처럼 명시된 구성만 정규화합니다. 전망·조식·주변 환경·수영장은 명시 근거가 없으면 null입니다. 호텔 분류 코드와 호텔 유형의 검증된 매핑이 없어 hotelType은 null이며, 명시적 유형을 처리할 정규화 함수만 제공합니다.

이미지는 URL만 저장하며 다운로드하지 않습니다. 포털은 이용허락범위 제한 없음으로 표시하지만 사진은 공공누리 1/3유형이 혼재하고 인격권 침해·CI/BI 사용 등이 금지됩니다. 실제 이미지 이용 전 개별 이용조건을 확인하고 출처를 표시해야 합니다. 원문을 DB에 보관하는 것과 모든 사진의 가공·재배포 허용은 구분해야 합니다.

## 추가 공공데이터 후보

지자체 숙박업 인허가 데이터와 공공데이터포털 숙박시설 데이터는 이름·주소·업종·영업상태를 보완하는 후보입니다. 제공기관별 갱신주기·인허가 ID·폐업 포함 여부·이용조건이 달라 현재 연결하지 않았습니다. 객실 침대·욕조·전망을 제공한다고 가정하지 않습니다. 신규 소스 도입 시 sources 외부 ID를 추가하고 duplicateDecision의 review 후보를 검토합니다.

## ego lite

공식 저장소 https://github.com/citrolabs/ego-lite 는 확인 시 macOS/Windows 지원, Linux는 roadmap으로 안내합니다. 현재 실행 환경은 Linux이고 ego 실행 파일·전용 MCP·ego-browser 스킬이 없습니다. 실제 브라우저 조작은 구현·실행하지 않았습니다.

지원 OS에서 공식 앱을 설치하거나 `npx skills add citrolabs/ego-lite`로 스킬 설치 후 앱 안내를 따릅니다. 실제 제어 절차는 공식 `skills/ego-browser/SKILL.md` 및 `skills/ego-browser/references/install.md`를 확인합니다. 이 저장소는 검증하지 않은 CLI/MCP 명령을 만들어 호출하지 않습니다.

연결 구현 시 BrowserTool.enrich를 구현해 주입하고, BrowserRequest/Result Zod 스키마를 준수하세요. 브라우저 구현은 탐색·리다이렉트·증거 URL까지 승인 범위를 강제해야 합니다. 여기서는 candidate/result URL의 **정확한 HTTPS URL 허용목록**과 허가 기록을 검증합니다. 도메인 전체를 허용하지 않습니다. URL에 접근 가능하다는 사실이나 robots.txt만으로 허가를 가정하지 마세요. 사이트별 약관 및 필요한 허가를 검토한 permissionReference/reviewedAt을 기록한 후 사용합니다. 초기 허용목록은 비어 있으며 enrichment는 pending입니다.

MockBrowser는 주입된 콜백만 실행하며 네트워크를 사용하지 않습니다. UnavailableBrowser는 UNAVAILABLE 오류를 제공합니다. 접근 거부·추출 실패·근거 없음·허가 없음은 pending으로 보존합니다. 브라우저 인용문은 독립 검증이 아니므로 결과는 unverified입니다. CAPTCHA 우회·로그인 우회·비공개 API·실시간 가격 수집은 없습니다.
