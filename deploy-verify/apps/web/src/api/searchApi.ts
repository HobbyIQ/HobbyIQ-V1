// apps/web/src/api/searchApi.ts
import { API_BASE_URL } from "../api";

export async function searchHobbyIQ(query: string) {
  const res = await fetch(`${API_BASE_URL}/api/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query })
  });
  if (!res.ok) throw new Error("Search failed");
  return res.json();
}
