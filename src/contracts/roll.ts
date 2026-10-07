import type { IsoDate } from "../domain/dates.ts";
import type { Money4 } from "../domain/money.ts";
import type { RollMetrics } from "../domain/roll.ts";
import type { LifecycleResponse } from "./lifecycle.ts";

export type { RollMetrics } from "../domain/roll.ts";

export interface RollRequest {
  positionId: string;
  expectedRevision: string;
  tradeDate?: string;
  expiry: string;
  fills: {
    legId: string;
    closePrice: string;
    closeFees?: string;
    strike: string;
    openPrice: string;
    openFees?: string;
  }[];
}

export interface RollInput {
  positionId: string;
  expectedRevision: string;
  tradeDate: IsoDate;
  expiry: IsoDate;
  fills: {
    legId: string;
    closePrice: Money4;
    closeFees: Money4;
    strike: Money4;
    openPrice: Money4;
    openFees: Money4;
  }[];
}

export interface RollResponse extends LifecycleResponse {
  rollId: string;
  rollChainId: string;
  newPositionId: string;
  metrics: RollMetrics;
}
