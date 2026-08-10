-- ---------------------------------------------------------------------------
-- GenUI 연구 로그 스키마
-- Supabase SQL Editor에서 그대로 실행. 순서: sessions → 나머지(FK 참조).
-- 재실행 안전성을 위해 create table if not exists 사용.
-- ---------------------------------------------------------------------------

-- [1] 세션/참여자 메타 정보 + [6] 구매/Outcome
create table if not exists sessions (
  participant_id text primary key,
  assigned_item text not null,             -- 'A' | 'B' | 'C'
  purchase_context text,                   -- 구매 목적 및 상황
  started_at timestamptz not null default now(),   -- '시작하기' 클릭 시각
  purchase_clicked_at timestamptz,         -- '구매하시겠습니까?' 모달을 연 시각
  purchase_confirmed_at timestamptz,       -- '예' 클릭 시각
  time_to_purchase_ms bigint,              -- purchase_confirmed_at - started_at
  final_criteria jsonb,                    -- 최종 Decision Criteria 스냅샷 [{name, priority, important}, ...]
  final_options jsonb,                     -- 최종 My Options 스냅샷 [{name, price, ...}, ...]
  chat_turns int not null default 0,
  created_at timestamptz not null default now()
);

-- [2] Decision Criteria add/remove 이벤트
create table if not exists criteria_events (
  id bigint generated always as identity primary key,
  participant_id text not null references sessions(participant_id) on delete cascade,
  op text not null check (op in ('add', 'remove')),
  criterion_name text not null,
  turn_index int,                          -- 몇 번째 채팅 턴에서 발생했는지 (턴과 무관하면 null)
  created_at timestamptz not null default now()
);

-- [3] My Options add/remove 이벤트
create table if not exists option_events (
  id bigint generated always as identity primary key,
  participant_id text not null references sessions(participant_id) on delete cascade,
  op text not null check (op in ('add', 'remove')),
  option_name text not null,
  turn_index int,
  created_at timestamptz not null default now()
);

-- [4] 채팅 턴 + [5] action_router/template/edit 판정 결과
create table if not exists chat_turns (
  id bigint generated always as identity primary key,
  participant_id text not null references sessions(participant_id) on delete cascade,
  turn_index int not null,
  user_text text,
  action text,                             -- 'generate' | 'edit' | 'none'
  template text,                           -- generate일 때: CriteriaMap/InformationCard/ComparisonTable/ProductCardList
  edit_target text,                        -- edit일 때: optionList/comparisonTable/criteriaMap
  edit_op text,                            -- edit일 때: filter/sort/add/add_criteria/... 등
  created_at timestamptz not null default now()
);

-- [5] TradeoffHint / UnchartedTerritoryChip 노출·채택
create table if not exists feature_events (
  id bigint generated always as identity primary key,
  participant_id text not null references sessions(participant_id) on delete cascade,
  feature text not null check (feature in ('tradeoff_hint', 'uncharted_territory')),
  event text not null check (event in ('shown', 'adopted')),
  payload jsonb,                           -- tradeoff_hint: {new_criterion, conflicting_criterion, why} / uncharted_territory: {labels} or {label}
  turn_index int,
  created_at timestamptz not null default now()
);

create index if not exists idx_criteria_events_participant on criteria_events(participant_id);
create index if not exists idx_option_events_participant on option_events(participant_id);
create index if not exists idx_chat_turns_participant on chat_turns(participant_id);
create index if not exists idx_feature_events_participant on feature_events(participant_id);
