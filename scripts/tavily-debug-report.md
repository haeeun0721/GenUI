# Tavily API 응답 점검 리포트

생성 시각: 2026. 8. 5. 오후 6:29:12

실제 DB(`data/products-*.json`)에 존재하는 "형제 제품" 쌍(예: 로보락 S10 MaxV Ultra / 직배수, 삼성 비스포크 VR90F01AAG / VR90F01SAG / VR90F01AAH)을 의도적으로 포함시켜, Tavily 검색 결과에 형제 모델의 스펙이 섞여 들어오는지(cross-contamination)를 자동 점검했다.

---

## "로보락 S10 MaxV Ultra 소음"

- Query: `로보락 S10 MaxV Ultra 소음`
- Depth: basic
- 형제 제품 감시 토큰: `직배수`

**AI Answer**: The Roborock S10 MaxV Ultra has improved suction power but increased noise compared to previous models. It features advanced AI obstacle avoidance and a comprehensive cleaning system. To reduce noise, lower the power setting.

**결과 5건**

### [1] score=0.891 | keyword hit 40% [WARN] | ⚠️ 저신뢰 도메인
- URL: https://www.youtube.com/watch?v=jiyIc-p6RTQ
- Title: 로보락 1황 맞아? 철저히 검증해 봄! 26년 플래그쉽 신형 S10 MaxV Ultra 리뷰ㅣ니돈내맘
- 수치 감지: 1분, 20g, 5g
- Content:
  ```
  가동시키면 이전과 비교했을 때 좀 더 라인에 밀착하여 청소하는 걸 알 수 있는데 이런 디테일은 꽤나 좋다고 본데. 회피력 결과 정리. 회피력의 경우 전체적으로 작년 대비 큰 차이까지는 느껴지지는 않았지만 그래도 상위권 중 아래쪽이 정도 수준이라는 생각이 돼. 좋음 테스트. 중요도 비중은 좀 낮긴 하지만 그래도 소음 체크하며 섭파하자는. 가장 강한 흡입력 기준 1분 동안 평균 소음을 측정해 본 결과 68.3대이 나왔대. 아무래도 소음은 흡입력에 비례할 수밖에 없는지라 흡입력이 더 강력해진 대신 작년 모델 대비 약 2대 10일 정도 소음이 커지긴 냈대. 소음 결과 정리. 소음의 경우 중위권들의 평균이 69대 10 정도인지라 중위권 중간에서 살짝이이 정도 수준이라는 생각이다. 최대 파워 기준이라 조용한 청소를 원한다면 파워를 낮추면 소음도 줄어더니 이건 환경에 맞춰 사용하자. 스테이션 테스트. 최근 로봇 청소기에 있어 본체만큼 중요해지고 있는게 바로 스테이션 성능이대. 그래서 주요 [...] 커튼을 인식해 피하지 않고이 밑을 청소한대 올해는 회피 반경 수준까지 조절 가능해져이 디테일을 더 강화시켰다일까요? 뭐 장점만 있는 가전이란 없듯 로보락도 단점은 있대. 우선
  ```

### [2] score=0.783 | keyword hit 20% [MISS] | ⚠️ 저신뢰 도메인
- URL: https://www.youtube.com/watch?v=viqQ2klOuGE&vl=ko
- Title: 로보락 S10 MaxV Ultra, 바꿔야 할 이유 vs 안 바꿔도 되는 이유
- 수치 감지: (없음)
- Content:
  ```
  has significantly decreased. While designing to increase the maximum suction power it seems like the noise in normal mode
  naturally decreased as well. If you often run the robot vacuum while you're at home you'll definitely notice how much quieter it is
  compared to the previous model. The biggest downside of the mop module [...] on each household's environment. For example, in our office there's a large carpet in the meeting area and it collects a lot of dust. So, not just robot vacuums, but even with a handheld cordless vacuum,
  it's hard to get rid of the dust but when I tested it there was a
  ```

### [3] score=0.668 | keyword hit 100% [OK] | ⚠️ 저신뢰 도메인
- URL: https://m.blog.naver.com/jinhj0629/224217859565
- Title: 로보락 S10 MaxV Ultra 실사용 리뷰｜지도 생성부터 자동청소까지 : 네이버 블로그
- 수치 감지: (없음)
- Content:
  ```
  본문 바로가기
  
  # 블로그
  
  ## 카테고리 이동 노는게 제일 조아
  
  검색
  
  로보락 S10 MaxV Ultra 실사용 리뷰｜지도 생성부터 자동청소까지
  
  프로필 
  
  2026. 3. 16. 8:39
  
  이웃추가
  
   본문 폰트 크기 조정 가
   공유하기
   URL복사
   신고하기
  
  이 포스팅은 쿠팡 파트너스 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받습니다
  
  요즘 집안일 중에서 가장 귀찮은 게 청소인 것 같아요.
  
  특히 머리카락이나 먼지는
  
  하루만 지나도 바로 보이잖아요.
  
  ​
  
  퇴근이 늦는 날은 혹여나 층간소음 문제가 생길까
  
  못돌리는 날도 있고,
  
  아침일찍 나가야해서 또 못돌리고 나가는 날도
  
  꽤 되더라고요!
  
  ​
  
  (저는 화이트 색상으로 구매했어요!)
  
  
  
  요즘 왜 로봇청소기 많이 쓰는지
  
  직접 써보니까 알겠더라고요.
  
  ​
  
  실제로 , 인테리어 디자이너인 남편은 상담을 하면
  
  10에 9은 로보락 청소기 장을
  
  따로 빼달라는 요청을 많이 받는다해요 [...] 쿠팡에서 로보락 S10 MaxV Ultra 로봇청소기 구매하고 더 많은 혜택을 받으세요! 지금 할인중인 다른 로봇청소기 제품도 바로 쿠팡에서 확인할 수 있습니다.
  
  link.coupang.com
  
  ​
  
  추
  ```

