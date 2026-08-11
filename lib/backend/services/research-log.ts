/**
 * research-log.ts — baseline 참여자 행동 로그를 Supabase에 적재한다.
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

// ── 세션 생성 ────────────────────────────────────────────────────────────────
export async function createSession(input: {
  participantId: string;
  assignedItem: string;
  purchaseContext: string;
  locale?: string;
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
        locale: input.locale ?? null,
        started_at: new Date().toISOString(),
      },
      { onConflict: "participant_id", ignoreDuplicates: true }
    );
    if (error) warn("createSession", error);
  } catch (err) {
    warn("createSession", err);
  }
}

// ── 채팅 턴: 사용자 입력 + 어시스턴트 답변 + tool 호출 내역 ───────────────────
export interface ChatTurnToolCall {
  tool: string;
  input: unknown;
  output: unknown;
}

export async function logChatTurn(input: {
  participantId: string;
  turnIndex: number;
  userText: string;
  assistantText: string;
  toolCalls?: ChatTurnToolCall[];
}): Promise<void> {
  if (!input.participantId) return;
  const supabase = getSupabase();
  if (!supabase) return;
  try {
    const { error } = await supabase.from("chat_turns").insert({
      participant_id: input.participantId,
      turn_index: input.turnIndex,
      user_text: input.userText,
      assistant_text: input.assistantText,
      tool_calls: input.toolCalls && input.toolCalls.length > 0 ? input.toolCalls : null,
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

// ── 구매/Outcome ─────────────────────────────────────────────────────────────
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
  finalProductName: string;
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
        final_product_name: input.finalProductName,
      })
      .eq("participant_id", input.participantId);
    if (error) warn("logPurchaseConfirmed", error);
  } catch (err) {
    warn("logPurchaseConfirmed", err);
  }
}
