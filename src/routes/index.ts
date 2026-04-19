import { Router } from 'express';
import healthRoutes from './health';
import compiqRoutes from './compiq';

const router = Router();

router.use('/health', healthRoutes);
router.use('/compiq', compiqRoutes);

export default router;