### [4] score=0.545 | keyword hit 80% [OK]
- URL: https://prod.danawa.com/info?pcode=106736864
- Title: 로보락 S10 MaxV Ultra (블랙) : 다나와 가격비교
- 수치 감지: 1,690,000원
- Content:
  ```
  # 로보락 S10 MaxV Ultra (블랙) : 다나와 가격비교
  
  다나와 가격비교 CI
  다나와 APP
  다나와 장터
  PC견적
  자동차
  빈 이미지
  
  #### HOT
  
  #### 영상/음향가전
  
  #### 생활/계절가전
  
  #### 주방가전
  
  #### 사이트 바로가기
  
  아정당 혜택 그대로, 다나와에서 시작하세요! 최대지원금 52만원 지원금 계산하기
  로딩중
  
  ### 로보락 S10 MaxV Ultra (블랙) 상품비교
  
  역대 최고 흡입력과 100℃ 고온수 세척을 자랑하는 S10시리즈 로보락 로봇청소기
  
  #### 공유하기
  
  URL이 복사되었습니다.   
  원하는 곳에 붙여넣기(Ctrl+V)하세요.
  
  로보락 S10 MaxV Ultra (블랙)_이미지
  로보락 S10 MaxV Ultra (블랙)_이미지
  로보락 S10 MaxV Ultra (블랙)_동영상_이미지
  
  카드결제, 쿠팡 와우회원, N+멤버십 최대 혜택 가격이 다나와 최저가보다 저렴한 경우에만 노출됩니다.
  
  GS SHOP
  CJ온스타일
  하이마트 [...] 로딩중
  로딩중
  
  |  |
  
  | 로보락 S10 MaxV Ultra (블랙)  최저가  1,690,000원 자세히보기   판매점 : 25개  ㅣ  제조사 : 로보락  ㅣ  등록월:
  ```

### [5] score=0.100 | keyword hit 20% [MISS]
- URL: https://support.roborock.com/hc/ko-kr/articles/360042058331-%EB%A1%9C%EB%B4%87%EC%B2%AD%EC%86%8C%EA%B8%B0%EC%97%90%EC%84%9C-%EC%86%8C%EC%9D%8C%EC%9D%B4-%EB%B0%9C%EC%83%9D%ED%95%A0-%EA%B2%BD%EC%9A%B0-%EC%96%B4%EB%96%BB%EA%B2%8C-%ED%95%B4%EC%95%BC-%ED%95%A9%EB%8B%88%EA%B9%8C
- Title: 로봇청소기에서 소음이 발생할 경우 어떻게 해야 합니까?
- 수치 감지: (없음)
- Content:
  ```
  전방 휠을 제거하여 소음이 그치는 경우, 청소 후에 두 방울 이하의 올리브 기름을 휠 축에 주입하고 회전시켜 재설치 전에 오일이 퍼지도록 합니다. 위의 조치를 취
  ```

---

## "로보락 S10 MaxV Ultra 직배수 배터리 사용시간"

- Query: `로보락 S10 MaxV Ultra 직배수 배터리 사용시간`
- Depth: basic

**AI Answer**: The Roborock S10 MaxV Ultra direct-flush battery model has a usage time of up to 120 minutes on a full charge. It supports fast charging and has advanced cleaning features. The device is highly efficient in both vacuuming and mopping.

**결과 5건**

### [1] score=0.723 | keyword hit 57% [OK] | ⚠️ 저신뢰 도메인
- URL: https://www.youtube.com/watch?v=viqQ2klOuGE&vl=ko
- Title: Roborock S10 MaxV Ultra: Why You Should and Why Not
- 수치 감지: (없음)
- Content:
  ```
  mop cleaning with the mop removed. Therefore, in Vacuum-First mode, the mop pad is detached, allowing it to be cleaned separately at the dock while vacuuming is in progress. Additionally, while the battery capacity remains the same, it now supports 150-minute fast charging on the dock. This significantly reduces the total [...] doesn't have many obstacles if I vacuum and then mop not being able to clean in one session it takes almost half a day, struggling on its own. The part where you can significantly reduce
  charging time in between watching it in action, I realized it's a necessary feature
  ```

### [2] score=0.488 | keyword hit 71% [OK] | ⚠️ 저신뢰 도메인
- URL: https://m.blog.naver.com/kimmari02/224248032365
- Title: 로보락 S9 VS S10 MaxV Ultra 직배수 차이 할인 가격 성능 비교 : 네이버 블로그
- 수치 감지: 36,000Pa, 22,000Pa
- Content:
  ```
  ​
  
  무상 AS 기간도 런칭 특별 혜택으로 기존 2년에서 3년 추가되어 5년으로 연장되었습니다. 판매처 페이지에서 한 번 더 확인하시면 됩니다.
  
  ​
  
  
  
  > 로보락 S10 MaxV Ultra 직배수형 설치 방법과 비용
  
  로보락 S10 MaxV Ultra 직배수형 설치는 “배수관과 수도가 있는 자리에 도크를 고정하고, 급수·배수 호스를 연결한 뒤 시운전하는 방식"입니다.
  
  ​
  
  설치 비용은 판매처 정책에 따라 달라질 수 있지만, 공식 유통/설치 포함 상품은 설치 서비스가 포함되어 기사 방문, 무상 설치이며, 추가로 배관 공사나 부자재가 필요하면 별도 비용이 붙을 수 있습니다.
  
  설치 방식과 프로세스
  
  직배수형은 사람이 직접 물통을 비우고 채우는 일반형과 달리, 도크를 수도와 배수 라인에 직접 연결하여 물 관리를 자동화하는 시스템입니다. 따라서 설치의 핵심은 단순한 기기 배치가 아니라 급·배수 호스 연결과 전원 확보, 그리고 공간 적합성 확인에 있습니다.
  
  ​ [...] |  |  |  |
   --- 
  | 항목 | S10 MaxV Ultra | S9 MaxV Ultra |
  | 흡입력 | 36,000Pa | 22,000Pa |
  | 물걸레 | VibraRise 5.
  ```

