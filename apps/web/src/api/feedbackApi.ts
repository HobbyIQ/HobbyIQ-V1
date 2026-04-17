import { API_BASE_URL } from "../api";

export async function sendFeedback({ query, intent, summary, feedback }: { query: string; intent: string; summary: string; feedback: string }) {
  const res = await fetch(`${API_BASE_URL}/api/feedback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, intent, summary, feedback, timestamp: new Date().toISOString() })
  });
  if (!res.ok) throw new Error("Failed to send feedback");
  return res.json();
}
