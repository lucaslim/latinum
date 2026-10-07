import type {
  CampaignLeg,
  CampaignPosition,
  CampaignResponse,
  CampaignTimelineEvent,
  CampaignView,
} from "./campaign.ts";
import type { IsoDate } from "./dates.ts";
import { addMoney4, divMoney4, type Money4, mulMoney4, subMoney4, sumMoney4 } from "./money.ts";
import {
  type CashSecuredPut,
  type DebitMetrics,
  type DebitSpread,
  type LongOption,
  positionMetrics,
  spreadMaxPayout,
} from "./positions.ts";
import { type CspScenarios, cspScenarios } from "./scenarios.ts";
import { adjustedBasis, assignedShareBasis, calledAwayGain } from "./wheel.ts";

interface OpenLeg {
  leg: CampaignLeg;
  quantity: number;
  entry: Money4;
}

type OpenOption = OpenLeg & {
  leg: CampaignLeg & { kind: "put" | "call"; strike: Money4; expiry: IsoDate };
};

export function openLegQuantity(leg: CampaignLeg): number {
  return leg.trades.reduce(
    (quantity, trade) => quantity + (trade.action === "open" ? trade.quantity : -trade.quantity),
    0,
  );
}

function openingEntry(leg: CampaignLeg, campaign?: CampaignResponse): Money4 {
  const openings = leg.trades.filter((trade) => trade.action === "open");
  const total = sumMoney4(
    openings.map((trade) => {
      const assignment = campaign?.assignments.find((a) => a.stockTradeId === trade.id);
      const price = assignment
        ? assignedShareBasis(trade.price, assignment.premiumPerShare)
        : trade.price;
      return mulMoney4(price, trade.quantity);
    }),
  );
  return divMoney4(
    total,
    openings.reduce((quantity, trade) => quantity + trade.quantity, 0),
  );
}

function isOption(open: OpenLeg): open is OpenOption {
  return open.leg.kind !== "stock" && open.leg.strike !== null && open.leg.expiry !== null;
}

// T3 uses 100-share contracts. Integer deliverable units avoid fractional-contract float drift;
// normalize total cash back by 100, leaving per-share prices and dimensionless ratios unchanged.
const cashUnits = (amount: Money4): Money4 => divMoney4(amount, 100);

function optionFields(position: CampaignPosition, open: OpenOption) {
  return {
    underlying: open.leg.underlying,
    qty: open.quantity * open.leg.multiplier,
    price: open.entry,
    openedOn: position.openedOn,
    expiry: open.leg.expiry,
    adjusted: open.leg.adjusted,
  };
}

function hedgeMetrics(hedge: DebitSpread | LongOption, quantity: number): DebitMetrics {
  const metrics = positionMetrics(hedge);
  return {
    ...metrics,
    contracts: quantity,
    debit: cashUnits(metrics.debit),
    collateral: cashUnits(metrics.collateral),
    maxProfit: metrics.maxProfit === "unlimited" ? "unlimited" : cashUnits(metrics.maxProfit),
    maxLoss: cashUnits(metrics.maxLoss),
  };
}

function campaignScenarios(
  puts: [CashSecuredPut, ...CashSecuredPut[]],
  hedges: DebitSpread[],
): CspScenarios {
  const scenarios = cspScenarios({ puts, hedges });
  return {
    ...scenarios,
    premium: cashUnits(scenarios.premium),
    capital: cashUnits(scenarios.capital),
    hedgeDebit: cashUnits(scenarios.hedgeDebit),
    hedgePayout: cashUnits(scenarios.hedgePayout),
    noAssignment: {
      ...scenarios.noAssignment,
      netProfit: cashUnits(scenarios.noAssignment.netProfit),
    },
    assigned: {
      ...scenarios.assigned,
      cash: cashUnits(scenarios.assigned.cash),
      shares: scenarios.assigned.shares / 100,
    },
  };
}

function recordedTimeline(campaign: CampaignResponse): CampaignTimelineEvent[] {
  return campaign.positions
    .flatMap((position) =>
      position.legs.flatMap((leg) =>
        leg.trades.map((trade) => ({
          positionId: position.id,
          legId: leg.id,
          underlying: leg.underlying,
          kind: leg.kind,
          side: leg.side,
          trade,
          assignment:
            campaign.assignments.find(
              (a) => a.optionTradeId === trade.id || a.stockTradeId === trade.id,
            ) ?? null,
        })),
      ),
    )
    .sort((a, b) => a.trade.tradeDate.localeCompare(b.trade.tradeDate));
}

/**
 * Derive campaign scenarios, covered calls, hedges, residual swings and recorded history.
 * Reserve stock for both held and referenced calls without double-counting capital,
 * and collect unsupported position identifiers for the caller to display.
 */