### [3] score=0.465 | keyword hit 71% [OK]
- URL: https://prod.danawa.com/info?pcode=106734668
- Title: 로보락 S10 MaxV Ultra 직배수 (화이트) : 다나와 가격비교
- 수치 감지: 1,840,000원
- Content:
  ```
  신세계몰
  
  \결제 금액에 따라 무이자 혜택이 다르니, 상품 구매 전 반드시 확인하세요.
  
  KB국민카드3/삼성카드3/신한카드3/현대카드3
  
  롯데ON
  롯데홈쇼핑
  
  \결제 금액에 따라 무이자 혜택이 다르니, 상품 구매 전 반드시 확인하세요.
  
  무이자10개월
  
  더현대닷컴
  
  \결제 금액에 따라 무이자 혜택이 다르니, 상품 구매 전 반드시 확인하세요.
  
  0개월
  
  CJ온스타일
  현대Hmall
  
  \결제 금액에 따라 무이자 혜택이 다르니, 상품 구매 전 반드시 확인하세요.
  
  할부없음
  
  SSG.COM
  
  \결제 금액에 따라 무이자 혜택이 다르니, 상품 구매 전 반드시 확인하세요.
  
  KB국민카드3/삼성카드3/신한카드3/현대카드3
  
  쿠팡
  11번가
  
  \결제 금액에 따라 무이자 혜택이 다르니, 상품 구매 전 반드시 확인하세요.
  
  신한/롯데/삼성 백만원 이상 최대 16개월
  
  GS SHOP
  
  #### 최저가 추이
  
  다나와 가격비교 앱 > 알림에서 전체 내역을   
  확인 할 수 있어요.
  
  #### 상품 상세정보 [...] # 로보락 S10 MaxV Ultra 직배수 (화이트) : 다나와 가격비교
  
  다나와 가격비교 CI
  다나와 APP
  다나와 장터
  PC견적
  자동차
  빈 이미지
  
  #### HOT
  
  
  ```

### [4] score=0.394 | keyword hit 57% [OK]
- URL: https://www.instagram.com/reel/Dag1IVwTME8
- Title: #로보락 #관리방법 로보락 S10 MaxV Ultra 오래 사용하는 비결은 관리 ...
- 수치 감지: (없음)
- Content:
  ```
  로보락 S10 MaxV Ultra 오래 사용하는 비결은 관리입니다. 청소 성능을 오래 유지하려면 평소 간단한 관리만으로도 충분합니다. 정수통과 오수통 관리
  ```

### [5] score=0.309 | keyword hit 0% [MISS]
- URL: https://www.coupang.com/vp/products/9360881651
- Title: 로보락 S10 MaxV Ultra 직배수 로봇청소기
- 수치 감지: (없음)
- Content:
  ```
  종류: 로봇청소기; 유무선 여부: 무선; 카메라탑재: 카메라 탑재; 사이드 브러시 여부: 사이드 브러시 포함; 사이즈: 본체(350 x 353 x 79.8 mm), 도크(409 x 440 x
  ```

---

## "삼성전자 비스포크 AI 스팀 울트라 VR90F01AAG 흡입력"

- Query: `삼성전자 비스포크 AI 스팀 울트라 VR90F01AAG 흡입력`
- Depth: basic
- 형제 제품 감시 토큰: `VR90F01SAG`, `VR90F01AAH`, `직배수`

**AI Answer**: The Samsung Bespoke AI Steam Ultra VR90F01AAG has a maximum suction power of 10W. It features advanced AI and steam cleaning capabilities. It received AI+ certification in 2025.

**결과 5건**

### [1] score=0.904 | keyword hit 86% [OK]
- URL: https://plan.danawa.com/info?nPlanSeq=12242
- Title: 더 안전하고 섬세해진 삼성 비스포크 AI 스팀 - 다나와 쇼핑기획전
- 수치 감지: 5W, 22,000Pa
- Content:
  ```
  삼성 비스포크 AI 스팀 울트라 로봇청소기. VR90F01AAG, 5W 흡입력 삼성 AI ・ 흡입+물걸레 ・ 흡입력:22,000Pa ・ 흡입+물걸레 ・ 흡입력:22,000Pa / AI사물인식
  ```

### [2] score=0.886 | keyword hit 57% [OK]
- URL: https://www.samsung.com/sec/vacuum-cleaners/jetbot-vr90f01aa-d2c/VR90F01AAG
- Title: Bespoke AI 스팀 울트라 | VR90F01AAG | Samsung 대한민국
- 수치 감지: 10W
- Content:
  ```
  #### 2배 더 강력해진 흡입 성능
  
  ### 최대 10W 흡입력
  
  기존 대비 2배 더 강력한 흡입력으로   
  집 안 구석구석 효과적인 청소를 경험하세요.
    
  최대 10W 흡입력으로   
  머리카락, 먼지, 각종 이물질을 손쉽게 제거합니다.
  
  영상 왼쪽 부분에는 좌우 나선형 회전 구조의 새로운 엉킴 방지 브러시 텍스트가 쓰여있고 바닥 면에 있는 듀오 클리어 브러시가 회전하는 모습이 나오다가 화면 왼쪽 부분의 텍스트가 머리카락을 가운데로 모아 엉킨 걱정 없이 깔끔하게로 수정 되며 머리카락이 듀오 클리어 브러시에 감겨 있다가 브러시 사이의 가운데 빈 공간으로 흡입하는 모습으로 머리카락이 감기는 것을 어떻게 제거하는지 알려주는 영상입니다. [...] 영상 왼쪽 부분에 2배 더 강력해진 최대 10W 흡입력으로 얇은 틈의 먼지까지 남김없이 10W 흡입력 텍스트가 쓰여있고 Bespoke AI 스팀 울트라가 단모 카펫 위에 있는 먼지들을 흡입하면서 다가오는 모습이 나오고 있습니다. 이어서 텍스트가 쓸어담기만으론 부족한 카펫을 만나면으로 변경되고 Bespoke AI 스팀 울트라가 장모 카펫을 만난 후 바로 다음 장면으로 넘어갑니다. 화면 오른쪽 부분의 텍스트가 최대 10W
  ```

### [3] score=0.797 | keyword hit 57% [OK]
- URL: https://www.samsung.com/sec/event/vacuum-cleaner
- Title: 2026 New Bespoke AI 스팀 | SAMSUNG 대한민국
- 수치 감지: 10W
- Content:
  ```
  바닥에 있는 카펫 옆 Bespoke AI 스팀 울트라, 제품 좌측으로 쓸어담기만으론 부족한 카펫을 만나면 10W 흡입력 이라는 자막이 떠있다
  바닥에 있는 카펫 옆 Bespoke AI 스팀 울트라, 제품 좌측으로 쓸어담기만으론 부족한 카펫을 만나면 10W 흡입력 이라는 자막이 떠있다
  바닥에 있는 카펫 옆 Bespoke AI 스팀 울트라, 제품 좌측으로 쓸어담기만으론 부족한 카펫을 만나면 10W 흡입력 이라는 자막이 떠있다
  
  투명한 액체까지 감지하여   
  추가 오염 방지
  
  액체를 피해 추가 오염을 방지하거나   
  집중적으로 다시 청소,   
  바닥에 흘린 액체도 효과적으로 청소
  
  \ 해당 기능은 VR90\\라인업에 한해 지원 [...] 자동으로 깨끗한 물을 채우고   
  세척 후 더러운 물은 배수관으로 버려   
  편리하고 깨끗하게
  
  \ 해당 기능은 자동 급배수 전용 모델에 한해 지원
  
  우드톤 주방의 싱크대 하부장 클로즈업, 하부장 중 하나가 아랫부분이 뚫려있고 그 안에 Bespoke AI 스팀 울트라 제품이 보인다
  우드톤 주방의 싱크대 하부장 클로즈업, 하부장 중 하나가 아랫부분이 뚫려있고 그 안에 Bespoke AI 스팀 울트라 제품이 보인다
  우드톤 주방의 싱크대
  ```

