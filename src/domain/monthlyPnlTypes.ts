import type { IsoDate } from "./dates.ts";
import type { QuantityTrade } from "./lifecycleTypes.ts";
import type { Money4 } from "./money.ts";
import type { Position } from "./positions.ts";

export interface MonthlyPnlTrade extends QuantityTrade {
  rollId: string | null;
}

export interface MonthlyPnlLeg {
  legId: string;
  positionId: string;
  campaignId: string;
  underlying: string;
  strategy: Position["strategy"];
  trades: readonly MonthlyPnlTrade[];
}

export interface ClosedOutcome {
  id: string;
  positionId: string;
  campaignId: string;
  underlying: string;
  strategy: Position["strategy"];
  date: IsoDate;
  action: Exclude<QuantityTrade["action"], "open">;
  rollId: string | null;
  tradeIds: string[];
  pnl: Money4;
}

export interface MonthlyPnlStats {
  pnl: Money4;
  closed: number;
  wins: number;
  winRate: number | null;
  grossWins: Money4;
  grossLosses: Money4;
  profitFactor: number | null;
}

export interface StrategyPnl extends MonthlyPnlStats {
  strategy: Position["strategy"];
}

export interface MonthlyPnlMonth extends MonthlyPnlStats {
  month: string;
  cumulativePnl: Money4;
  trades: ClosedOutcome[];
  byStrategy: StrategyPnl[];
}

export interface MonthlyPnlResponse {
  months: MonthlyPnlMonth[];
}
