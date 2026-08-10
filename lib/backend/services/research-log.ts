/**
 * research-log.ts — 참여자 행동 로그를 Supabase에 적재한다.
 *
 * session-memory.ts(Redis)와 동일한 관례: env 미설정 시 조용히 no-op(null 반환), 모든 쓰기는
 * best-effort — 로그 실패가 실제 응답/UI 흐름을 절대 막지 않는다. SUPABASE_SERVICE_ROLE_KEY는
 * RLS를 우회하므로 이 모듈은 서버(API 라우트/서버 액션)에서만 import해야 한다.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

function getSupabase(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

function warn(context: string, err: unknown) {
  console.error(`[ResearchLog] ${context} 실패:`, err);
}

// ── [1] 세션 생성 ────────────────────────────────────────────────────────────
export async function createSession(input: {
  participantId: string;
  assignedItem: string;
  purchaseContext: string;
}): Promise<void> {
  if (!input.participantId) return;
  const supabase = getSupabase();
  if (!supabase) return;
  try {
    const { error } = await supabase.from("sessions").upsert(
      {
        participant_id: input.participantId,
        assigned_item: input.assignedItem,
        purchase_context: input.purchaseContext,
        started_at: new Date().toISOString(),
      },
      { onConflict: "participant_id", ignoreDuplicates: true }
    );
    if (error) warn("createSession", error);
  } catch (err) {
    warn("createSession", err);
  }
}

// ── [2] Decision Criteria add/remove ────────────────────────────────────────
export async function logCriteriaEvent(input: {
  participantId: string;
  op: "add" | "remove";
  criterionName: string;
  turnIndex?: number;
}): Promise<void> {
  if (!input.participantId) return;
  const supabase = getSupabase();
  if (!supabase) return;
  try {
    const { error } = await supabase.from("criteria_events").insert({
      participant_id: input.participantId,
      op: input.op,
      criterion_name: input.criterionName,
      turn_index: input.turnIndex ?? null,
    });
    if (error) warn("logCriteriaEvent", error);
  } catch (err) {
    warn("logCriteriaEvent", err);
  }
}

// ── [3] My Options add/remove ───────────────────────────────────────────────
export async function logOptionEvent(input: {
  participantId: string;
  op: "add" | "remove";
  optionName: string;
  turnIndex?: number;
}): Promise<void> {
  if (!input.participantId) return;
  const supabase = getSupabase();
  if (!supabase) return;
  try {
    const { error } = await supabase.from("option_events").insert({
      participant_id: input.participantId,
      op: input.op,
      option_name: input.optionName,
      turn_index: input.turnIndex ?? null,
    });
    if (error) warn("logOptionEvent", error);
  } catch (err) {
    warn("logOptionEvent", err);
  }
}

// ── [4] 채팅 턴 + [5] action/template/edit 판정 ─────────────────────────────
export async function logChatTurn(input: {
  participantId: string;
  turnIndex: number;
  userText: string;
  action: "generate" | "edit" | "none";
  template?: string | null;
  editTarget?: string | null;
  editOp?: string | null;
}): Promise<void> {
  if (!input.participantId) return;
  const supabase = getSupabase();
  if (!supabase) return;
  try {
    const { error } = await supabase.from("chat_turns").insert({
      participant_id: input.participantId,
      turn_index: input.turnIndex,
      user_text: input.userText,
      action: input.action,
      template: input.template ?? null,
      edit_target: input.editTarget ?? null,
      edit_op: input.editOp ?? null,
    });
    if (error) warn("logChatTurn", error);

    // sessions.chat_turns는 분석 편의를 위한 비정규화 필드 — turn_index는 단조 증가하므로 그대로 덮어쓴다.
    const { error: updateError } = await supabase
      .from("sessions")
      .update({ chat_turns: input.turnIndex })
      .eq("participant_id", input.participantId);
    if (updateError) warn("logChatTurn(update chat_turns)", updateError);
  } catch (err) {
    warn("logChatTurn", err);
  }
}

// ── [5] TradeoffHint / UnchartedTerritoryChip 노출·채택 ─────────────────────
export async function logFeatureEvent(input: {
  participantId: string;
  feature: "tradeoff_hint" | "uncharted_territory";
  event: "shown" | "adopted";
  payload?: unknown;
  turnIndex?: number;
}): Promise<void> {
  if (!input.participantId) return;
  const supabase = getSupabase();
  if (!supabase) return;
  try {
    const { error } = await supabase.from("feature_events").insert({
      participant_id: input.participantId,
      feature: input.feature,
      event: input.event,
      payload: input.payload ?? null,
      turn_index: input.turnIndex ?? null,
    });
    if (error) warn("logFeatureEvent", error);
  } catch (err) {
    warn("logFeatureEvent", err);
  }
}

// ── [6] 구매/Outcome ─────────────────────────────────────────────────────────
export async function logPurchaseClicked(participantId: string): Promise<void> {
  if (!participantId) return;
  const supabase = getSupabase();
  if (!supabase) return;
  try {
    const { error } = await supabase
      .from("sessions")
      .update({ purchase_clicked_at: new Date().toISOString() })
      .eq("participant_id", participantId);
    if (error) warn("logPurchaseClicked", error);
  } catch (err) {
    warn("logPurchaseClicked", err);
  }
}

export async function logPurchaseConfirmed(input: {
  participantId: string;
  finalCriteria?: unknown;
  finalOptions?: unknown;
}): Promise<void> {
  if (!input.participantId) return;
  const supabase = getSupabase();
  if (!supabase) return;
  try {
    const { data, error: fetchError } = await supabase
      .from("sessions")
      .select("started_at")
      .eq("participant_id", input.participantId)
      .single();
    if (fetchError) {
      warn("logPurchaseConfirmed(fetch started_at)", fetchError);
      return;
    }

    const confirmedAt = new Date();
    const startedAt = data?.started_at ? new Date(data.started_at) : null;
    const timeToPurchaseMs = startedAt ? confirmedAt.getTime() - startedAt.getTime() : null;

    const { error } = await supabase
      .from("sessions")
      .update({
        purchase_confirmed_at: confirmedAt.toISOString(),
        time_to_purchase_ms: timeToPurchaseMs,
        final_criteria: input.finalCriteria ?? null,
        final_options: input.finalOptions ?? null,
      })
      .eq("participant_id", input.participantId);
    if (error) warn("logPurchaseConfirmed", error);
  } catch (err) {
    warn("logPurchaseConfirmed", err);
  }
}