### [4] score=0.726 | keyword hit 43% [WARN]
- URL: https://www.samsungebiz.com/sohomall/vacuum-cleaners/jetbot-vr90f01aa-d2c/VR90F01AAG
- Title: Bespoke AI 스팀 울트라 | VR90F01AAG | Samsung 대한민국
- 수치 감지: (없음)
- Content:
  ```
  Bespoke AI 스팀 울트라는 2025년 6월 한국표준협회에서 AI+인증을 받았습니다. * 10년 보증은 10년 이내 무상 수리를 의미하며, 제품 교환 및 구입가 환급에는 적용
  ```

### [5] score=0.182 | keyword hit 14% [MISS] | ⚠️ 저신뢰 도메인
- URL: https://www.youtube.com/watch?v=6KWev_N8G54
- Title: Samsung's #1 Robot Vacuum! Great performance, and it's ...
- 수치 감지: (없음)
- Content:
  ```
  로봇청소기 시장에서 삼성의 스팀 살균 기능은 확실한 차별점이네요. 유지보수와 AS 생각하면 지금 가격대에선 고민할 필요가 없어 보입니다.
  ```

---

## "삼성전자 비스포크 AI 스팀 울트라 직배수 VR90F01SAG 흡입력"

- Query: `삼성전자 비스포크 AI 스팀 울트라 직배수 VR90F01SAG 흡입력`
- Depth: basic
- 형제 제품 감시 토큰: `VR90F01AAG`, `VR90F01AAH`

**AI Answer**: The Samsung Bespoke AI Steam Ultra has a maximum suction power of 10W. It features 100℃ steam sterilization and an AI camera for liquid detection. It includes an automatic refill and discharge system.

**결과 5건**

### [1] score=0.849 | keyword hit 50% [OK]
- URL: https://www.samsung.com/sec/vacuum-cleaners/jetbot-vr90f01sag-d2c/VR90F01SAG
- Title: Bespoke AI 스팀 울트라 자동 급배수 | VR90F01SAG | Samsung 대한민국
- 수치 감지: 10W
- Content:
  ```
  영상 왼쪽 부분에 2배 더 강력해진 최대 10W 흡입력으로 얇은 틈의 먼지까지 남김없이 10W 흡입력 텍스트가 쓰여있고 Bespoke AI 스팀 울트라가 단모 카펫 위에 있는 먼지들을 흡입하면서 다가오는 모습이 나오고 있습니다. 이어서 텍스트가 쓸어담기만으론 부족한 카펫을 만나면으로 변경되고 Bespoke AI 스팀 울트라가 장모 카펫을 만난 후 바로 다음 장면으로 넘어갑니다. 화면 오른쪽 부분의 텍스트가 최대 10W 흡입력으로 카펫 깊숙한 먼지까지 철저하게로 바뀌고 화면 왼쪽 부분에는 Bespoke AI 스팀 울트라 상단에 Suction Power Nomal 텍스트가 적혀 있고 장모 카펫으로 다가가는 모습이 나오고 있습니다. 이후에 장모 카펫을 만나면 Bespoke AI 스팀 울트라 상단에 Suction Power Boost로 텍스트가 변하며 장모 카펫에서 흡입력이 강해지는 모습으로 카펫의 길이에 따라 흡입력이 달라지는 것을 알려주고 있습니다. 이후에 흡입구 부분이 확대되어 [...] 바퀴 내부에 여러 개의 기어가 연결되어 최대 45mm까지 들어 올릴 수 있음을 나타내고 있습니다. 네 번째 패널은 10W 흡입력 기능입니다. 기존 대비 2배 업그레이드 된 최
  ```

### [2] score=0.716 | keyword hit 88% [OK]
- URL: https://prod.danawa.com/info?pcode=108367196
- Title: 삼성전자 비스포크 AI 스팀 울트라 직배수 VR90F01SAG (단품) : 다나와 가격비교
- 수치 감지: (없음)
- Content:
  ```
  삼성전자 비스포크 AI 스팀 울트라 직배수 VR90F01SAG (단품)_이미지
  삼성전자 비스포크 AI 스팀 울트라 직배수 VR90F01SAG (단품)_이미지
  삼성전자 비스포크 AI 스팀 울트라 직배수 VR90F01SAG (단품)_이미지
  삼성전자 비스포크 AI 스팀 울트라 직배수 VR90F01SAG (단품)_이미지
  주식회사 신세계라이브쇼핑
  G마켓
  
  \결제 금액에 따라 무이자 혜택이 다르니, 상품 구매 전 반드시 확인하세요.
  
  롯데24/KB국민14/삼성12/하나12/우리7/비씨6/전북6/광주6/수협6/제주6/농협4/신한3/현대3
  
  옥션
  
  \결제 금액에 따라 무이자 혜택이 다르니, 상품 구매 전 반드시 확인하세요.
  
  롯데24/KB국민12/삼성12/하나12/농협6/신한5/우리4/비씨4/농협4/현대3
  
  11번가
  
  \결제 금액에 따라 무이자 혜택이 다르니, 상품 구매 전 반드시 확인하세요.
  
  신한/롯데/삼성 백만원 이상 최대 16개월
  
  SSG.COM [...] # 삼성전자 비스포크 AI 스팀 울트라 직배수 VR90F01SAG (단품) : 다나와 가격비교
  
  다나와 가격비교 CI
  다나와 APP
  다나와 장터
  PC견적
  자동차
  빈 이미지
  
  #### HOT
  
  #### 영상/음향가
  ```