export function buildCampaignView(campaign: CampaignResponse): CampaignView {
  const view: CampaignView = {
    csp: null,
    coveredCalls: [],
    hedges: [],
    swings: [],
    timeline: recordedTimeline(campaign),
    unsupportedPositionIds: [],
  };
  const positions = campaign.positions
    .filter((position) => position.closedOn === null)
    .map((position) => ({
      position,
      open: position.legs
        .map((leg) => ({ leg, quantity: openLegQuantity(leg) }))
        .filter(({ quantity }) => quantity > 0)
        .map(({ leg, quantity }) => ({ leg, quantity, entry: openingEntry(leg) })),
    }));
  const stock = positions
    .flatMap(({ open }) => open)
    .filter(({ leg }) => leg.kind === "stock" && leg.side === "long");
  const openCalls = positions
    .filter(({ position }) => position.strategy === "cc" && position.role === "income")
    .flatMap(({ open }) => open)
    .filter((o): o is OpenOption => isOption(o) && o.leg.kind === "call" && o.leg.side === "short");
  const backingByCall = new Map<string, OpenLeg>();
  const reserved = new Map<string, number>();
  for (const { position, open } of positions) {
    if (position.strategy !== "cc" || position.role !== "income") continue;
    const options = open.filter(({ leg }) => leg.kind !== "stock");
    const [call] = options;
    if (
      options.length !== 1 ||
      !call ||
      !isOption(call) ||
      call.leg.kind !== "call" ||
      call.leg.side !== "short"
    )
      continue;
    const held = open.filter(({ leg }) => leg.kind === "stock" && leg.side === "long");
    const candidates =
      call.leg.coveredLegId != null
        ? stock.filter(({ leg }) => leg.id === call.leg.coveredLegId)
        : held.length > 0 || call.leg.coveredLegId === null
          ? held
          : stock.filter(({ leg }) => leg.underlying === position.underlying);
    const [backing] = candidates;
    const shares = call.quantity * call.leg.multiplier;
    // Only legacy DTOs may infer a campaign-wide link, and never between ambiguous lots.
    if (candidates.length !== 1 || !backing || backing.quantity * backing.leg.multiplier < shares)
      continue;
    backingByCall.set(call.leg.id, backing);
    reserved.set(backing.leg.id, (reserved.get(backing.leg.id) ?? 0) + shares);
  }
  const puts: CashSecuredPut[] = [];
  const hedges: DebitSpread[] = [];

  for (const { position, open } of positions) {
    if (open.length === 0) continue;
    const [first] = open;
    if (!first) continue;
    if (
      position.strategy === "csp" &&
      position.role === "income" &&
      open.length === 1 &&
      isOption(first) &&
      first.leg.kind === "put" &&
      first.leg.side === "short"
    ) {
      puts.push({
        ...optionFields(position, first),
        strategy: "csp",
        role: "income",
        strike: first.leg.strike,
      });
      continue;
    }

    if (position.strategy === "cc" && position.role === "income") {
      const options = open.filter(({ leg }) => leg.kind !== "stock");
      const [call] = options;
      if (options.length === 0) continue;
      const backing = call ? backingByCall.get(call.leg.id) : undefined;
      if (
        options.length === 1 &&
        call &&
        isOption(call) &&
        call.leg.kind === "call" &&
        call.leg.side === "short" &&
        backing
      ) {
        const backingCalls = openCalls.filter(
          (c) => backingByCall.get(c.leg.id)?.leg.id === backing.leg.id,
        );
        const coveredShares = backingCalls.reduce(
          (shares, c) => shares + c.quantity * c.leg.multiplier,
          0,
        );
        const basis = openingEntry(backing.leg, campaign);
        const premium = mulMoney4(call.entry, call.quantity * call.leg.multiplier);
        const allPremium = sumMoney4(
          backingCalls.map((c) => mulMoney4(c.entry, c.quantity * c.leg.multiplier)),
        );
        const shares = call.quantity * call.leg.multiplier;
        const assigned = backing.leg.trades.some((t) =>
          campaign.assignments.some((a) => a.stockTradeId === t.id),
        );
        view.coveredCalls.push({
          positionId: position.id,
          underlying: position.underlying,
          collateral: mulMoney4(call.leg.strike, shares),
          shares,
          basis,
          basisSource: assigned ? "assignment" : "opening",
          adjustedBasis: adjustedBasis(basis, [divMoney4(allPremium, coveredShares)]),
          premium,
          strike: call.leg.strike,
          calledAwayGain: calledAwayGain({
            strike: call.leg.strike,
            basis,
            shares,
            callPremium: premium,
          }),
        });
        continue;
      }
    }

    if (
      (position.strategy === "put_debit_spread" || position.strategy === "call_debit_spread") &&
      position.role === "hedge" &&
      open.length === 2
    ) {
      const long = open.find(({ leg }) => leg.side === "long");
      const short = open.find(({ leg }) => leg.side === "short");
      const kind = position.strategy === "put_debit_spread" ? "put" : "call";
      if (
        long &&
        short &&
        isOption(long) &&
        isOption(short) &&
        long.leg.kind === kind &&
        short.leg.kind === kind &&
        long.leg.underlying === short.leg.underlying &&
        long.leg.expiry === short.leg.expiry &&
        long.quantity === short.quantity &&
        long.leg.multiplier === short.leg.multiplier &&
        long.entry > short.entry &&
        (kind === "put" ? long.leg.strike > short.leg.strike : long.leg.strike < short.leg.strike)
      ) {
        const hedge: DebitSpread = {
          ...optionFields(position, long),
          strategy: position.strategy,
          role: "hedge",
          price: subMoney4(long.entry, short.entry),
          longStrike: long.leg.strike,
          shortStrike: short.leg.strike,
          adjusted: long.leg.adjusted || short.leg.adjusted,
        };
        hedges.push(hedge);
        view.hedges.push({
          positionId: position.id,
          underlying: position.underlying,
          metrics: hedgeMetrics(hedge, long.quantity),
          maxPayout: cashUnits(spreadMaxPayout(hedge)),
        });
        continue;
      }
    }

    if (
      (position.strategy === "long_call" || position.strategy === "long_put") &&
      open.length === 1 &&
      isOption(first) &&
      first.leg.side === "long" &&
      first.leg.kind === (position.strategy === "long_call" ? "call" : "put")
    ) {
      if (position.role === "hedge" && first.entry > 0) {
        const hedge: LongOption = {
          ...optionFields(position, first),
          strategy: position.strategy,
          role: "hedge",
          strike: first.leg.strike,
        };
        const metrics = hedgeMetrics(hedge, first.quantity);
        view.hedges.push({
          positionId: position.id,
          underlying: position.underlying,
          metrics,
          maxPayout:
            metrics.maxProfit === "unlimited" ? null : addMoney4(metrics.maxProfit, metrics.debit),
        });
        continue;
      }
      if (position.role === "swing") {
        view.swings.push(swingView(position, first, campaign));
        continue;
      }
    }

    if (
      position.strategy === "stock" &&
      position.role === "swing" &&
      open.length === 1 &&
      first.leg.kind === "stock" &&
      first.leg.side === "long"
    ) {
      continue;
    }
    view.unsupportedPositionIds.push(position.id);
  }
  for (const { position, open } of positions) {
    if (
      !(
        (position.strategy === "stock" && position.role === "swing" && open.length === 1) ||
        (position.strategy === "cc" && position.role === "income")
      )
    )
      continue;
    for (const shares of open.filter(({ leg }) => leg.kind === "stock" && leg.side === "long")) {
      const quantity = shares.quantity - (reserved.get(shares.leg.id) ?? 0) / shares.leg.multiplier;
      if (quantity > 0) view.swings.push(swingView(position, { ...shares, quantity }, campaign));
    }
  }
  const [firstPut, ...otherPuts] = puts;
  if (firstPut) view.csp = campaignScenarios([firstPut, ...otherPuts], hedges);
  return view;
}

