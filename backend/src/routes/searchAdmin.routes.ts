// CF-SEARCH-ADMIN-ROUTES (2026-07-08, Drew):
// Admin surface for manually adding/correcting search aliases without
// a code deploy. Gated by requireAdmin (bearer token via ADMIN_API_TOKEN).
//
// Endpoints:
//   POST   /api/admin/aliases              - upsert an alias entry
//   DELETE /api/admin/aliases/:cat/:canon  - soft-delete an alias entry
//   POST   /api/admin/aliases/reload       - force the in-memory index refresh
//   GET    /api/admin/aliases/health       - inspection (loadedAt, source, size)

import { Router } from "express";
import { requireAdmin } from "../middleware/requireAdmin.js";
import {
  upsertAlias,
  softDeleteAlias,
  type SearchAliasCategory,
} from "../repositories/searchAliases.repository.js";
import {
  reloadAliasIndex,
  getAliasIndex,
} from "../services/search/aliasStore.service.js";

const router = Router();
router.use(requireAdmin);

const VALID_CATEGORIES: readonly SearchAliasCategory[] = [
  "parallel",
  "set",
  "player",
  "grader",
  "general",
];

router.post("/aliases", async (req, res, next) => {
  try {
    const { category, canonical, aliases, notes, sampleCardId } = req.body || {};
    if (typeof category !== "string" || !VALID_CATEGORIES.includes(category as SearchAliasCategory)) {
      return res.status(400).json({
        success: false,
        error: `\"category\" must be one of: ${VALID_CATEGORIES.join(", ")}`,
      });
    }
    if (typeof canonical !== "string" || !canonical.trim()) {
      return res.status(400).json({ success: false, error: 'Missing "canonical" field' });
    }
    if (!Array.isArray(aliases) || aliases.some((a) => typeof a !== "string")) {
      return res.status(400).json({
        success: false,
        error: '"aliases" must be a string array',
      });
    }

    await upsertAlias({
      category: category as SearchAliasCategory,
      canonical: canonical.trim(),
      aliases: aliases.map((a: string) => a.trim()).filter(Boolean),
      source: "admin",
      confidence: 1.0,
      lastConfirmedAt: new Date().toISOString(),
      sampleCardId: typeof sampleCardId === "string" ? sampleCardId : undefined,
      notes: typeof notes === "string" ? notes : undefined,
    });

    // Reload the in-memory index so the change is live immediately.
    await reloadAliasIndex();
    return res.json({ success: true });
  } catch (err) {
    return next(err);
  }
});

router.delete("/aliases/:category/:canonical", async (req, res, next) => {
  try {
    const { category, canonical } = req.params;
    if (!VALID_CATEGORIES.includes(category as SearchAliasCategory)) {
      return res.status(400).json({ success: false, error: "Invalid category" });
    }
    if (!canonical || !canonical.trim()) {
      return res.status(400).json({ success: false, error: "Missing canonical" });
    }
    await softDeleteAlias(category as SearchAliasCategory, decodeURIComponent(canonical));
    await reloadAliasIndex();
    return res.json({ success: true });
  } catch (err) {
    return next(err);
  }
});

router.post("/aliases/reload", async (_req, res, next) => {
  try {
    const idx = await reloadAliasIndex();
    return res.json({
      success: true,
      loadedAt: idx.loadedAt.toISOString(),
      source: idx.source,
      aliasKeys: idx.byAlias.size,
      canonicals: idx.byCanonical.size,
    });
  } catch (err) {
    return next(err);
  }
});

router.get("/aliases/health", async (_req, res, next) => {
  try {
    const idx = await getAliasIndex();
    return res.json({
      success: true,
      loadedAt: idx.loadedAt.toISOString(),
      source: idx.source,
      aliasKeys: idx.byAlias.size,
      canonicals: idx.byCanonical.size,
    });
  } catch (err) {
    return next(err);
  }
});

export default router;