### [3] score=0.692 | keyword hit 75% [OK] | ⚠️ 저신뢰 도메인
- URL: https://blog.naver.com/ooii_kkk/224225055310
- Title: 짱이효니와 쓰리김 : 네이버 블로그
- 수치 감지: (없음)
- Content:
  ```
  비스포크 AI스팀 울트라 로봇청소기 자동급배수 빌트인 VR90F01SAG98AS 그레이지 - 로봇청소기 | 쿠팡 쿠팡에서 비스포크 AI스팀 울트라 로봇청소기 자동급배수 빌트인 VR90F01SAG98AS 그레이지 구매하고 더 많은 혜택을 받으세요! 지금 할인중인 다른 로봇청소기 제품도 바로 쿠팡에서 확인할 수 있습니다.  link.coupang.com    ​  ​  ​  ​  삼성 AI 스팀 울트라 로봇청소기 VR90F01SAG 새틴그레이지  삼성직배수로청, 삼성자동급배수로청, 26년삼성로봇청소기  |  |  | 26년 삼성 자동급배수 로봇청소기 | | 1 제품 스팩  ​  2 설치 과정  ​  3 맵핑 과정  ​  4 아쉬운점 & AS신청 |  ​  ​  1. 제품 스팩    ​  ​  2026년에 새로 출시된  삼성 AI 스팀 울트라 로봇청소기 VR90F01SAG 모델은 자동급수 직배수 모델로,  빠르고 깔끔한 물 공급 및 배수 시스템을 갖춘 것이 가장 큰 특징이에요⭐️  ​ [...] | 삼성 AI 스팀 울트라 로봇청소기 자동급배수 2주 사용 후기 및 AS 신청  프로파일 짱이효니   ・  2026. 3. 22. 0:50  URL 복사  이웃추가 본문 
  ```

### [4] score=0.639 | keyword hit 50% [OK] | 🚨 형제제품 토큰 감지: VR90F01AAH
- URL: https://search.11st.co.kr/pc/total-search?kwd=%EC%82%BC%EC%84%B1%EB%B9%84%EC%8A%A4%ED%8F%AC%ED%81%ACai%EB%A1%9C%EB%B4%87%EC%B2%AD%EC%86%8C%EA%B8%B0
- Title: 삼성비스포크ai로봇청소기
- 수치 감지: 1,840,120원, 1,656,110원, 1,709,670원
- Content:
  ```
  VR90F01AAH Bespoke AI 스팀 울트라 새틴차콜 10 EMBLEM 삼성전자 ・ 판매가 1,840,120원 1,656,110원 ・ 지 신제품 가격정보 1,709,670원~ 배송비무료 판매자평점
  ```

### [5] score=0.186 | keyword hit 13% [MISS] | ⚠️ 저신뢰 도메인
- URL: https://www.youtube.com/watch?v=6KWev_N8G54
- Title: Samsung's #1 Robot Vacuum! Great performance, and it's effectively 1.32 ...
- 수치 감지: (없음)
- Content:
  ```
  로봇청소기 시장에서 삼성의 스팀 살균 기능은 확실한 차별점이네요. 유지보수와 AS 생각하면 지금 가격대에선 고민할 필요가 없어 보입니다.
  ```

---

## "SONY 알파 A7 V 바디 손떨림보정"

- Query: `SONY 알파 A7 V 바디 손떨림보정`
- Depth: basic
- 형제 제품 감시 토큰: `A7C II`, `A7R VI`, `A7CR`

**AI Answer**: The Sony Alpha A7 V has a 5-axis in-body image stabilization (IBIS) system. It corrects camera shake for clearer shots. The stabilization works well with compatible lenses for enhanced performance.

**결과 5건**

### [1] score=0.890 | keyword hit 60% [OK]
- URL: https://freewellgear.com/ko/blogs/news/sony-alpha-7-mark-v
- Title: Sony Alpha 7 Mark V/A7 V: 풀프레임 미러리스 카메라
- 수치 감지: (없음)
- Content:
  ```
  소니 A7V의 5축 바디 내장 손떨림 보정(IBIS). ~을 갖추고 5축 바디 내 영상 안정화(IBIS), 그만큼 알파 7 마크 V 카메라 흔들림을 보정하여 특히
  ```

### [2] score=0.798 | keyword hit 0% [MISS]
- URL: https://www.sony.co.kr/electronics/interchangeable-lens-cameras/ilce-7m5
- Title: Sony Alpha 7 V | 풀프레임 카메라, AI 인식 AF·4K 120p | Sony Korea
- 수치 감지: 90분
- Content:
  ```
  최대 120p의 내부 4K 레코딩으로 뛰어난 4K 해상도의 최대 5배 슬로우 모션 비디오를 제작할 수 있습니다. Full HD 해상도로 레코딩할 때는 최대 240 fps의 프레임 레이트를 사용할 수 있어, 최대 10배 슬로우 모션 재생(S&Q 모드에서 24p 레코딩)으로 세부적인 스포츠 분석 등을 수행할 수 있습니다. 4:2:2 10비트레코딩, Long GOP, All Intra 등 다양한 포맷을 지원합니다.
  
  손으로 들고 영상을 촬영하는 여성
  손으로 들고 영상을 촬영하는 여성
  
  이제 4K 120p 레코딩을 지원하는 액티브 모드 광학식 손떨림 보정 기능 덕분에 손으로 들고 부드럽게 영상을 촬영할 수 있습니다. 안정화 유닛, 자이로 센서 및 이미지 스테빌라이저 알고리즘은 카메라가 움직임을 정확하게 감지하고 보정할 수 있도록 지원합니다. 본체를 호환 가능한 안정화 렌즈와 함께 사용할 때 안정화 효과는 더욱 뛰어납니다. [...] Imaging Edge Desktop 어플리케이션에는 이제 RAW 이미지 파일 내 대량의 정보를 활용하여 특히 움직이는 피사체에 대해 향상된 RAW 현상을 가능하게 하는 확장된 RAW 처리 기능이 포함되었습니다. [확장 NR]을 사용하여
  ```

### [3] score=0.760 | keyword hit 0% [MISS] | ⚠️ 저신뢰 도메인
- URL: https://www.reddit.com/r/SonyAlpha/comments/1rmlhj9/does_the_sony_50150_mm_lack_of_stabilization?tl=ko
- Title: A7V에 IBIS(바디 손떨림 방지 기능)가 있는데, 소니 50-150mm에 손떨방이 ...
- 수치 감지: (없음)
- Content:
  ```
  50-150mm나 70-200mm 중에 고민 중인데, 50-150mm에 손떨방(손떨림 방지 기능)이 없는 게 괜찮을지 좀 알고 싶어.
  ```

