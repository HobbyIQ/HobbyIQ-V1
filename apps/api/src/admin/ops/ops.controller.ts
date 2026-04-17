import { Router, Request, Response } from 'express';
import { OpsService } from './ops.service';

const opsService = new OpsService();
const router = Router();

router.post('/sync/:provider', async (req: Request, res: Response) => {
  const provider = req.params.provider as 'ebay' | 'psa';
  const result = await opsService.triggerProviderSync(provider);
  res.json(result);
});

router.post('/refresh/:entityType', async (req: Request, res: Response) => {
  const entityType = req.params.entityType as 'card' | 'player';
  const result = await opsService.triggerSnapshotRefresh(entityType);
  res.json(result);
});

router.post('/learning/run', async (req: Request, res: Response) => {
  const result = await opsService.triggerLearningRun();
  res.json(result);
});

router.post('/imports/:batchId/retry', async (req: Request, res: Response) => {
  const result = await opsService.retryImportBatch(req.params.batchId);
  res.json(result);
});

router.post('/seed-demo-data', async (req: Request, res: Response) => {
  const result = await opsService.seedDemoData();
  res.json(result);
});

export default router;
