/**
 * spec-cache.ts — 참가자별 스펙 조회 값 캐시
 *
 * 같은 제품×기준을 Option List와 Comparison Table이 각자 독립적으로 웹 검색하면
 * (서로 다른 페이지/측정 조건을 주워와) 값이 갈릴 수 있다. 한 번 조회에 성공한
 * 값을 참가자 단위로 Redis(Upstash)에 캐싱해, 이후 같은 참가자의 어느 패널이
 * 같은 제품×기준을 다시 물어봐도 항상 같은 값을 받도록 한다.
 *
 * session-memory.ts와 동일한 KV_REST_API_URL/TOKEN, 동일한 Redis 클라이언트
 * 패턴을 재사용한다. 키에 participantId를 반드시 포함시켜, 이 앱이 실험
 * 프로토타입으로 쓰일 때 참가자(P1/P2...) 간 데이터가 서로 섞이지 않게 한다 —
 * participantId가 비어 있으면(참가자 태그 없는 요청) 캐싱 자체를 하지 않는다.
 */

import { Redis } from "@upstash/redis";

function getRedis(): Redis | null {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

const CACHE_KEY_PREFIX = "spec-cache:";
const TTL_SECONDS = 60 * 60 * 24 * 30; // 30일 — session-memory.ts와 동일한 실험 종료 후 정리 주기

function normalizeKeyPart(s: string): string {
  return s.toLowerCase().replace(/\s+/g, "");
}

function buildKey(participantId: string, productName: string, fieldKey: string): string {
  return `${CACHE_KEY_PREFIX}${participantId}:${normalizeKeyPart(productName)}::${normalizeKeyPart(fieldKey)}`;
}

/** 참가자가 이전에 같은 제품×기준을 조회한 적이 있으면 그 값을 반환. 없으면 null. */
export async function getCachedSpec(
  participantId: string,
  productName: string,
  fieldKey: string
): Promise<string | null> {
  if (!participantId) return null;
  const redis = getRedis();
  if (!redis) return null;
  try {
    const value = await redis.get<string>(buildKey(participantId, productName, fieldKey));
    if (value) console.log(`🗄️  [SpecCache] "${productName}" × "${fieldKey}" → "${value}" (participant=${participantId})`);
    return value ?? null;
  } catch (err) {
    console.error("[SpecCache] get 실패:", err);
    return null;
  }
}

/** 새로 확정된 제품×기준 값을 참가자 캐시에 저장한다. */
export async function setCachedSpec(
  participantId: string,
  productName: string,
  fieldKey: string,
  value: string
): Promise<void> {
  if (!participantId || !value || value === "-") return;
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.set(buildKey(participantId, productName, fieldKey), value, { ex: TTL_SECONDS });
  } catch (err) {
    console.error("[SpecCache] set 실패:", err);
  }
}
