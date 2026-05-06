import { apiFetch } from "./client";

export async function saveToPortfolio({ player, description, estimatedValue }: { player: string; description: string; estimatedValue?: number }) {
  return apiFetch("/api/portfolio", {
    method: "POST",
    auth: true,
    body: JSON.stringify({ player, description, estimatedValue }),
  });
}
