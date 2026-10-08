import type { IsoDate } from "../domain/dates.ts";
import type { RealizedAllocation } from "../domain/lifecycleTypes.ts";

export type { RealizedAllocation } from "../domain/lifecycleTypes.ts";

import type { Money4 } from "../domain/money.ts";

/** Decimal USD strings at the HTTP boundary; fees are zero or negative. */
export interface CloseRequest {
  expectedRevision: string;
  tradeDate?: string;
  fills: { legId: string; quantity: number; price: string; fees?: string }[];
}
export interface ExpireRequest {
  expectedRevision: string;
  tradeDate?: string;
}
export interface AssignRequest {
  expectedRevision: string;
  legId: string;
  tradeDate?: string;
  fees?: string;
}
export interface LinkHedgeRequest {
  expectedRevision: string;
  campaignId: string;
}
export interface CloseInput {
  expectedRevision: string;
  tradeDate: IsoDate;
  fills: { legId: string; quantity: number; price: Money4; fees: Money4 }[];
}
export interface ExpireInput {
  expectedRevision: string;
  tradeDate: IsoDate;
}
export interface AssignInput {
  expectedRevision: string;
  legId: string;
  tradeDate: IsoDate;
  fees: Money4;
}
export interface AssignmentResult {
  stockPositionId: string;
  stockLegId: string;
  stockTradeId: string;
  optionTradeId: string;
  shares: number;
  /** Gross premium-adjusted wheel basis; stock cash entry stays at the strike. */
  basis: Money4;
  premiumPerShare: Money4;
}
export interface LifecycleResponse {
  positionId: string;
  campaignId: string;
  closedOn: IsoDate | null;
  tradeIds: string[];
  realized: RealizedAllocation[];
  assignment?: AssignmentResult;
}
export interface LinkHedgeResponse {
  positionId: string;
  campaignId: string;
}
