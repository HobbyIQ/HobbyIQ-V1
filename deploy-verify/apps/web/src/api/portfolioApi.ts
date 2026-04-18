import { API_BASE_URL } from "../api";

export async function saveToPortfolio({ player, description, estimatedValue }: { player: string; description: string; estimatedValue?: number }) {
  const res = await fetch(`${API_BASE_URL}/api/portfolio`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ player, description, estimatedValue })
  });
  if (!res.ok) throw new Error("Failed to save to portfolio");
  return res.json();
}
