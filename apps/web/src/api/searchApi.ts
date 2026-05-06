// apps/web/src/api/searchApi.ts
import { apiFetch } from "./client";

export async function searchHobbyIQ(query: string) {
  return apiFetch("/api/search", {
    method: "POST",
    auth: true,
    body: JSON.stringify({ query }),
  });
}
