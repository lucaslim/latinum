import type { IsoDate } from "./dates.ts";
import type { Position } from "./positions.ts";

/** One open Sheet row: the position's domain shape plus its stored id. */
export type OpenPosition = Position & { id: string; campaignId: string };

/** `GET /api/positions?status=open`. `asOf` is today in New York, so DTE needs no client clock. */
export interface OpenPositionsResponse {
  asOf: IsoDate;
  positions: OpenPosition[];
}

export const SHEET_FILTERS = ["all", "income", "hedges", "swings"] as const;
export type SheetFilter = (typeof SHEET_FILTERS)[number];

const ROLE_OF_FILTER = { income: "income", hedges: "hedge", swings: "swing" } as const;

export function filterPositions<P extends Position>(
  positions: readonly P[],
  filter: SheetFilter,
): P[] {
  return filter === "all"
    ? [...positions]
    : positions.filter((p) => p.role === ROLE_OF_FILTER[filter]);
}

/** Soonest expiry first; ties and stock keep their book order. */
export function sortByExpiry<P extends Position>(positions: readonly P[]): P[] {
  const expiry = (p: Position) => ("expiry" in p ? p.expiry : "9999-12-31");
  return [...positions].sort((a, b) => expiry(a).localeCompare(expiry(b)));
}
