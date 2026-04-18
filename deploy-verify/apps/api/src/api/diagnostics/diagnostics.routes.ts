import { Router } from 'express';
import diagnosticsRouter from '../../admin/diagnostics/diagnostics.controller';

const router = Router();
router.use('/', diagnosticsRouter);
export default router;
