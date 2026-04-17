import { Request, Response } from 'express';
import { CompIQService } from '../../services/shared/compiq.service';
import { MockCompProvider } from '../../services/mock/mock-comp-provider';

const compService = new CompIQService(new MockCompProvider());

export async function compiqQuery(req: Request, res: Response) {
  const result = await compService.query(req.body);
  res.json(result);
}

export async function compiqEstimate(req: Request, res: Response) {
  const result = await compService.estimate(req.body);
  res.json(result);
}

export function compiqHealth(req: Request, res: Response) {
  res.json({ success: true, status: 'ok', service: 'CompIQ' });
}
