-- ---------------------------------------------------------------------------
-- GenUIdance baseline 연구 로그 스키마 (main과 분리된 별도 Supabase 프로젝트용)
--
-- baseline은 구조화된 Decision Criteria/My Options UI, TradeoffHint,
-- UnchartedTerritory 같은 기능이 없는 단순 채팅형 시스템이라, main 스키마의
-- criteria_events / option_events / feature_events는 대응 개념이 없어 제외했다.
-- 대신 baseline에만 있는 정보(어시스턴트 답변 전문, tool 호출 내역)를 추가했다.
--
-- Supabase SQL Editor에서 그대로 실행. 순서: sessions → chat_turns(FK 참조).
-- 재실행 안전성을 위해 create table if not exists 사용.
-- ---------------------------------------------------------------------------

-- 세션(참여자) 메타 정보 + 구매 Outcome
create table if not exists sessions (
  participant_id text primary key,
  assigned_item text not null,             -- '로봇 청소기' | '카메라'
  purchase_context text,                   -- 구매 목적 및 상황
  locale text,                             -- 'ko' | 'en'
  started_at timestamptz not null default now(),   -- '시작하기' 클릭 시각
  purchase_clicked_at timestamptz,         -- '구매하기' 버튼 클릭 시각
  purchase_confirmed_at timestamptz,       -- 구매 모달에서 '확인' 클릭 시각
  time_to_purchase_ms bigint,              -- purchase_confirmed_at - started_at
  final_product_name text,                 -- 구매 모달에 직접 입력한 제품명 (baseline엔 구조화된 옵션 리스트가 없음)
  chat_turns int not null default 0,       -- 누적 채팅 턴 수 (비정규화 필드)
  created_at timestamptz not null default now()
);

-- 채팅 턴별 사용자 입력 + 어시스턴트 답변 전문 + tool 호출 내역
create table if not exists chat_turns (
  id bigint generated always as identity primary key,
  participant_id text not null references sessions(participant_id) on delete cascade,
  turn_index int not null,
  user_text text,
  assistant_text text,
  tool_calls jsonb,                        -- [{tool, input, output}, ...] search_products/web_search 호출 내역
  created_at timestamptz not null default now()
);

create index if not exists idx_chat_turns_participant on chat_turns(participant_id);