### [4] score=0.660 | keyword hit 40% [WARN] | ⚠️ 저신뢰 도메인
- URL: https://www.reddit.com/r/videography/comments/2ynbp1/sony_a7s_image_stabilization_in_camera_vs_in_lens?tl=ko
- Title: 소니 A7s 이미지 손떨림 보정 - 내장 vs 렌즈 : r/videography
- 수치 감지: (없음)
- Content:
  ```
  A7s에는 바디 손떨림 방지 기능이 없고, A7 Mk II에만 있어요. A7 Mk II는 사용해 본 적이 없지만, 일반적으로는 비슷하거나 더 좋을 거예요.
  ```

### [5] score=0.153 | keyword hit 40% [WARN] | ⚠️ 저신뢰 도메인
- URL: https://www.youtube.com/watch?v=WPH7lCe8InA
- Title: a7V 출시! 하지만 a7IV는 어떨까? | 카메라 리뷰
- 수치 감지: (없음)
- Content:
  ```
  a7V가 출시되어 많은 관심을 받고 있는 지금, 여러 환경에서 열심히 사용해온 a7IV에 대해 돌아보는 시간을 가졌습니다. 최신 바디에 비해서 아쉬운
  ```

---

## "SONY 알파 A7C II 바디 동영상 해상도"

- Query: `SONY 알파 A7C II 바디 동영상 해상도`
- Depth: basic
- 형제 제품 감시 토큰: `A7 V`, `A7R VI`

**AI Answer**: The Sony α7C II records 4K video at up to 30fps in full-frame mode and 60fps in Super 35mm crop mode. It uses 4:2:2 10-bit color depth.

**결과 5건**

### [1] score=0.786 | keyword hit 0% [MISS] | ⚠️ 저신뢰 도메인
- URL: https://m.blog.naver.com/phovi_blog/223197461754
- Title: Sony a7C II Announced – New Compact Full Frame Camera ...
- 수치 감지: (없음)
- Content:
  ```
  카메라는 풀프레임 모드에서 최대 4K 30fps 또는 슈퍼35 크롭 모드에서 최대 4K 60fps로 4:2:2 10비트 비디오를 녹화할 수 있습니다. 3" 터치스크린 LCD,
  ```

### [2] score=0.571 | keyword hit 43% [WARN] | ⚠️ 저신뢰 도메인
- URL: https://namu.wiki/w/E%20%EB%A7%88%EC%9A%B4%ED%8A%B8/%EB%B0%94%EB%94%94/%ED%92%80%ED%94%84%EB%A0%88%EC%9E%84
- Title: E 마운트/바디/풀프레임 - 나무위키
- 수치 감지: (없음)
- Content:
  ```
  능가하는데 프로세서 및 센서 성능의 향상으로 이렇게 20fps로 연사를 하는 동안 블랙아웃이 전혀 없이 뷰파인더를 볼 수 있다. 즉 촬영을 하는 동안에도 똑같이 뷰파인더를 통해 60fps의 재생률로 화면을 볼 수 있는 것이다. 쉽게 말하면 20fps로 동영상을 찍는 셈이다. DSLR에서는 물리적으로 절대 구현할 수 없는 기능이며, 미러리스 구조에서도 적층형 센서를 통해서만 실현가능한 것으로 스포츠 및 자연 사진 등 피사체가 동적인 촬영에서 압도적인 우위를 점하게 할 기능이다. 바디에 내장되어 있는 센서이동식 5축 손떨림 보정장치는 이전 α7 II 시리즈에 내장된 것과 같이 5스탑 보정의 성능을 보인다. 여담으로 최고셔터속도가 더 빨라졌는데, 기계식은 1/8000초, 전자식은 1/32000초이다. [...] 영상 쪽에서도 결국 4k/59.94p는 1.5배 크롭되기 때문에 영상 위주의 전문가에게는 α7S III나 FX3와 비교해 결국 애매하다는 평이다. 물론 이들은 α7 IV보다 100만 원 이상 비싸다.  
    
  α7 III는 출시 당시, 비록 소니의 급 나누기가 존재했지만 α7S II, α7R III는 물론 α9와 비교해도 각각 더 나은 부분이 존재했다. [
  ```

### [3] score=0.328 | keyword hit 14% [MISS] | ⚠️ 저신뢰 도메인
- URL: https://www.reddit.com/r/SonyAlpha/comments/1j2hx4a/sony_a7c_ii_for_videography?tl=ko
- Title: 소니 A7C II, 영상 촬영용으로 괜찮을까요? : r/SonyAlpha
- 수치 감지: (없음)
- Content:
  ```
  안녕, 얘들아! 
  
  저는 똑딱이 필름 카메라로 시작해서 작년에 리코 GR IIIx로 디지털 카메라로 넘어온 아마추어 사진작가입
  ```

### [4] score=0.278 | keyword hit 14% [MISS] | ⚠️ 저신뢰 도메인
- URL: https://www.youtube.com/watch?v=b6r7uXgJeU0
- Title: Get started with the Sony A7C2 full-frame camera. The best ...
- 수치 감지: (없음)
- Content:
  ```
  파인더 크기가 작아진 것이 크게 불편하지 않고, 컴팩트하지만, 영상과 사진 성능 모두 만족스러운 풀프레임 입문기를 찾으신다면 소니 A7C2를 추천
  ```

### [5] score=0.224 | keyword hit 29% [MISS] | ⚠️ 저신뢰 도메인
- URL: https://www.youtube.com/watch?v=M59JNhKAfL0
- Title: 드디어 완벽해진 소니의 미러리스 카메라 I A7C 2세대 리뷰
- 수치 감지: (없음)
- Content:
  ```
  비싼데 좋다.. 근데 진짜 비싸다 | 카메라 리뷰. 스튜디오ING | 동영상 연구소 · 11K views ; Why Beginners and Experts alike Will Buy This Camera Sony
  ```

---

## "캐논 파워샷 V1 무게"

- Query: `캐논 파워샷 V1 무게`
- Depth: basic

**AI Answer**: The Canon PowerShot V1 weighs approximately 426 grams. It is a compact and lightweight camera. This model is known for its portability.

**결과 5건**

