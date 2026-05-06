import { Router, Request, Response } from "express";
import { getUserBySession } from "../../services/authService";
import { portfolioHoldingsRepository } from "../../repositories/portfolioHoldingsRepository";

const router = Router();

async function resolveAuthenticatedUserId(req: Request): Promise<string | null> {
  const sessionId = String(req.headers["x-session-id"] ?? "").trim();
  if (!sessionId) {
    return null;
  }

  const user = await getUserBySession(sessionId);
  return user?.userId ?? null;
}

router.get("/holdings", async (req: Request, res: Response) => {
  const userId = await resolveAuthenticatedUserId(req);
  if (!userId) {
    return res.status(401).json({ error: "Sign in required" });
  }

  const holdings = await portfolioHoldingsRepository.getList(userId);
  const mode = await portfolioHoldingsRepository.storageMode();
  return res.json({
    userId,
    count: holdings.length,
    storage: mode,
    holdings,
  });
});

router.post("/holdings/migrate", async (req: Request, res: Response) => {
  const sessionId = String(req.headers["x-session-id"] ?? "").trim();
  const user = sessionId ? await getUserBySession(sessionId) : null;
  if (!user) {
    return res.status(401).json({ error: "Sign in required" });
  }
  if (user.plan !== "all-star") {
    return res.status(403).json({ error: "Only all-star users can run migration" });
  }

  const result = await portfolioHoldingsRepository.migrateUserFromFile(user.userId);
  return res.json({
    message: result.mode === "cosmos" ? "Migration completed" : "Cosmos not configured; migration skipped",
    storage: result.mode,
    migrated: result.migrated,
  });
});

router.post("/holdings", async (req: Request, res: Response) => {
  const userId = await resolveAuthenticatedUserId(req);
  if (!userId) {
    return res.status(401).json({ error: "Sign in required" });
  }

  if (!req.body || typeof req.body !== "object") {
    return res.status(400).json({ error: "Holding payload is required" });
  }

  const added = await portfolioHoldingsRepository.add(userId, req.body as Record<string, unknown>);
  if (!added) {
    return res.status(409).json({ error: "Holding already exists" });
  }

  return res.status(201).json({ message: "Holding added", item: added });
});

router.put("/holdings/:id", async (req: Request, res: Response) => {
  const userId = await resolveAuthenticatedUserId(req);
  if (!userId) {
    return res.status(401).json({ error: "Sign in required" });
  }

  const id = String(req.params.id ?? "").trim();
  if (!id) {
    return res.status(400).json({ error: "Holding id is required" });
  }

  if (!req.body || typeof req.body !== "object") {
    return res.status(400).json({ error: "Holding payload is required" });
  }

  const updated = await portfolioHoldingsRepository.update(userId, id, req.body as Record<string, unknown>);
  if (!updated) {
    return res.status(404).json({ error: "Holding not found" });
  }

  return res.json({ message: "Holding updated", item: updated });
});

router.delete("/holdings/:id", async (req: Request, res: Response) => {
  const userId = await resolveAuthenticatedUserId(req);
  if (!userId) {
    return res.status(401).json({ error: "Sign in required" });
  }

  const id = String(req.params.id ?? "").trim();
  if (!id) {
    return res.status(400).json({ error: "Holding id is required" });
  }

  const removed = await portfolioHoldingsRepository.remove(userId, id);
  if (!removed) {
    return res.status(404).json({ error: "Holding not found" });
  }

  return res.json({ message: "Holding removed" });
});

export default router;
