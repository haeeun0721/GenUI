/**
 * lib/backend/timing.ts
 * 요청 파이프라인 각 단계의 소요시간을 재서 로그로 남기는 계측 전용 유틸.
 *
 * 목적: 지금까지의 병목 분석은 코드 구조(순차/병렬 여부, 캐시 유무)에 근거한 추정이었다.
 * 실제 운영 트래픽에서 어느 단계가 진짜 느린지(p50/p95/p99)를 알려면 실측이 필요하고,
 * 그러려면 먼저 구간별 소요시간을 남겨야 한다 — 이 파일은 그 계측만 담당하며 어떤
 * 제어 흐름도 바꾸지 않는다(에러도 그대로 다시 던짐).
 *
 * 로그 포맷은 고정: "[Timing] req=<id> stage=<name> ms=<n> ok|err"
 * — grep/집계가 쉽도록 한 줄에 필요한 필드만 담는다.
 */

export async function time<T>(stage: string, requestId: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  const reqTag = requestId ? requestId.slice(0, 10) : "-";
  try {
    const result = await fn();
    console.log(`[Timing] req=${reqTag} stage=${stage} ms=${Date.now() - t0} ok`);
    return result;
  } catch (err) {
    console.log(`[Timing] req=${reqTag} stage=${stage} ms=${Date.now() - t0} err`);
    throw err;
  }
}

/** 비동기 함수가 아니라 이미 시작된 시각만 갖고 있을 때(구간의 끝에서) 한 줄 로그를 남기는 헬퍼. */
export function logElapsed(stage: string, requestId: string, startedAt: number, status: "ok" | "err" = "ok") {
  const reqTag = requestId ? requestId.slice(0, 10) : "-";
  console.log(`[Timing] req=${reqTag} stage=${stage} ms=${Date.now() - startedAt} ${status}`);
}
