import { z } from 'zod';
// Type-only import removed for CommonJS compatibility

const CardSubjectSchema = z.object({
  playerName: z.string(),
  cardYear: z.number().optional(),
  brand: z.string().optional(),
  setName: z.string().optional(),
  product: z.string().optional(),
  parallel: z.string().optional(),
  serialNumber: z.string().optional(),
  variation: z.string().optional(),
  gradeCompany: z.string().optional(),
  gradeValue: z.union([z.number(), z.string()]).optional(),
  isAuto: z.boolean().optional(),
  isPatch: z.boolean().optional(),
  team: z.string().optional(),
  cardNumber: z.string().optional(),
});

const CompInputSchema = z.object({
  id: z.string().optional(),
  source: z.string().optional(),
  sourceUrl: z.string().optional(),
  title: z.string().optional(),
  price: z.number(),
  currency: z.string().optional(),
  date: z.string(),
  listingType: z.enum(['auction', 'bin']).optional(),
  listingStartDate: z.string().optional(),
  saleDate: z.string().optional(),
  bidderCount: z.number().optional(),
  acceptedOffer: z.boolean().optional(),
  acceptedOfferEstimatedDiscountPct: z.number().optional(),
  sellerFeedbackScore: z.number().optional(),
  sellerFeedbackCount: z.number().optional(),
  imageCount: z.number().optional(),
  titleQualityScore: z.number().optional(),
  categoryAccuracyScore: z.number().optional(),
  descriptionQualityScore: z.number().optional(),
  parallel: z.string().optional(),
  serialNumber: z.string().optional(),
  gradeCompany: z.string().optional(),
  gradeValue: z.union([z.number(), z.string()]).optional(),
  isAuto: z.boolean().optional(),
  isPatch: z.boolean().optional(),
  isNumbered: z.boolean().optional(),
  cardYear: z.number().optional(),
  product: z.string().optional(),
  playerName: z.string().optional(),
  team: z.string().optional(),
  relistCount: z.number().optional(),
  hadPriceCut: z.boolean().optional(),
});

const MarketContextSchema = z.object({
  activeListings: z.number().optional(),
  soldCount7d: z.number().optional(),
  soldCount30d: z.number().optional(),
  avgDaysToSell: z.number().optional(),
  playerTrendScore: z.number().optional(),
  rankingTrend: z.enum(['up', 'flat', 'down']).optional(),
  injuryFlag: z.boolean().optional(),
  callupFlag: z.boolean().optional(),
  roleRiskFlag: z.boolean().optional(),
  marketIndexTrend: z.number().optional(),
  prospectSegmentTrend: z.number().optional(),
  flagshipSegmentTrend: z.number().optional(),
  volatilityIndex: z.number().optional(),
  scarcityScore: z.number().optional(),
  gemRateScore: z.number().optional(),
});

export const EstimateRequestSchema = z.object({
  subject: CardSubjectSchema,
  comps: z.array(CompInputSchema),
  context: MarketContextSchema,
  debug: z.boolean().optional(),
});


