export const runtime = "nodejs";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const url = searchParams.get("url");

  if (!url) {
    return new Response("Missing url param", { status: 400 });
  }

  // 허용 도메인만 프록시 (보안)
  const allowed = [
    "img.danuri.io",
    "img.danawa.com",
    "prod.danawa.com",
  ];
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return new Response("Invalid url", { status: 400 });
  }
  if (!allowed.some((d) => hostname === d || hostname.endsWith("." + d))) {
    return new Response("Domain not allowed", { status: 403 });
  }

  try {
    const upstream = await fetch(url, {
      headers: {
        Referer: "https://www.danawa.com/",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      },
    });

    if (!upstream.ok) {
      return new Response(`Upstream error: ${upstream.status}`, {
        status: upstream.status,
      });
    }

    const contentType = upstream.headers.get("content-type") ?? "image/jpeg";
    const body = await upstream.arrayBuffer();

    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=86400, stale-while-revalidate=3600",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (e) {
    return new Response("Proxy fetch failed", { status: 502 });
  }
}
