export interface PortfolioLot {
  lotId: string;
  positionId: string;
  acquiredAt?: string | null;
  quantity: number;
  unitCost: number | null;
  notes?: string | null;
  createdAt: string;
  updatedAt: string;
}
