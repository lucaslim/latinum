import type { IsoDate } from "./dates.ts";
import type { Money4 } from "./money.ts";
import type { TradeAction } from "./pnl.ts";
import type { DebitMetrics, Position } from "./positions.ts";
import type { CspScenarios } from "./scenarios.ts";

export type CampaignStrategy = Position["strategy"];
export type CampaignRole = Position["role"];

export interface CampaignTrade {
  id: string;
  action: TradeAction;
  tradeDate: IsoDate;
  quantity: number;
  price: Money4;
  cash: Money4;
  fees: Money4;
  rollId?: string | null;
}

export interface CampaignMark {
  asOf: IsoDate;
  price: Money4;
  source: "manual" | "feed";
}

export interface CampaignLeg {
  id: string;
  kind: "put" | "call" | "stock";
  side: "long" | "short";
  underlying: string;
  strike: Money4 | null;
  expiry: IsoDate | null;
  multiplier: number;
  adjusted: boolean;
  coveredLegId?: string | null;
  /** Ordered by tradeDate, createdAt, id; preserve order for same-day timeline events. */
  trades: CampaignTrade[];
  /** Latest mark on or before asOf; manual wins a same-day tie. */
  mark: CampaignMark | null;
}

export interface CampaignPosition {
  id: string;
  revision: string;
  rollChainId?: string | null;
  underlying: string;
  strategy: CampaignStrategy;
  role: CampaignRole;
  openedOn: IsoDate;
  closedOn: IsoDate | null;
  notes: string | null;
  tags: string[];
  legs: CampaignLeg[];
}

export interface CampaignAssignment {
  id: string;
  optionTradeId: string;
  stockTradeId: string;
  shares: number;
  premiumPerShare: Money4;
}

/** Recorded data only: GET /api/campaigns/:id includes open and historical positions. */
export interface CampaignResponse {
  id: string;
  title: string;
  openedOn: IsoDate;
  closedOn: IsoDate | null;
  notes: string | null;
  asOf: IsoDate;
  positions: CampaignPosition[];
  assignments: CampaignAssignment[];
  rolls?: { id: string; rollChainId: string; rolledOn: IsoDate }[];
}

/** PUT /api/legs/:id/mark. Decimal USD input avoids introducing floating-point parsing. */
export interface ManualMarkRequest {
  price: string;
  /** Defaults to todayNY on the server; future dates are rejected. */
  asOf?: string;
}
export interface ManualMarkResponse extends CampaignMark {
  legId: string;
  source: "manual";
}

export interface CoveredCallView {
  positionId: string;
  underlying: string;
  collateral: Money4;
  shares: number;
  basis: Money4;
  basisSource: "assignment" | "opening";
  adjustedBasis: Money4;
  premium: Money4;
  strike: Money4;
  calledAwayGain: Money4;
}

export interface HedgeView {
  positionId: string;
  underlying: string;
  metrics: DebitMetrics;
  /** Null for a long call's unlimited payout. */
  maxPayout: Money4 | null;
}

export interface SwingView {
  positionId: string;
  legId: string;
  underlying: string;
  kind: CampaignLeg["kind"];
  quantity: number;
  entry: Money4;
  /** Display-only wheel basis; entry and unrealized still use the cash purchase price. */
  assignmentBasis?: Money4;
  mark: CampaignMark | null;
  unrealized: Money4 | null;
}

export interface CampaignTimelineEvent {
  positionId: string;
  legId: string;
  underlying: string;
  kind: CampaignLeg["kind"];
  side: CampaignLeg["side"];
  trade: CampaignTrade;
  assignment: CampaignAssignment | null;
}

/** buildCampaignView in campaignMetrics.ts uses T3 math; closed legs are timeline-only. */
export interface CampaignView {
  csp: CspScenarios | null;
  coveredCalls: CoveredCallView[];
  hedges: HedgeView[];
  swings: SwingView[];
  timeline: CampaignTimelineEvent[];
  /** Valid stored strategies not covered by these T7 cards remain visible as recorded legs. */
  unsupportedPositionIds: string[];
}
