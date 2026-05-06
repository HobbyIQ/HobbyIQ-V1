import type { NextFunction, Request, Response } from "express";
import { sellIQEvaluateRequestSchema } from "../models/types";
import { sellIQService } from "../services/selliqService";

export const selliqController = {
    health(_req: Request, res: Response) {
        res.json(sellIQService.getHealth());
    },

    evaluate(req: Request, res: Response, next: NextFunction) {
        try {
            const parsed = sellIQEvaluateRequestSchema.safeParse(req.body);
            if (!parsed.success) {
                return res.status(400).json({
                    message: "Invalid SellIQ payload",
                    issues: parsed.error.flatten(),
                });
            }

            res.json(sellIQService.evaluateCard(parsed.data));
        } catch (error) {
            next(error);
        }
    },
};
