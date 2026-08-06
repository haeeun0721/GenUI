/**
 * session-memory.ts — 참가자별 공유 메모리 저장소
 *
 * "이번 세션 안에서만" 살아있던 대화/생성물 기억을, 참가자 단위로 Redis(Upstash)에
 * 영속화한다. rate-limit.ts와 동일한 KV_REST_API_URL/TOKEN을 재사용 — 로컬 파일이
 * 아니라 Redis를 쓰는 이유는 Vercel 같은 서버리스 배포에서는 로컬 디스크 write가
 * 다음 요청에 안 남기 때문.
 *
 * 여러 판단 에이전트(intent_analyzer/action_router/edit_agent)가 아니라, 오케스트레이터인
 * route.ts만 이 모듈을 호출한다 — 필요한 지점(응답을 생성하는 system prompt)에만
 * 메모리 텍스트를 얹어주고, 각 에이전트는 이 모듈의 존재 자체를 모른다.
 */

import { Redis } from "@upstash/redis";

function getRedis(): Redis | null {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

const MEMORY_KEY_PREFIX = "session-memory:";
const MAX_TURNS = 20; // 오래된 턴은 잘라내 토큰 폭증을 막는다
const TTL_SECONDS = 60 * 60 * 24 * 30; // 30일 — 실험 종료 후 무한정 남지 않도록

export interface MemoryTurnInput {
  turn: number;
  userText: string;
  action: "generate" | "edit" | "none";
  template?: string | null;
  note: string;
}

function formatTurn({ turn, userText, action, template, note }: MemoryTurnInput): string {
  const lines = [`## Turn ${turn}`];
  if (userText) lines.push(`User: ${userText.slice(0, 200)}`);
  lines.push(`Action: ${action}${template ? ` (${template})` : ""}`);
  if (note) lines.push(`Result: ${note.slice(0, 300)}`);
  return lines.join("\n");
}

/** 참가자의 누적 메모리(마크다운 텍스트)를 읽어온다. Redis 미설정/오류 시 빈 문자열. */
export async function loadMemory(participantId: string): Promise<string> {
  if (!participantId) return "";
  const redis = getRedis();
  if (!redis) return "";
  try {
    const text = await redis.get<string>(`${MEMORY_KEY_PREFIX}${participantId}`);
    return text ?? "";
  } catch (err) {
    console.error("[SessionMemory] load 실패:", err);
    return "";
  }
}

/** 이번 턴의 요약을 참가자 메모리에 추가한다. 최근 MAX_TURNS개만 유지(요약본 롤링 윈도우). */
export async function appendMemoryTurn(participantId: string, input: MemoryTurnInput): Promise<void> {
  if (!participantId) return;
  const redis = getRedis();
  if (!redis) return;
  try {
    const key = `${MEMORY_KEY_PREFIX}${participantId}`;
    const existing = (await redis.get<string>(key)) ?? "";
    const entries = existing ? existing.split(/\n(?=## )/) : [];
    entries.push(formatTurn(input));
    const trimmed = entries.slice(-MAX_TURNS);
    await redis.set(key, trimmed.join("\n\n"), { ex: TTL_SECONDS });
  } catch (err) {
    console.error("[SessionMemory] append 실패:", err);
  }
}
