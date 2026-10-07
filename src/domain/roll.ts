import type { CampaignResponse } from "./campaign.ts";
import { openLegQuantity } from "./campaignMetrics.ts";
import type { IsoDate } from "./dates.ts";
import { expiryChips } from "./expiry.ts";
import { allocateRealizedTrades } from "./lifecyclePnl.ts";
import type { QuantityTrade, RealizedAllocation } from "./lifecycleTypes.ts";
import { addMoney4, type Money4, mulMoney4, negMoney4, subMoney4, sumMoney4 } from "./money.ts";

interface CashEvent {
  cash: Money4;
  fees: Money4;
}
export interface RollMetrics {
  realizedGross: Money4;
  realizedNet: Money4;
  rollCashGross: Money4;
  rollCashNet: Money4;
  chainCashGross: Money4;
  chainCashNet: Money4;
}
export interface RollPreviewInput {
  positionId: string;
  tradeDate: IsoDate;
  expiry: IsoDate;
  fills: readonly {
    legId: string;
    closePrice: Money4;
    closeFees: Money4;
    strike: Money4;
    openPrice: Money4;
    openFees: Money4;
  }[];
}
function cashTotals(events: readonly CashEvent[]) {
  for (const event of events) {
    if (!Number.isSafeInteger(event.cash)) throw new RangeError("Unsafe cash amount");
    if (!Number.isSafeInteger(event.fees) || event.fees > 0)
      throw new RangeError("Fees must be safe integers, zero or negative");
  }
  return {
    gross: sumMoney4(events.map((event) => event.cash)),
    net: sumMoney4(events.map((event) => addMoney4(event.cash, event.fees))),
  };
}

/** Chain includes all historical and new events; realized includes only this roll's closes. */
export function rollMetrics(
  realized: readonly RealizedAllocation[],
  closing: readonly (CashEvent & { id: string })[],
  opening: readonly CashEvent[],
  chain: readonly CashEvent[],
): RollMetrics {
  const closes = new Map<string, CashEvent>();
  for (const close of closing) {
    if (closes.has(close.id)) throw new RangeError(`Duplicate closing trade: ${close.id}`);
    closes.set(close.id, close);
  }
  const rollCash = cashTotals([...closing, ...opening]);
  const chainCash = cashTotals(chain);
  return {
    realizedGross: sumMoney4(
      realized.map((allocation) => {
        const close = closes.get(allocation.tradeId);
        if (!close) throw new RangeError(`Missing closing trade: ${allocation.tradeId}`);
        return subMoney4(subMoney4(allocation.pnl, allocation.openingFees), close.fees);
      }),
    ),
    realizedNet: sumMoney4(realized.map((allocation) => allocation.pnl)),
    rollCashGross: rollCash.gross,
    rollCashNet: rollCash.net,
    chainCashGross: chainCash.gross,
    chainCashNet: chainCash.net,
  };
}

const MAX_PRICE = 999_999_999_999;
const MAX_CASH = 99_999_999_999_999;
const MAX_QUANTITY = 2_147_483_647;

function storedMoney(value: Money4, minimum: number, maximum: number, name: string): Money4 {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new RangeError(`${name} exceeds numeric storage precision or sign bounds`);
  return value;
}

function fillCash(price: Money4, quantity: number, multiplier: number): Money4 {
  if (
    !Number.isSafeInteger(quantity) ||
    quantity <= 0 ||
    quantity > MAX_QUANTITY ||
    !Number.isSafeInteger(multiplier) ||
    multiplier <= 0 ||
    multiplier > MAX_QUANTITY ||
    !Number.isSafeInteger(quantity * multiplier)
  )
    throw new RangeError("Quantity or multiplier exceeds integer storage bounds");
  return storedMoney(mulMoney4(price, quantity * multiplier), 0, MAX_CASH, "Cash");
}

/** Repository owns strategy eligibility; preview requires every open option leg, never held stock. */
export function previewRoll(campaign: CampaignResponse, input: RollPreviewInput): RollMetrics {
  const position = campaign.positions.find((candidate) => candidate.id === input.positionId);
  if (!position) throw new RangeError("Position not found");
  const options = position.legs
    .filter((leg) => leg.kind !== "stock")
    .map((leg) => ({ leg, quantity: openLegQuantity(leg) }))
    .filter(({ quantity }) => quantity > 0);
  if (options.length === 0) throw new RangeError("No open option quantity");

  const fills = new Map<string, RollPreviewInput["fills"][number]>();
  for (const fill of input.fills) {
    if (fills.has(fill.legId)) throw new RangeError(`Duplicate leg: ${fill.legId}`);
    if (!options.some(({ leg }) => leg.id === fill.legId))
      throw new RangeError(`Foreign or closed option leg: ${fill.legId}`);
    fills.set(fill.legId, fill);
  }
  if (fills.size !== options.length) throw new RangeError("Every open option leg requires a fill");

  const closing: (CashEvent & { id: string })[] = [];
  const opening: CashEvent[] = [];
  const realized: RealizedAllocation[] = [];
  for (const { leg, quantity } of options) {
    const fill = fills.get(leg.id);
    if (!fill) throw new RangeError("Every open option leg requires a fill");
    if (
      input.tradeDate < position.openedOn ||
      leg.trades.some((trade) => trade.tradeDate > input.tradeDate)
    )
      throw new RangeError("Trade date cannot precede source history");
    if (leg.expiry === null || input.expiry <= leg.expiry || input.expiry <= input.tradeDate)
      throw new RangeError("Expiry must be after the source expiry and trade date");
    storedMoney(fill.strike, 1, MAX_PRICE, "Strike");
    storedMoney(fill.closePrice, 0, MAX_PRICE, "Price");
    storedMoney(fill.openPrice, 0, MAX_PRICE, "Price");
    storedMoney(fill.closeFees, -MAX_CASH, 0, "Fees");
    storedMoney(fill.openFees, -MAX_CASH, 0, "Fees");
    const closeCash = fillCash(fill.closePrice, quantity, leg.multiplier);
    const openCash = fillCash(fill.openPrice, quantity, leg.multiplier);
    // Stored trade IDs are UUIDs; this local ID cannot collide with source events.
    const close: QuantityTrade = {
      id: `preview:${leg.id}`,
      action: "close",
      date: input.tradeDate,
      quantity,
      cash: leg.side === "short" ? negMoney4(closeCash) : closeCash,
      fees: fill.closeFees,
    };
    const allocations = allocateRealizedTrades([
      ...leg.trades.map((trade) => ({
        id: trade.id,
        action: trade.action,
        date: trade.tradeDate,
        quantity: trade.quantity,
        cash: trade.cash,
        fees: trade.fees,
      })),
      close,
    ]);
    const allocation = allocations.at(-1);
    if (!allocation || allocation.tradeId !== close.id)
      throw new RangeError("Missing closing trade allocation");
    realized.push(allocation);
    closing.push(close);
    opening.push({
      cash: leg.side === "short" ? openCash : negMoney4(openCash),
      fees: fill.openFees,
    });
  }
  const chainPositions = campaign.positions.filter((candidate) =>
    position.rollChainId == null
      ? candidate.id === position.id
      : candidate.rollChainId === position.rollChainId,
  );
  const history = chainPositions.flatMap((candidate) =>
    candidate.legs.filter((leg) => leg.kind !== "stock").flatMap((leg) => leg.trades),
  );
  return rollMetrics(realized, closing, opening, [...history, ...closing, ...opening]);
}

export function rollExpiryChips(currentExpiry: IsoDate): { date: IsoDate; monthly: boolean }[] {
  return expiryChips(currentExpiry).slice(0, 6);
}
