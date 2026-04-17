-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Portfolio" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Portfolio_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PortfolioCard" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "portfolioId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "player" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "brand" TEXT NOT NULL,
    "setName" TEXT NOT NULL,
    "cardNumber" TEXT,
    "parallel" TEXT NOT NULL,
    "serialNumber" TEXT,
    "printRun" INTEGER,
    "isAuto" BOOLEAN NOT NULL,
    "gradeCompany" TEXT,
    "gradeValue" INTEGER,
    "purchasePrice" REAL NOT NULL,
    "purchaseDate" DATETIME NOT NULL,
    "quantity" INTEGER NOT NULL,
    "source" TEXT,
    "notes" TEXT,
    "imageUrl" TEXT,
    "currentEstimatedValue" REAL NOT NULL,
    "riskAdjustedValue" REAL,
    "quickExitValue" REAL,
    "gainLossDollar" REAL NOT NULL,
    "gainLossPercent" REAL NOT NULL,
    "currentRecommendation" TEXT NOT NULL,
    "currentConfidenceScore" INTEGER NOT NULL,
    "currentUrgencyScore" INTEGER,
    "currentDecisionScore" INTEGER,
    "liquidityScore" INTEGER,
    "negativePressureScore" INTEGER,
    "marketMomentumScore" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PortfolioCard_portfolioId_fkey" FOREIGN KEY ("portfolioId") REFERENCES "Portfolio" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PortfolioCard_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PortfolioSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "portfolioId" TEXT NOT NULL,
    "snapshotDate" DATETIME NOT NULL,
    "totalValue" REAL NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PortfolioSnapshot_portfolioId_fkey" FOREIGN KEY ("portfolioId") REFERENCES "Portfolio" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WatchlistItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "player" TEXT NOT NULL,
    "set" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "cardNumber" TEXT NOT NULL,
    "parallel" TEXT,
    "targetBuyPrice" REAL,
    "targetSellPrice" REAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WatchlistItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CardAnalysisSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "cardId" TEXT NOT NULL,
    "analysisDate" DATETIME NOT NULL,
    "recommendation" TEXT NOT NULL,
    "confidenceScore" INTEGER NOT NULL,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CardAnalysisSnapshot_cardId_fkey" FOREIGN KEY ("cardId") REFERENCES "PortfolioCard" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Alert" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "cardId" TEXT,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "isDismissed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Alert_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Alert_userId_isRead_isDismissed_idx" ON "Alert"("userId", "isRead", "isDismissed");

-- CreateIndex
CREATE INDEX "Alert_cardId_idx" ON "Alert"("cardId");