/** Value remaining swing quantity at its mark, keeping assignment display basis separate from P/L cost. */
function swingView(
  position: CampaignPosition,
  open: OpenLeg,
  campaign: CampaignResponse,
): CampaignView["swings"][number] {
  let unrealized: Money4 | null = null;
  if (open.leg.mark !== null) {
    const openings = open.leg.trades.filter((trade) => trade.action === "open");
    const openingQuantity = openings.reduce((quantity, trade) => quantity + trade.quantity, 0);
    const openingCost = sumMoney4(
      openings.map((trade) => mulMoney4(trade.price, trade.quantity * open.leg.multiplier)),
    );
    // Apportion exact cash, not the rounded per-share entry shown on the card.
    const remainingCost = divMoney4(mulMoney4(openingCost, open.quantity), openingQuantity);
    const markedValue = mulMoney4(open.leg.mark.price, open.quantity * open.leg.multiplier);
    unrealized = subMoney4(markedValue, remainingCost);
  }
  return {
    positionId: position.id,
    legId: open.leg.id,
    underlying: open.leg.underlying,
    kind: open.leg.kind,
    quantity: open.quantity,
    entry: open.entry,
    ...(open.leg.kind === "stock" &&
    open.leg.trades.some((t) => campaign.assignments.some((a) => a.stockTradeId === t.id))
      ? { assignmentBasis: openingEntry(open.leg, campaign) }
      : {}),
    mark: open.leg.mark,
    unrealized,
  };
}
