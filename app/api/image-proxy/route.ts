export const runtime = "nodejs";

const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"];
const MAX_URL_LENGTH = 2000;

// Simple SVG placeholder returned when image fetch fails
const PLACEHOLDER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200">
  <rect width="200" height="200" fill="#f3f4f6"/>
  <rect x="70" y="60" width="60" height="50" rx="4" fill="#d1d5db"/>
  <circle cx="100" cy="130" r="20" fill="#d1d5db"/>
</svg>`;

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const imageUrl = searchParams.get("url");

  if (!imageUrl) {
    return placeholderResponse();
  }

  // Reject suspiciously long URLs
  if (imageUrl.length > MAX_URL_LENGTH) {
    console.warn("[image-proxy] URL too long:", imageUrl.length);
    return placeholderResponse();
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(imageUrl);
  } catch {
    return placeholderResponse();
  }

  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    return placeholderResponse();
  }

  try {
    const res = await fetch(imageUrl, {
      signal: AbortSignal.timeout(8000), // 8s timeout
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        Referer: `${parsedUrl.protocol}//${parsedUrl.host}/`,
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      },
    });

    if (!res.ok) {
      console.warn(`[image-proxy] Upstream ${res.status} for ${imageUrl.slice(0, 80)}`);
      return placeholderResponse();
    }

    const contentType = res.headers.get("Content-Type") ?? "";
    const isImage = ALLOWED_TYPES.some((t) => contentType.startsWith(t));
    if (!isImage) {
      return placeholderResponse();
    }

    return new Response(res.body, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (err) {
    console.warn("[image-proxy] Fetch failed:", (err as Error).message?.slice(0, 80));
    return placeholderResponse();
  }
}

function placeholderResponse() {
  return new Response(PLACEHOLDER_SVG, {
    status: 200,
    headers: {
      "Content-Type": "image/svg+xml",
      "Cache-Control": "public, max-age=300",
    },
  });
}
