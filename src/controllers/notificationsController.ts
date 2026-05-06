import type { NextFunction, Request, Response } from "express";
import {
    alertPreferencesSchema,
    deviceTokenRegisterRequestSchema,
    notificationEvaluateSchema,
    notificationTestSchema,
} from "../models/types";
import { notificationsService } from "../services/notificationsService";

function getUserId(req: Request): string {
    const raw = req.query.userId;
    if (typeof raw === "string" && raw.trim().length > 0) {
        return raw.trim();
    }

    const bodyUserId = (req.body as { userId?: unknown } | undefined)?.userId;
    if (typeof bodyUserId === "string" && bodyUserId.trim().length > 0) {
        return bodyUserId.trim();
    }

    return "demo";
}

function respondValidationError(res: Response, message: string, issues: unknown) {
    return res.status(400).json({ message, issues });
}

export const notificationsController = {
    health(_req: Request, res: Response) {
        res.json(notificationsService.getHealth());
    },

    async registerDevice(req: Request, res: Response, next: NextFunction) {
        try {
            const parsed = deviceTokenRegisterRequestSchema.safeParse(req.body);
            if (!parsed.success) {
                return respondValidationError(res, "Invalid device registration payload", parsed.error.flatten());
            }

            const result = await notificationsService.registerDeviceToken(parsed.data);
            res.status(201).json(result);
        } catch (error) {
            next(error);
        }
    },

    async preferences(req: Request, res: Response, next: NextFunction) {
        try {
            const userId = getUserId(req);
            const preferences = await notificationsService.getPreferences(userId);
            res.json(preferences);
        } catch (error) {
            next(error);
        }
    },

    async updatePreferences(req: Request, res: Response, next: NextFunction) {
        try {
            const parsed = alertPreferencesSchema.safeParse(req.body);
            if (!parsed.success) {
                return respondValidationError(res, "Invalid notification preferences payload", parsed.error.flatten());
            }

            const preferences = await notificationsService.updatePreferences(parsed.data);
            res.json(preferences);
        } catch (error) {
            next(error);
        }
    },

    async evaluate(req: Request, res: Response, next: NextFunction) {
        try {
            const parsed = notificationEvaluateSchema.safeParse(req.body);
            if (!parsed.success) {
                return respondValidationError(res, "Invalid notification evaluation payload", parsed.error.flatten());
            }

            const result = await notificationsService.evaluate(parsed.data.userId);
            res.json(result);
        } catch (error) {
            next(error);
        }
    },

    async test(req: Request, res: Response, next: NextFunction) {
        try {
            const parsed = notificationTestSchema.safeParse(req.body);
            if (!parsed.success) {
                return respondValidationError(res, "Invalid notification test payload", parsed.error.flatten());
            }

            const result = await notificationsService.sendTestNotification(parsed.data);
            res.status(201).json(result);
        } catch (error) {
            next(error);
        }
    },
};
