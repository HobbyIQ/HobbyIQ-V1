import { Request, Response, Router } from 'express';
import { PortfolioService } from './portfolio.service';
import { PortfolioPositionDto, PortfolioSummaryDto, PortfolioAllocationSummaryDto, PortfolioExposureSummaryDto, PortfolioActionPlanDto, PortfolioPositionViewDto } from './portfolio.dto';

export function createPortfolioController(service: PortfolioService): Router {
  const router = Router();

  // GET /api/portfolio
  router.get('/', async (req: Request, res: Response) => {
    const userId = req.user.id;
    const positions = await service.position.listPositions(userId);
    // TODO: Enrich with metrics/action plan
    res.json(positions as PortfolioPositionDto[]);
  });

  // GET /api/portfolio/summary
  router.get('/summary', async (req: Request, res: Response) => {
    const userId = req.user.id;
    const positions = await service.position.listPositions(userId);
    const summary = service.summary.computeSummary(userId, positions);
    res.json(summary as PortfolioSummaryDto);
  });

  // GET /api/portfolio/allocation
  router.get('/allocation', async (req: Request, res: Response) => {
    const userId = req.user.id;
    const positions = await service.position.listPositions(userId);
    const allocation = service.allocation.computeAllocation(userId, positions);
    res.json(allocation as PortfolioAllocationSummaryDto);
  });

  // GET /api/portfolio/exposure
  router.get('/exposure', async (req: Request, res: Response) => {
    const userId = req.user.id;
    const positions = await service.position.listPositions(userId);
    const exposure = service.exposure.computeExposure(userId, positions);
    res.json(exposure as PortfolioExposureSummaryDto);
  });

  // GET /api/portfolio/:positionId
  router.get('/:positionId', async (req: Request, res: Response) => {
    const userId = req.user.id;
    const position = await service.position.getPosition(req.params.positionId, userId);
    if (!position) return res.status(404).json({ error: 'Not found' });
    res.json(position as PortfolioPositionDto);
  });

  // POST /api/portfolio
  router.post('/', async (req: Request, res: Response) => {
    const userId = req.user.id;
    try {
      const position = await service.position.createPosition({ ...req.body, userId });
      res.status(201).json(position as PortfolioPositionDto);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  // PATCH /api/portfolio/:positionId
  router.patch('/:positionId', async (req: Request, res: Response) => {
    const userId = req.user.id;
    try {
      const position = await service.position.updatePosition(req.params.positionId, userId, req.body);
      res.json(position as PortfolioPositionDto);
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  // DELETE /api/portfolio/:positionId
  router.delete('/:positionId', async (req: Request, res: Response) => {
    const userId = req.user.id;
    await service.position.deletePosition(req.params.positionId, userId);
    res.status(204).send();
  });

  // POST /api/portfolio/import
  router.post('/import', async (req: Request, res: Response) => {
    const userId = req.user.id;
    const result = await service.importService.importPositions(userId, req.body.positions);
    res.json(result);
  });

  // GET /api/portfolio/:positionId/action-plan
  router.get('/:positionId/action-plan', async (req: Request, res: Response) => {
    const userId = req.user.id;
    const position = await service.position.getPosition(req.params.positionId, userId);
    if (!position) return res.status(404).json({ error: 'Not found' });
    // TODO: Compute metrics and action plan
    res.json({} as PortfolioActionPlanDto);
  });

  return router;
}