### [1] score=0.957 | keyword hit 100% [OK] | ⚠️ 저신뢰 도메인
- URL: https://blog.naver.com/djusti/223873859271?viewType=pc
- Title: 브이로그 카메라 선택 기준, 캐논 파워샷 V1
- 수치 감지: 426g
- Content:
  ```
  캐논 파워샷 V1 무게는 약 426g으로 가벼운 편이라 들고 다니기에도 부담이 적습니다. 틸트형 LCD는 자유로운 각도 조절이 가능해 다양한 구도로
  ```

### [2] score=0.917 | keyword hit 100% [OK]
- URL: https://kr.canon/company/brand/news/11568/Iframe
- Title: 플래그십 디지털 카메라 '파워샷(PowerShot) V1' 공개
- 수치 감지: 426g
- Content:
  ```
  '파워샷 V1'은 캐논 디지털 카메라 최초로 약 2,230만 화소 1.4형 CMOS 센서를 채택했다. 약 118.3 x 68 x 52.5mm, 무게는 약 426g의 콤팩트한 디자인으로 휴대성이 우수
  ```

### [3] score=0.791 | keyword hit 50% [OK] | ⚠️ 저신뢰 도메인
- URL: https://namu.wiki/w/%EC%BA%90%EB%85%BC%20%ED%8C%8C%EC%9B%8C%EC%83%B7%20%EC%8B%9C%EB%A6%AC%EC%A6%88
- Title: 캐논 파워샷 시리즈
- 수치 감지: 425분, 1,040 mAh, 379g, 426g, 1,190,000원, 10L, 920mAh, 492g
- Content:
  ```
  425분할 (25×17) 측거, 최대 425포지션 (25×17) 선택 가능
  손떨림 보정렌즈 광학 IS
  렌즈35mm(풀프레임) 환산 16-50mm F2.8-4.5 전동 줌 렌즈
  연사 속도기계셔터 One-Shot AF/서보 AF 15fps
  
  전자셔터 One-Shot AF/서보 AF 30fps
  디스플레이회전식 3.0인치 TFT LCD, 104만 도트 정전식 터치 스크린
  내장 플래시없음
  기록 매체SDXC UHS-Ⅱ 1슬롯
  전원리튬이온 LP-E17, 7.2 V 1,040 mAh
  크기118.3×68.0×52.5 mm
  무게바디 379g, 배터리/SD카드 포함 426g
  
  제조사 공식 웹사이트
  
  출시가: 1,190,000원 (한국 기준)
  
  캐논에서 G7 X Mark III 이후 오랜만에 출시한 하이엔드 카메라이다. [...] 유효화소수 1,430만 (4,352×3,264)
  프로세서DIGIC 5
  렌즈35mm 환산 28-112mm f2.8-5.8 4배줌, 10군 11매 UA+FE(조리개날 6)
  뷰파인더갈릴레안 타입 광학식 줌 뷰파인더 (시야율 77%)
  디스플레이회전 LCD (922,000화소)
  ISO 감도100 – 12800
  셔터1/4000 – 60s
  내장 플래시
  AF 시스템
  
  ```

