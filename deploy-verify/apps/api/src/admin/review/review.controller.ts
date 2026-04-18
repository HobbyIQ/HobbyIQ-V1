import { Router, Request, Response } from 'express';
import { ReviewService } from './review.service';

const reviewService = new ReviewService();
const router = Router();

router.get('/', async (req: Request, res: Response) => {
  const type = req.query.type as string | undefined;
  const items = await reviewService.listReviewItems(type);
  res.json(items);
});

export default router;
