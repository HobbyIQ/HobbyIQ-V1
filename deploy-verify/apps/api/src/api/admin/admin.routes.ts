import { Router } from 'express';
import diagnosticsRouter from '../../admin/diagnostics/diagnostics.controller';
import opsRouter from '../../admin/ops/ops.controller';
import reviewRouter from '../../admin/review/review.controller';

const router = Router();

router.use('/diagnostics', diagnosticsRouter);
router.use('/ops', opsRouter);
router.use('/review', reviewRouter);

export default router;