### [4] score=0.431 | keyword hit 100% [OK] | ⚠️ 저신뢰 도메인
- URL: https://www.youtube.com/watch?v=23nmXV89eK8
- Title: 캐논 파워샷 V1 사이즈 크기 비교 (vs. CANON PowerShot V10, 리코 gr3x ...
- 수치 감지: (없음)
- Content:
  ```
  CANON PowerShot V1 camera size comparison (vs. 캐논 파워샷 V10과 리코 gr3x hdf 그리고 캐논 R8 바디와의 사이즈, 크기, 무게, 디자인 비교입니다.)
  ```

### [5] score=0.163 | keyword hit 25% [MISS] | ⚠️ 저신뢰 도메인
- URL: https://www.youtube.com/watch?v=1T95tEXdems
- Title: 캐논 파워샷 V1과 함께한 6개월, 누구를 위한 카메라일까?
- 수치 감지: (없음)
- Content:
  ```
  Canon PowerShot V1을 6개월 동안 사용해보았습니다. 실사용을 통해 느낀 장점과 아쉬운 점, 그리고 어떤 사람에게 어울리는 카메라인지 정리했습니다
  ```

---

## "후지필름 INSTAX 미니 에보 즉석필름크기"

- Query: `후지필름 INSTAX 미니 에보 즉석필름크기`
- Depth: basic
- 형제 제품 감시 토큰: `미니12`, `미니 12`

**AI Answer**: The FujiFilm INSTAX Mini Evo instant film size is 62 x 46 mm. It fits the Mini Evo camera. FujiFilm instant films are popular for their instant photo results.

**결과 5건**

### [1] score=0.239 | keyword hit 40% [WARN] | ⚠️ 저신뢰 도메인
- URL: https://namu.wiki/w/%ED%9B%84%EC%A7%80%ED%95%84%EB%A6%84
- Title: 후지필름 - 나무위키
- 수치 감지: 1984 L
- Content:
  ```
  1934년부터 대일본셀룰로이드(현 다이셀) 필름사업부문이 독립하면서 창립되었다.  
    
  1948년 '후지카 식스 IA'를 시초로 사진기 사업에도 발을 들였다.  
    
  1982년부터 FIFA 공식파트너 지위를 따낸 후 1984 LA 올림픽 공식 스폰서도 따냈고, 1986년에 처음으로 일회용 카메라 '우츠룬데스'를 시판했다.  
    
  1988년 세계 최초로 메모리 카드 저장식 디지털 카메라 '후직스 DS-1P'를 내놓았고, 1998년부터 즉석 카메라 '인스탁스'를 런칭했다.  
    
  2017년, 자회사가 도시바와 올림푸스처럼 회계부정을 하다가 걸렸다.  실적지상주의 日기업 골병…도시바 이어 후지제록스도 회계부정  
    
  2018년, 자회사인 후지제록스를 통해서 제휴 관계를 맺고 있던 제록스를 인수하려다가 실패했다. 제록스는 후지제록스 지분 25%를 후지필름에 23억 달러에 매각하기로 했다고 밝혔다. 후지제록스는 후지필름의 완전 100% 자회사된다. [...] | 후지필름 FUJIFILM |
  | 회사명 | 일문: 富士フイルム株式会社 |
  | 영문: FUJIFILM Corporation |
  | 한글: 후지필름 주식회사 |
  | 국가 | 일본 국기 일본 |
  | 설립일
  ```

### [2] score=0.169 | keyword hit 40% [WARN]
- URL: https://www.fujifilm-korea.co.kr
- Title: 후지필름
- 수치 감지: (없음)
- Content:
  ```
  본문 바로가기
  
  FujiFilm - Value from Innovation
  
   로그인    장바구니    고객지원
  
   Products 
  
    Products
    + 신제품
    + 프로모션
    + 카메라
    + 렌즈
    + 액세서리
    + 프로젝터
    + 쌍안경
    + 오리지널 굿즈
  
      X-T5  
    Photography First
   Platform 
  
    Platform
    + House of Photography
    + Particle
    + 전시
    + 프로그램
  
      Cultural Platform  
    Beyond Photography
   #PlayWith
  
   고객지원
   로그인
   매장찾기
   장바구니
  
  가까운 매장/서비스센터 찾기
  
  ## hero contents
  
  X-E5
  
  ### THE REFINED CLASSIC
  
  X half
  
  ### Half the Size, Twice the Story
  
  GFX100RF
  
  ### The One and Only
  
  X-M5 [...] X-M5
  
  ### Color Your Moment
  
  GFX100S II
  
  ### ULTIMATE FREEDOM
  
  X-T50
  
  ### My Experience, My Color
  
  ```

### [3] score=0.144 | keyword hit 20% [MISS]
- URL: https://www.fujifilm.com/fbkr/ko
- Title: 후지필름비즈니스이노베이션 | 한국
- 수치 감지: (없음)
- Content:
  ```
  기업용 PC 렌탈 솔루션: Ready to Work
  
  IT 자산 구매부터 유지보수까지 한 번에 해결하고 바로 업무에 집중하세요Revoria Press SC285S / SC285
  
  Revoria Press SC285S / SC285
  
  차세대 기술. 한 차원 높은 CMYK + 영감.Maxhub
  
  MAXHUBIT 엑스퍼트 서비스
  
  IT 엑스퍼트 서비스
  
  IT 전문 인력 지원으로 비즈니스 역량을 강화하세요
  
  솔루션 및 제품
  
  솔루션 찾기
  
  프린팅 솔루션프린팅 솔루션업무 자동화 솔루션보안 솔루션IT 솔루션IT 솔루션클라우드 및 모바일 솔루션
  
  제품 찾기
  
  사무실 구석에 놓인 복합기복합기 책상 위에 놓인 프린터프린터 창가에서 노트북으로 작업하는 사람.소프트웨어 및 클라우드 서비스 흰색 테이블에 마주 앉은 두 사람 중 한 명이 태블릿으로 데이터를 보여주면서 제안을 하고 있습니다.비즈니스 서비스 실내에 설치된 상업용 프린터.그래픽 아트 및 프린트 현대적이고 밝은 사무실소모품 및 기타 [...] Fujifilm Value from Innovation
  
  후지필름비즈니스이노베이션 한국
  
  카테고리에서 찾기
  
   
  
  사무실 구석에 놓인 복합기 복합기
  
  책상 위에 놓인 프린터 프린터
  
  ```

### [4] score=0.090 | keyword hit 0% [MISS] | ⚠️ 저신뢰 도메인
- URL: https://cafe.naver.com/fujipeople
- Title: 후지피플
- 수치 감지: (없음)
- Content:
  ```
  No information is available for this page.
  ```

### [5] score=0.076 | keyword hit 20% [MISS] | ⚠️ 저신뢰 도메인
- URL: https://namu.wiki/w/%ED%9B%84%EC%A7%80
- Title: 후지
- 수치 감지: (없음)
- Content:
  ```
  후지라고 검색하면 전술되어있는 후지필름이나 후지전자, 돼지 뒷다리살 부위 같은 게 훨씬 많이 검색되니 자체 브랜드로 밀고 있는 후지로얄로 검색하는 편이 이롭다.
  
  공식 홈페이지
  
  ## 2.사과의 종류(
  
  Image 17Image 18: 상세 내용 아이콘 자세한 내용은 후지(사과) "후지(사과)") 문서를 참고하십시오.
  
  ## 3.자전거메이커 후지(FUJI)(
  
  이름은 후지산의 그 '후지' 맞는데 정작 미국 기업이다. 일본에서 만들어졌는데 차후에 미국으로 넘어간 기업이다.
  
  자세한 내용은 자전거/브랜드/프레임 및 완성차/아메리카 문서로.
  
  ## 4.後肢, 돼지고기의 뒷다리살 부위(
  
  Image 20Image 21: 상세 내용 아이콘 자세한 내용은 뒷다리살 문서를 참고하십시오.
  
  ## 5.인물(
  
  ### 5.1.실존 인물(
  
  ### 5.2.가상 인물( [...] ### 1.2.일본의 기업(
  
  Image 5Image 6: 상세 내용 아이콘 자세한 내용은 후지필름 문서를 참고하십시오.
  
  ### 1.3.후지 테레비(
  
  Image 8Image 9: 상세 내용 아이콘 자세한 내용은 후지 테레비 문서를 참고하십시오.
  
  ### 1.4.시즈오카현에 위치한 도시(
  
  Image 
  ```

---

## 요약

| 쿼리 | 상태 | 상세 |
|---|---|---|
| 로보락 S10 MaxV Ultra 소음 | OK | results=5, lowTrust=3, miss=2, siblingHit=false |
| 로보락 S10 MaxV Ultra 직배수 배터리 사용시간 | OK | results=5, lowTrust=2, miss=1, siblingHit=false |
| 삼성전자 비스포크 AI 스팀 울트라 VR90F01AAG 흡입력 | OK | results=5, lowTrust=1, miss=1, siblingHit=false |
| 삼성전자 비스포크 AI 스팀 울트라 직배수 VR90F01SAG 흡입력 | 🚨 SIBLING RISK | results=5, lowTrust=2, miss=1, siblingHit=true |
| SONY 알파 A7 V 바디 손떨림보정 | OK | results=5, lowTrust=3, miss=2, siblingHit=false |
| SONY 알파 A7C II 바디 동영상 해상도 | OK | results=5, lowTrust=5, miss=4, siblingHit=false |
| 캐논 파워샷 V1 무게 | OK | results=5, lowTrust=4, miss=1, siblingHit=false |
| 후지필름 INSTAX 미니 에보 즉석필름크기 | OK | results=5, lowTrust=3, miss=3, siblingHit=false |
