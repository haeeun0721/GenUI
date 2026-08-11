import {
  createSession,
  logPurchaseClicked,
  logPurchaseConfirmed,
} from "@/lib/backend/services/research-log";

/**
 * 클라이언트(app/page.tsx)에서 발생하는 연구 로그 이벤트를 받아 Supabase에 적재한다.
 * SUPABASE_SERVICE_ROLE_KEY는 이 서버 라우트 안에서만 쓰이고 브라우저로 나가지 않는다.
 * 로그 실패가 사용자 흐름을 막으면 안 되므로 항상 200을 반환한다(best-effort).
 */
export async function POST(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false }, { status: 400 });
  }

  const { type, participantId } = body ?? {};
  if (!type || !participantId) {
    return Response.json({ ok: false }, { status: 400 });
  }

  try {
    switch (type) {
      case "session_start":
        await createSession({
          participantId,
          assignedItem: body.assignedItem ?? "",
          purchaseContext: body.purchaseContext ?? "",
          locale: body.locale,
        });
        break;

      case "purchase_clicked":
        await logPurchaseClicked(participantId);
        break;

      case "purchase_confirmed":
        await logPurchaseConfirmed({
          participantId,
          finalProductName: body.finalProductName ?? "",
        });
        break;

      default:
        return Response.json({ ok: false, error: "unknown type" }, { status: 400 });
    }
  } catch (err) {
    console.error("[/api/log-event]", err);
  }

  return Response.json({ ok: true });
}
