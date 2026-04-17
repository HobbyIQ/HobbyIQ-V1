import { PrismaClient, Recommendation, GradeCompany } from "@prisma/client";
import { CreatePortfolioInput, PortfolioDTO, AddPortfolioCardInput, PortfolioCardDTO, PortfolioSummary, RefreshPortfolioResult } from "./types";
import { buildPortfolioSummary } from "./summary";
import { runHobbyIQAnalysis } from "../engines/hobbyiq/service";
import { createAlertIfNotDuplicate } from "../alerts/service";

const prisma = new PrismaClient();

// Defensive helper
function safeNumber(val: any, fallback = 0) {
  return typeof val === 'number' && !isNaN(val) ? val : fallback;
}

export async function createPortfolio(input: CreatePortfolioInput): Promise<{ success: boolean; data?: PortfolioDTO; error?: string }> {
  if (!input.userId || !input.name) return { success: false, error: "Missing userId or name" };
  const portfolio = await prisma.portfolio.create({
    data: { userId: input.userId, name: input.name }
  });
  return { success: true, data: { ...portfolio, createdAt: portfolio.createdAt.toISOString(), updatedAt: portfolio.updatedAt.toISOString() } };
}

export async function getPortfolio(portfolioId: string): Promise<{ success: boolean; data?: PortfolioDTO; error?: string }> {
  if (!portfolioId) return { success: false, error: "Missing portfolioId" };
  const portfolio = await prisma.portfolio.findUnique({ where: { id: portfolioId } });
  if (!portfolio) return { success: false, error: "Portfolio not found" };
  return { success: true, data: { ...portfolio, createdAt: portfolio.createdAt.toISOString(), updatedAt: portfolio.updatedAt.toISOString() } };
}

export async function addPortfolioCard(userId: string, portfolioId: string, cardInput: AddPortfolioCardInput): Promise<{ success: boolean; data?: PortfolioCardDTO; error?: string }> {
  if (!userId || !portfolioId) return { success: false, error: "Missing userId or portfolioId" };
  if (!cardInput.player || !cardInput.year || !cardInput.brand || !cardInput.setName || !cardInput.parallel || !cardInput.purchasePrice || !cardInput.purchaseDate || !cardInput.quantity) {
    return { success: false, error: "Missing required card fields" };
  }
  const card = await prisma.portfolioCard.create({
    data: {
      ...cardInput,
      userId,
      portfolioId,
      currentEstimatedValue: safeNumber(cardInput.purchasePrice),
      gainLossDollar: 0,
      gainLossPercent: 0,
      currentRecommendation: Recommendation.HOLD,
      currentConfidenceScore: 50,
      createdAt: new Date(cardInput.purchaseDate),
      updatedAt: new Date()
    }
  });
  return {
    success: true,
    data: {
      ...card,
      cardNumber: card.cardNumber === null ? undefined : card.cardNumber,
      serialNumber: card.serialNumber === null ? undefined : card.serialNumber,
      printRun: card.printRun === null ? undefined : card.printRun,
      gradeCompany: card.gradeCompany === null ? undefined : card.gradeCompany,
      gradeValue: card.gradeValue === null ? undefined : card.gradeValue,
      source: card.source === null ? undefined : card.source,
      notes: card.notes === null ? undefined : card.notes,
      imageUrl: card.imageUrl === null ? undefined : card.imageUrl,
      riskAdjustedValue: card.riskAdjustedValue === null ? undefined : card.riskAdjustedValue,
      quickExitValue: card.quickExitValue === null ? undefined : card.quickExitValue,
      currentUrgencyScore: card.currentUrgencyScore === null ? undefined : card.currentUrgencyScore,
      currentDecisionScore: card.currentDecisionScore === null ? undefined : card.currentDecisionScore,
      liquidityScore: card.liquidityScore === null ? undefined : card.liquidityScore,
      negativePressureScore: card.negativePressureScore === null ? undefined : card.negativePressureScore,
      marketMomentumScore: card.marketMomentumScore === null ? undefined : card.marketMomentumScore,
      purchaseDate: card.purchaseDate instanceof Date ? card.purchaseDate.toISOString() : card.purchaseDate,
      createdAt: card.createdAt.toISOString(),
      updatedAt: card.updatedAt.toISOString()
    }
  };
}

export async function updatePortfolioCard(cardId: string, updates: Partial<AddPortfolioCardInput>): Promise<{ success: boolean; data?: PortfolioCardDTO; error?: string }> {
  if (!cardId) return { success: false, error: "Missing cardId" };
  const card = await prisma.portfolioCard.update({
    where: { id: cardId },
    data: { ...updates, updatedAt: new Date() }
  });
  return {
    success: true,
    data: {
      ...card,
      cardNumber: card.cardNumber === null ? undefined : card.cardNumber,
      serialNumber: card.serialNumber === null ? undefined : card.serialNumber,
      printRun: card.printRun === null ? undefined : card.printRun,
      gradeCompany: card.gradeCompany === null ? undefined : card.gradeCompany,
      gradeValue: card.gradeValue === null ? undefined : card.gradeValue,
      source: card.source === null ? undefined : card.source,
      notes: card.notes === null ? undefined : card.notes,
      imageUrl: card.imageUrl === null ? undefined : card.imageUrl,
      riskAdjustedValue: card.riskAdjustedValue === null ? undefined : card.riskAdjustedValue,
      quickExitValue: card.quickExitValue === null ? undefined : card.quickExitValue,
      currentUrgencyScore: card.currentUrgencyScore === null ? undefined : card.currentUrgencyScore,
      currentDecisionScore: card.currentDecisionScore === null ? undefined : card.currentDecisionScore,
      liquidityScore: card.liquidityScore === null ? undefined : card.liquidityScore,
      negativePressureScore: card.negativePressureScore === null ? undefined : card.negativePressureScore,
      marketMomentumScore: card.marketMomentumScore === null ? undefined : card.marketMomentumScore,
      purchaseDate: card.purchaseDate instanceof Date ? card.purchaseDate.toISOString() : card.purchaseDate,
      createdAt: card.createdAt.toISOString(),
      updatedAt: card.updatedAt.toISOString()
    }
  };
}

