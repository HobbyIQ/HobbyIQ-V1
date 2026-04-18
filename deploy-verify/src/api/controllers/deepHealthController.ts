import { Request, Response } from 'express';
import os from 'os';

export function deepHealthController(_req: Request, res: Response) {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    cpu: os.loadavg(),
    env: process.env.NODE_ENV,
    timestamp: new Date().toISOString()
  });
}
