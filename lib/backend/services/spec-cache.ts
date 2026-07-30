/**
 * spec-cache.ts — Option List / Comp Table 공유 스펙 캐시
 *
 * 두 파이프라인이 동일한 (제품명, 기준) 조합에 대해
 * 서로 다른 값을 반환하는 문제를 방지한다.
 *
 * 구조:
 *  - in-memory Map: 같은 서버 세션 내 즉시 읽기 (0ms)
 *  - data/cell-cache.json: 서버 재시작 후에도 유지 (영속)
 *  - 디스크 쓰기는 2초 디바운스로 I/O 부하 최소화
 */

import fs from "fs";
import path from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SpecCacheEntry {
  value: string;
  source: "db" | "tavily" | "pre-enrich";
  sourceUrl?: string;
  usedSnippet?: string;
  cachedAt: string;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const CACHE_FILE = path.join(process.cwd(), "data", "cell-cache.json");

// 프로세스당 단일 인스턴스
const memCache = new Map<string, SpecCacheEntry>();
let loaded = false;

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")) as Record<string, unknown>;
      for (const [k, v] of Object.entries(raw)) {
        // 기존 cellCache 포맷(source 없음)도 마이그레이션
        const entry = v as Partial<SpecCacheEntry>;
        memCache.set(k, {
          value: entry.value ?? "-",
          source: entry.source ?? "tavily",
          sourceUrl: entry.sourceUrl,
          usedSnippet: entry.usedSnippet,
          cachedAt: entry.cachedAt ?? new Date().toISOString(),
        });
      }
      console.log(`[SpecCache] 로드: ${memCache.size}개 항목`);
    }
  } catch { /* ignore */ }
}

let writeTimer: ReturnType<typeof setTimeout> | null = null;

function schedulePersist(): void {
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    writeTimer = null;
    try {
      fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
      const obj: Record<string, SpecCacheEntry> = {};
      for (const [k, v] of memCache) obj[k] = v;
      fs.writeFileSync(CACHE_FILE, JSON.stringify(obj, null, 2), "utf8");
    } catch { /* ignore */ }
  }, 2000);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * 캐시 키 생성 — 양쪽 파이프라인이 반드시 같은 형식을 사용해야 함.
 * [중요], [보통] 같은 중요도 태그와 괄호 설명을 제거한 뒤 정규화.
 */
export function makeCacheKey(productName: string, fieldKey: string): string {
  const field = fieldKey.trim().replace(/\s*\[.*?\]\s*/g, "").replace(/\s*\(.*?\)\s*/g, "").trim();
  return `${productName.trim()}||${field}`;
}

/** 캐시에서 스펙 조회. 없거나 값이 "-"면 null 반환. */
export function getSpec(productName: string, fieldKey: string): SpecCacheEntry | null {
  ensureLoaded();
  const entry = memCache.get(makeCacheKey(productName, fieldKey));
  if (!entry || entry.value === "-") return null;
  return entry;
}

/** 캐시에 스펙 저장. 자동으로 디스크에 비동기 반영. */
export function setSpec(
  productName: string,
  fieldKey: string,
  value: string,
  source: SpecCacheEntry["source"] = "tavily",
  sourceUrl?: string,
  usedSnippet?: string
): void {
  ensureLoaded();
  const key = makeCacheKey(productName, fieldKey);
  memCache.set(key, {
    value,
    source,
    sourceUrl,
    usedSnippet,
    cachedAt: new Date().toISOString(),
  });
  schedulePersist();
}

/** 특정 항목 무효화 (오래된 값 강제 갱신 시) */
export function invalidateSpec(productName: string, fieldKey: string): void {
  ensureLoaded();
  memCache.delete(makeCacheKey(productName, fieldKey));
  schedulePersist();
}

/** 디버그용: 현재 캐시 크기 */
export function getCacheSize(): number {
  ensureLoaded();
  return memCache.size;
}