export async function deletePortfolioCard(cardId: string): Promise<{ success: boolean; error?: string }> {
  if (!cardId) return { success: false, error: "Missing cardId" };
  await prisma.portfolioCard.delete({ where: { id: cardId } });
  return { success: true };
}

export async function refreshPortfolio(portfolioId: string): Promise<RefreshPortfolioResult> {
  const cards = await prisma.portfolioCard.findMany({ where: { portfolioId } });
  const results: RefreshPortfolioResult["results"] = [];
  for (const card of cards) {
    try {
      // Call HobbyIQ analysis
      const analysis = await runHobbyIQAnalysis({
        player: card.player,
        cardDetails: card,
        costBasis: card.purchasePrice
      });
      // Update card fields
      await prisma.portfolioCard.update({
        where: { id: card.id },
        data: {
          currentEstimatedValue: safeNumber(analysis.pricingOutput?.fmv, card.currentEstimatedValue),
          riskAdjustedValue: safeNumber(analysis.sellOutput?.minimumAcceptableOffer),
          quickExitValue: safeNumber(analysis.sellOutput?.quickSalePrice),
          gainLossDollar: safeNumber(analysis.pricingOutput?.fmv, card.currentEstimatedValue) - card.purchasePrice,
          gainLossPercent: ((safeNumber(analysis.pricingOutput?.fmv, card.currentEstimatedValue) - card.purchasePrice) / card.purchasePrice) * 100,
          currentRecommendation: analysis.decisionOutput?.recommendation || Recommendation.HOLD,
          currentConfidenceScore: analysis.decisionOutput?.confidenceScore || 50,
          currentDecisionScore: analysis.decisionOutput?.decisionScore || 50,
          currentUrgencyScore: analysis.decisionOutput?.urgencyScore || 50,
          liquidityScore: analysis.sellOutput?.sellConfidence || 50,
          negativePressureScore: analysis.negativePressureOutput?.score || 0,
          marketMomentumScore: analysis.pricingOutput?.trend ? Math.round(analysis.pricingOutput.trend * 100) : 0,
          updatedAt: new Date()
        }
      });
      // Persist analysis snapshot
      await prisma.cardAnalysisSnapshot.create({
        data: {
          cardId: card.id,
          // Map analysis fields to correct CardAnalysisSnapshot fields as per your schema
          recommendation: analysis.decisionOutput?.recommendation || Recommendation.HOLD,
          confidenceScore: analysis.decisionOutput?.confidenceScore || 50,
          notes: analysis.decisionOutput?.notes || null,
          analysisDate: new Date(),
        }
      });
      // Evaluate alerts
      await createAlertIfNotDuplicate({
        userId: card.userId,
        portfolioId: card.portfolioId,
        portfolioCardId: card.id,
        alertType: "RECOMMENDATION_SHIFT",
        severity: "WARNING",
        title: `Recommendation changed for ${card.player}`,
        message: `New recommendation: ${analysis.decisionOutput?.recommendation}`,
        metadata: { prev: card.currentRecommendation, next: analysis.decisionOutput?.recommendation }
      });
      results.push({ cardId: card.id, success: true });
    } catch (err) {
      results.push({ cardId: card.id, success: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { success: true, results };
}

export async function getPortfolioSummary(portfolioId: string): Promise<{ success: boolean; data?: PortfolioSummary; error?: string }> {
  const cards = await prisma.portfolioCard.findMany({ where: { portfolioId } });
  const summary = buildPortfolioSummary(cards.map(card => ({
    ...card,
    cardNumber: card.cardNumber === null ? undefined : card.cardNumber,
    serialNumber: card.serialNumber === null ? undefined : card.serialNumber,
    printRun: card.printRun === null ? undefined : card.printRun,
    gradeCompany: card.gradeCompany === null ? undefined : card.gradeCompany,
    gradeValue: card.gradeValue === null ? undefined : card.gradeValue,
    source: card.source === null ? undefined : card.source,
    notes: card.notes === null ? undefined : card.notes,
    imageUrl: card.imageUrl === null ? undefined : card.imageUrl,
    riskAdjustedValue: card.riskAdjustedValue === null ? undefined : card.riskAdjustedValue,
    quickExitValue: card.quickExitValue === null ? undefined : card.quickExitValue,
    currentUrgencyScore: card.currentUrgencyScore === null ? undefined : card.currentUrgencyScore,
    currentDecisionScore: card.currentDecisionScore === null ? undefined : card.currentDecisionScore,
    liquidityScore: card.liquidityScore === null ? undefined : card.liquidityScore,
    negativePressureScore: card.negativePressureScore === null ? undefined : card.negativePressureScore,
    marketMomentumScore: card.marketMomentumScore === null ? undefined : card.marketMomentumScore,
    purchaseDate: card.purchaseDate instanceof Date ? card.purchaseDate.toISOString() : card.purchaseDate,
    createdAt: card.createdAt instanceof Date ? card.createdAt.toISOString() : card.createdAt,
    updatedAt: card.updatedAt instanceof Date ? card.updatedAt.toISOString() : card.updatedAt
  })));
  return { success: true, data: summary };
}
