// Test Danawa image CDN URL pattern from pcode
const testCases = [
  { pcode: "108229415", name: "삼성 비스포크" },
  { pcode: "106758212", name: "테스트2" },
  { pcode: "122664605", name: "테스트3" },
];

function buildDanawaImageUrl(pcode) {
  const p = pcode.padStart(9, "0");
  const last3 = p.slice(-3);
  const mid3 = p.slice(-6, -3);
  return `https://img.danawa.com/prod_img/500000/${last3}/${mid3}/img/${pcode}_1.jpg`;
}

for (const { pcode, name } of testCases) {
  const url = buildDanawaImageUrl(pcode);
  console.log(`\n${name} (pcode=${pcode})`);
  console.log("URL:", url);
  
  const res = await fetch(url, { method: "HEAD" });
  console.log("Status:", res.status, res.status === 200 ? "✅ 이미지 있음" : "❌ 없음");
}
