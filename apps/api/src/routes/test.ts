import { Router, Request, Response } from "express";

const router = Router();

router.get("/test", (_req: Request, res: Response) => {
  res.json({
    message: "HobbyIQ API is working",
    timestamp: new Date().toISOString()
  });
});

export default router;
