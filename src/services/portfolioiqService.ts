import { randomUUID } from "node:crypto";

import type {
    PortfolioIQHolding,
    PortfolioIQHoldingCreateInput,
    PortfolioIQHoldingsResponse,
    PortfolioIQPeriodSummary,
    PortfolioIQSaleInput,
    PortfolioIQSummaryResponse,
} from "../models/portfolioiq";

type PortfolioIQSale = {
    id: string;
    cardId: string;
    playerName: string;
    cardName: string;
    cost: number;
    salePrice: number;
    fees: number;
    profit: number;
    date: Date;
};

const currentYearMonth = (date: Date) => `${date.getFullYear()}-${date.getMonth()}`;

const normalizeStatus = (status: string | undefined): string => {
    const value = status?.trim().toLowerCase();
    return value || "active";
};

const isActiveHolding = (holding: PortfolioIQHolding): boolean => normalizeStatus(holding.status) === "active";

const round = (value: number, digits = 2): number => Number(value.toFixed(digits));

const sum = (values: number[]): number => round(values.reduce((total, value) => total + value, 0));

const computePeriodSummary = (sales: PortfolioIQSale[]): PortfolioIQPeriodSummary => {
    const totalSold = sum(sales.map((sale) => sale.salePrice));
    const totalProfit = sum(sales.map((sale) => sale.profit));

    return {
        totalSold,
        totalProfit,
        margin: totalSold === 0 ? 0 : round(totalProfit / totalSold, 4),
    };
};

const holdingsStore: PortfolioIQHolding[] = [
    {
        id: "1",
        playerName: "Roman Anthony",
        cardName: "2025 Bowman Chrome Blue Auto",
        cost: 500,
        currentValue: 655,
        status: "active",
    },
    {
        id: "2",
        playerName: "Caleb Bonemer",
        cardName: "2025 Bowman Chrome Refractor Auto",
        cost: 180,
        currentValue: 220,
        status: "active",
    },
    {
        id: "3",
        playerName: "Blake Burke",
        cardName: "2024 Bowman Chrome Purple Auto",
        cost: 110,
        currentValue: 138,
        status: "active",
    },
];

const salesStore: PortfolioIQSale[] = [];

const findHoldingIndex = (cardId: string): number => holdingsStore.findIndex((holding) => holding.id === cardId);

const upsertHolding = (input: PortfolioIQHoldingCreateInput): PortfolioIQHolding => {
    const holding: PortfolioIQHolding = {
        id: randomUUID(),
        playerName: input.playerName,
        cardName: input.cardName,
        cost: input.cost,
        currentValue: input.currentValue ?? input.cost,
        status: normalizeStatus(input.status),
    };

    const duplicateIndex = holdingsStore.findIndex(
        (existing) =>
            existing.playerName.trim().toLowerCase() === holding.playerName.trim().toLowerCase() &&
            existing.cardName.trim().toLowerCase() === holding.cardName.trim().toLowerCase()
    );

    if (duplicateIndex >= 0) {
        holdingsStore[duplicateIndex] = holding;
    } else {
        holdingsStore.push(holding);
    }

    return holding;
};

const filterSalesForMonth = (sales: PortfolioIQSale[], referenceDate: Date): PortfolioIQSale[] =>
    sales.filter((sale) => sale.date.getFullYear() === referenceDate.getFullYear() && sale.date.getMonth() === referenceDate.getMonth());

const filterSalesForYear = (sales: PortfolioIQSale[], referenceDate: Date): PortfolioIQSale[] =>
    sales.filter((sale) => sale.date.getFullYear() === referenceDate.getFullYear());

const toInventorySummary = (holdings: PortfolioIQHolding[]) => {
    const activeHoldings = holdings.filter(isActiveHolding);
    const totalCost = sum(activeHoldings.map((holding) => holding.cost));
    const totalCurrentValue = sum(activeHoldings.map((holding) => holding.currentValue));
    const totalProfitLoss = round(totalCurrentValue - totalCost);

    return {
        totalCost,
        totalCurrentValue,
        totalProfitLoss,
        roi: totalCost === 0 ? 0 : round(totalProfitLoss / totalCost, 4),
        activeCount: activeHoldings.length,
    };
};

export const portfolioIQService = {
    async getSummary(userId = "demo"): Promise<PortfolioIQSummaryResponse> {
        void userId;

        const inventory = toInventorySummary(holdingsStore);
        const now = new Date();
        const monthSales = filterSalesForMonth(salesStore, now);
        const yearSales = filterSalesForYear(salesStore, now);

        return {
            inventory,
            month: computePeriodSummary(monthSales),
            year: computePeriodSummary(yearSales),
        };
    },

    async getHoldings(userId = "demo"): Promise<PortfolioIQHoldingsResponse> {
        void userId;

        return {
            holdings: holdingsStore.filter(isActiveHolding),
        };
    },

    async createHolding(input: PortfolioIQHoldingCreateInput, userId = "demo") {
        void userId;

        const holding = upsertHolding(input);

        return {
            success: true as const,
            message: "Holding created",
            holding,
        };
    },

    async createHoldings(inputs: PortfolioIQHoldingCreateInput[], userId = "demo") {
        void userId;

        const holdings = inputs.map((input) => upsertHolding(input));

        return {
            success: true as const,
            message: "Holdings created",
            holdings,
        };
    },

    async repriceHoldings(userId = "demo") {
        void userId;

        return {
            success: true as const,
            holdings: holdingsStore.filter(isActiveHolding),
        };
    },

    async markAsSold(input: PortfolioIQSaleInput, userId = "demo") {
        void userId;

        const holdingIndex = findHoldingIndex(input.cardId);
        if (holdingIndex < 0) {
            throw new Error("Holding not found");
        }

        const existingHolding = holdingsStore[holdingIndex];
        const salePrice = input.salePrice;
        const fees = input.fees;
        const profit = round(salePrice - fees - existingHolding.cost);

        const soldHolding: PortfolioIQHolding = {
            ...existingHolding,
            currentValue: salePrice,
            status: "sold",
        };

        holdingsStore[holdingIndex] = soldHolding;

        salesStore.push({
            id: randomUUID(),
            cardId: input.cardId,
            playerName: existingHolding.playerName,
            cardName: existingHolding.cardName,
            cost: existingHolding.cost,
            salePrice,
            fees,
            profit,
            date: input.date,
        });

        return {
            success: true as const,
            message: "Sale recorded",
            holding: soldHolding,
        };
    },
};
