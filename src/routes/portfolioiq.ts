import { Router, type Request, type Response } from "express";
import {
    portfolioIQBulkHoldingCreateSchema,
    portfolioIQHoldingCreateSchema,
    portfolioIQSaleSchema,
} from "../models/portfolioiq";
import { portfolioIQService } from "../services/portfolioiqService";

const router = Router();
const defaultUserId = "demo";

function getUserId(req: Request): string {
    const raw = req.query.userId;
    if (typeof raw === "string" && raw.trim().length > 0) {
        return raw.trim();
    }

    return defaultUserId;
}

function respondValidationError(res: Response, message: string, issues: unknown) {
    return res.status(400).json({
        message,
        issues,
    });
}

router.get("/inventory", async (req, res, next) => {
    try {
        const userId = getUserId(req);
        const holdings = await portfolioIQService.getHoldings(userId);
        res.json({ holdings });
    } catch (error) {
        next(error);
    }
});

router.post("/inventory", async (req, res, next) => {
    try {
        const userId = getUserId(req);
        const body = req.body as unknown;

        if (body && typeof body === "object" && Array.isArray((body as { cards?: unknown[] }).cards)) {
            const parsed = portfolioIQBulkHoldingCreateSchema.safeParse(body);
            if (!parsed.success) {
                return respondValidationError(res, "Invalid bulk inventory payload", parsed.error.flatten());
            }

            const holdings = await portfolioIQService.createHoldings(parsed.data.cards, userId);
            return res.status(201).json({ holdings });
        }

        const parsed = portfolioIQHoldingCreateSchema.safeParse(body);
        if (!parsed.success) {
            return respondValidationError(res, "Invalid inventory payload", parsed.error.flatten());
        }

        const holding = await portfolioIQService.createHolding(parsed.data, userId);
        return res.status(201).json({ holding });
    } catch (error) {
        next(error);
    }
});

router.post("/reprice", async (req, res, next) => {
    try {
        const userId = getUserId(req);
        const holdings = await portfolioIQService.repriceHoldings(userId);
        res.json({ holdings });
    } catch (error) {
        next(error);
    }
});

router.post("/sale", async (req, res, next) => {
    try {
        const userId = getUserId(req);
        const parsed = portfolioIQSaleSchema.safeParse(req.body);
        if (!parsed.success) {
            return respondValidationError(res, "Invalid sale payload", parsed.error.flatten());
        }

        const result = await portfolioIQService.markAsSold(parsed.data, userId);
        res.json(result);
    } catch (error) {
        next(error);
    }
});

router.get("/summary", async (req, res, next) => {
    try {
        const userId = getUserId(req);
        const summary = await portfolioIQService.getSummary(userId);
        res.json(summary);
    } catch (error) {
        next(error);
    }
});

router.get("/holdings", async (req, res, next) => {
    try {
        const userId = getUserId(req);
        const holdings = await portfolioIQService.getHoldings(userId);
        res.json({ holdings });
    } catch (error) {
        next(error);
    }
});

router.post("/holdings", async (req, res, next) => {
    try {
        const userId = getUserId(req);
        const body = req.body as unknown;

        if (body && typeof body === "object" && Array.isArray((body as { cards?: unknown[] }).cards)) {
            const parsed = portfolioIQBulkHoldingCreateSchema.safeParse(body);
            if (!parsed.success) {
                return respondValidationError(res, "Invalid bulk holdings payload", parsed.error.flatten());
            }

            const holdings = await portfolioIQService.createHoldings(parsed.data.cards, userId);
            return res.status(201).json({ holdings });
        }

        const parsed = portfolioIQHoldingCreateSchema.safeParse(body);
        if (!parsed.success) {
            return respondValidationError(res, "Invalid holdings payload", parsed.error.flatten());
        }

        const holding = await portfolioIQService.createHolding(parsed.data, userId);
        return res.status(201).json({ holding });
    } catch (error) {
        next(error);
    }
});

export default router;
