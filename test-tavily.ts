import fs from "fs";

function getEnv(key: string): string | undefined {
  try {
    const envFile = fs.readFileSync(".env.local", "utf8");
    const match = envFile.match(new RegExp(`^${key}=(.*)`, "m"));
    return match ? match[1].trim() : undefined;
  } catch {
    return undefined;
  }
}

async function testTavily() {
  const apiKey = getEnv("TAVILY_API_KEY");
  if (!apiKey) {
    console.error("TAVILY_API_KEY is not set.");
    return;
  }
  
  console.log("Testing Tavily API...");
  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify({ query: "로보락 S10 MaxV Ultra 소음", search_depth: "basic", max_results: 5 }),
    });
    
    if (!res.ok) {
      console.error("Tavily API Error:", res.status, res.statusText);
      const text = await res.text();
      console.error("Response:", text);
      return;
    }
    
    const data = await res.json();
    console.log("Success! Results:", data.results?.length ?? 0);
    if (data.results && data.results.length > 0) {
      console.log("First result:", data.results[0].title);
      console.log("Snippet:", data.results[0].content.substring(0, 100) + "...");
    }
  } catch (err) {
    console.error("Fetch error:", err);
  }
}

testTavily();
