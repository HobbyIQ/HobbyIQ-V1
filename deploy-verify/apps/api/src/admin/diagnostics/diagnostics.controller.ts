import { Router, Request, Response } from 'express';
import { DiagnosticsService } from './diagnostics.service';
import { ProviderHealthService } from '../../services/reliability/provider-health.service';

const providerHealth = new ProviderHealthService();
const diagnosticsService = new DiagnosticsService(providerHealth);

const router = Router();

router.get('/overview', async (req: Request, res: Response) => {
  const overview = await diagnosticsService.getOverview();
  res.json(overview);
});

// TODO: Add more endpoints for sync, snapshots, alerts, learning, imports, providers

export default router;
