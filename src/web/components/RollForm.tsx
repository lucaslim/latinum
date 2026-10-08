import { useEffect, useRef, useState } from "react";
import type { RollInput, RollRequest } from "../../contracts/roll.ts";
import { rollSchema } from "../../contracts/rollSchemas.ts";
import { CalendarCoverageError } from "../../domain/calendar.ts";
import type { CampaignLeg, CampaignPosition, CampaignResponse } from "../../domain/campaign.ts";
import { buildCampaignView, openLegQuantity } from "../../domain/campaignMetrics.ts";
import { dte, term } from "../../domain/dates.ts";
import { divMoney4, formatMoney4, type Money4, negMoney4 } from "../../domain/money.ts";
import { type Metrics, positionMetrics, spreadMaxPayout } from "../../domain/positions.ts";
import { previewRoll, rollExpiryChips } from "../../domain/roll.ts";
import { createPositionSchema } from "../../shared/trade.ts";
import { requestToPosition } from "../../shared/tradePosition.ts";
import { defaultFeeInput, feeToApi } from "../fees.ts";
import { percent, shortDate, usd } from "../format.ts";
import type { SaveLifecycle } from "../lifecycleApi.ts";
import "./roll.css";

const openOptions = (position: CampaignPosition) =>
  position.legs.filter((leg) => leg.kind !== "stock" && openLegQuantity(leg) > 0);
const legLabel = (leg: CampaignLeg) =>
  `${leg.underlying} ${leg.side} ${leg.kind} ${leg.strike === null ? "" : formatMoney4(leg.strike, 2)}`;
const positionLabel = (position: CampaignPosition) =>
  `${position.underlying} ${position.strategy} · ${openOptions(position)
    .map((leg) => (leg.strike === null ? "—" : formatMoney4(leg.strike, 2)))
    .join("/")} · ${openOptions(position)[0]?.expiry}`;
const signed = (amount: Money4) => `${amount >= 0 ? "+" : ""}${usd(amount, 2)}`;

interface FillFields {
  legId: string;
  closePrice: string;
  closeFees: string;
  strike: string;
  openPrice: string;
  openFees: string;
}

function initialFills(position: CampaignPosition): FillFields[] {
  return openOptions(position).map((leg) => {
    const entry = leg.trades.findLast((trade) => trade.action === "open")?.price;
    if (entry === undefined || leg.strike === null)
      throw new Error("Option has no opening price or strike");
    const fee = defaultFeeInput(leg.kind, openLegQuantity(leg));
    return {
      legId: leg.id,
      closePrice: formatMoney4(leg.mark?.price ?? entry),
      closeFees: fee,
      strike: formatMoney4(leg.strike),
      openPrice: formatMoney4(entry),
      openFees: fee,
    };
  });
}

function newMetrics(
  campaign: CampaignResponse,
  position: CampaignPosition,
  input: RollInput,
): { metrics: Metrics; payout?: Money4 } {
  const legs = openOptions(position);
  const first = legs[0];
  if (!first) throw new Error("Missing open option");
  const base = {
    strategy: position.strategy,
    underlying: position.underlying,
    openedOn: input.tradeDate,
    expiry: input.expiry,
    quantity: openLegQuantity(first),
    adjusted: legs.some((leg) => leg.adjusted),
    tags: position.tags,
  };
  const fillFor = (side: CampaignLeg["side"]) => {
    const fill = input.fills.find(
      (fill) => legs.find((leg) => leg.id === fill.legId)?.side === side,
    );
    if (!fill) throw new Error("Missing replacement fill");
    return {
      strike: formatMoney4(fill.strike),
      price: formatMoney4(fill.openPrice),
      fees: formatMoney4(negMoney4(fill.openFees)),
    };
  };
  const basis =
    position.strategy === "cc"
      ? buildCampaignView(campaign).coveredCalls.find((cc) => cc.positionId === position.id)?.basis
      : undefined;
  const cover = basis === undefined ? undefined : { kind: "held", basis: formatMoney4(basis) };
  if (position.strategy === "cc" && cover === undefined)
    throw new RangeError("Covered call backing shares are unavailable");
  const candidate = position.strategy.endsWith("_spread")
    ? {
        ...base,
        short: fillFor("short"),
        long: fillFor("long"),
        ...(position.role === "income" ? {} : { role: position.role }),
      }
    : {
        ...base,
        ...fillFor(first.side),
        ...(position.strategy === "cc"
          ? { cover }
          : position.role === "income"
            ? {}
            : { role: position.role }),
      };
  const parsed = createPositionSchema.safeParse(candidate);
  if (!parsed.success)
    throw new RangeError(parsed.error.issues.map((issue) => issue.message).join("; "));
  const next = requestToPosition(parsed.data);
  if ("shares" in next) throw new Error("Stock cannot roll");
  const quantity = openLegQuantity(first);
  // T3 assumes 100-share contracts: evaluate integer deliverable units, then normalize cash.
  const scaled = { ...next, qty: quantity * first.multiplier };
  const metrics = positionMetrics(scaled);
  if (metrics.kind === "stock") throw new Error("Stock cannot roll");
  const cash = (value: Money4) => divMoney4(value, 100);
  return {
    metrics:
      metrics.kind === "income"
        ? {
            ...metrics,
            contracts: quantity,
            premium: cash(metrics.premium),
            collateral: cash(metrics.collateral),
            maxProfit: cash(metrics.maxProfit),
            maxLoss: cash(metrics.maxLoss),
          }
        : {
            ...metrics,
            contracts: quantity,
            debit: cash(metrics.debit),
            collateral: cash(metrics.collateral),
            maxProfit: metrics.maxProfit === "unlimited" ? "unlimited" : cash(metrics.maxProfit),
            maxLoss: cash(metrics.maxLoss),
          },
    ...(scaled.strategy === "put_debit_spread" || scaled.strategy === "call_debit_spread"
      ? { payout: cash(spreadMaxPayout(scaled)) }
      : {}),
  };
}

export function RollForm({
  campaign,
  onSave,
}: {
  campaign: CampaignResponse;
  onSave: SaveLifecycle;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const save: SaveLifecycle = async (positionId, mutation) => {
    setPending(true);
    try {
      return await onSave(positionId, mutation);
    } finally {
      if (mounted.current) setPending(false);
    }
  };
  const candidates = campaign.positions.filter(
    (position) => position.closedOn === null && openOptions(position).length > 0,
  );
  if (candidates.length === 0) return null;
  const selected = candidates.find((position) => position.id === selectedId);
  const defaultId = candidates[0]?.id ?? null;
  return (
    <section className="campaign-panel roll-panel" aria-label="Roll options">
      <button
        type="button"
        disabled={pending}
        onClick={() => setSelectedId(selected?.id ?? defaultId)}
      >
        Roll options
      </button>
      {selectedId !== null && selected && (
        <>
          {candidates.length > 1 && (
            <fieldset className="roll-choices" aria-label="Position to roll" disabled={pending}>
              <legend>Position to roll</legend>
              {candidates.map((position) => (
                <button
                  type="button"
                  key={position.id}
                  aria-pressed={selected.id === position.id}
                  onClick={() => setSelectedId(position.id)}
                >
                  {positionLabel(position)}
                </button>
              ))}
            </fieldset>
          )}
          <RollEditor
            key={`${selected.id}:${selected.revision}`}
            campaign={campaign}
            position={selected}
            onSave={save}
            onCancel={() => setSelectedId(null)}
          />
        </>
      )}
    </section>
  );
}

function RollEditor({
  campaign,
  position,
  onSave,
  onCancel,
}: {
  campaign: CampaignResponse;
  position: CampaignPosition;
  onSave: SaveLifecycle;
  onCancel: () => void;
}) {
  const options = openOptions(position);
  const currentExpiry = options[0]?.expiry;
  if (!currentExpiry) throw new Error("Open option has no expiry");
  let chips: ReturnType<typeof rollExpiryChips> = [];
  let calendarError = false;
  try {
    chips = rollExpiryChips(currentExpiry);
  } catch (error) {
    if (!(error instanceof CalendarCoverageError)) throw error;
    calendarError = true;
  }
  const [fills, setFills] = useState(() => initialFills(position));
  const [expiry, setExpiry] = useState<string>(chips[1]?.date ?? "");
  const [tradeDate, setTradeDate] = useState<string>(campaign.asOf);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  let request: RollRequest | null = null;
  let lines: [string, string][] = [];
  let invalid: string | null = null;
  try {
    const raw: RollRequest = {
      positionId: position.id,
      expectedRevision: position.revision,
      tradeDate,
      expiry,
      fills: fills.map((fill) => ({
        ...fill,
        closeFees: feeToApi(fill.closeFees),
        openFees: feeToApi(fill.openFees),
      })),
    };
    const input = rollSchema.parse(raw, campaign.asOf);
    const preview = previewRoll(campaign, input);
    const next = newMetrics(campaign, position, input);
    lines = [
      ["Closing realized gross", signed(preview.realizedGross)],
      ["Closing realized net", signed(preview.realizedNet)],
      ["Roll cash gross", signed(preview.rollCashGross)],
      ["Roll cash net", signed(preview.rollCashNet)],
      ["Chain cash gross", signed(preview.chainCashGross)],
      ["Chain cash net", signed(preview.chainCashNet)],
      ["Close books in", input.tradeDate.slice(0, 7)],
      ["Days added", String(term(currentExpiry, input.expiry))],
      ["New DTE", String(dte(input.expiry, input.tradeDate))],
    ];
    if (next) {
      const metrics = next.metrics;
      lines.push(["New collateral", usd(metrics.collateral, 2)]);
      if (metrics.kind === "income")
        lines.push(
          ["New leg yield", percent(metrics.yield, 2)],
          ["New annualized", percent(metrics.annualized, 1)],
          ["New breakeven", usd(metrics.breakeven, 2)],
        );
      if (metrics.kind === "debit") {
        if (next.payout !== undefined) lines.push(["New max payout", usd(next.payout, 2)]);
        lines.push(
          [
            "New max profit",
            metrics.maxProfit === "unlimited" ? "Unlimited" : usd(metrics.maxProfit, 2),
          ],
          [
            "New return on risk",
            metrics.returnOnRisk === null ? "Unlimited" : percent(metrics.returnOnRisk, 1),
          ],
        );
      }
    }
    request = raw;
  } catch (failure) {
    if (!(failure instanceof RangeError)) throw failure;
    invalid = failure.message;
  }
  const update = (legId: string, field: keyof Omit<FillFields, "legId">, value: string) => {
    setFills((values) =>
      values.map((fill) => (fill.legId === legId ? { ...fill, [field]: value } : fill)),
    );
    setError(null);
  };
  return (
    <form
      aria-label="Roll position"
      className="roll-form"
      onSubmit={async (event) => {
        event.preventDefault();
        if (inFlight.current || request === null) return;
        inFlight.current = true;
        setPending(true);
        setError(null);
        try {
          await onSave(position.id, { action: "roll", input: request });
          if (mounted.current) onCancel();
        } catch (failure) {
          if (mounted.current)
            setError(failure instanceof Error ? failure.message : String(failure));
        } finally {
          inFlight.current = false;
          if (mounted.current) setPending(false);
        }
      }}
    >
      <h2>Roll {position.underlying}</h2>
      <p>Roll every open option leg at its remaining quantity. Backing shares stay untouched.</p>
      <fieldset disabled={pending}>
        <legend className="sr-only">Roll fills</legend>
        <label>
          Roll trade date
          <input
            name="tradeDate"
            type="date"
            min={position.openedOn}
            max={campaign.asOf}
            required
            value={tradeDate}
            onChange={(event) => setTradeDate(event.target.value)}
          />
        </label>
        {fills.map((fill) => {
          const leg = options.find((leg) => leg.id === fill.legId);
          if (!leg) throw new Error("Roll fill has no option");
          const name = legLabel(leg);
          return (
            <section key={leg.id} className="roll-leg" aria-label={name}>
              <h3>
                {name} · {openLegQuantity(leg)} contracts
              </h3>
              <div className="roll-columns">
                <fieldset>
                  <legend>1 · Close current leg</legend>
                  <p>
                    {leg.side === "short" ? "Buy to close" : "Sell to close"} · Expiry {leg.expiry}
                  </p>
                  {(
                    [
                      ["closePrice", "Close price"],
                      ["closeFees", "Close fees (charge)"],
                    ] as const
                  ).map(([field, label]) => (
                    <label key={field}>
                      {label} for {name}
                      <input
                        name={`${field}-${leg.id}`}
                        type="text"
                        inputMode="decimal"
                        pattern="[0-9]+(\.[0-9]{1,4})?"
                        required
                        value={fill[field]}
                        onChange={(event) => update(leg.id, field, event.target.value)}
                      />
                    </label>
                  ))}
                </fieldset>
                <fieldset>
                  <legend>2 · Open new leg</legend>
                  <p>
                    {leg.side === "short" ? "Sell to open" : "Buy to open"} · Same{" "}
                    {openLegQuantity(leg)} contracts
                  </p>
                  {(
                    [
                      ["strike", "New strike"],
                      ["openPrice", "Open price"],
                      ["openFees", "Open fees (charge)"],
                    ] as const
                  ).map(([field, label]) => (
                    <label key={field}>
                      {label} for {name}
                      <input
                        name={`${field}-${leg.id}`}
                        type="text"
                        inputMode="decimal"
                        pattern="[0-9]+(\.[0-9]{1,4})?"
                        required
                        value={fill[field]}
                        onChange={(event) => update(leg.id, field, event.target.value)}
                      />
                    </label>
                  ))}
                </fieldset>
              </div>
            </section>
          );
        })}
        <label>
          New expiry
          <input
            type="date"
            name="expiry"
            required
            value={expiry}
            onChange={(event) => setExpiry(event.target.value)}
          />
        </label>
        <fieldset className="roll-choices" aria-label="Roll expiry quick choices">
          <legend className="sr-only">Roll expiry quick choices</legend>
          {chips.map((chip) => (
            <button
              type="button"
              key={chip.date}
              aria-label={`${chip.date}${chip.monthly ? " M" : ""}`}
              aria-pressed={expiry === chip.date}
              onClick={() => setExpiry(chip.date)}
            >
              {shortDate(chip.date)}
              {chip.monthly && " M"}
            </button>
          ))}
        </fieldset>
        {calendarError && (
          <p role="status">
            NYSE calendar unsupported for these quick choices. Enter an expiry date manually.
          </p>
        )}
        <section className="roll-derived" aria-label="Derived roll metrics" aria-live="polite">
          <dl>
            {lines.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          <p className="note">
            Gross excludes fees. Net includes opening and closing fees; monthly P/L uses realized
            net.
          </p>
        </section>
        {invalid && <p role="status">{invalid}</p>}
        <div className="roll-choices">
          <button type="submit" disabled={pending || request === null}>
            Save roll
          </button>
          <button type="button" onClick={onCancel}>
            Cancel roll
          </button>
        </div>
      </fieldset>
      {pending && <p role="status">Saving roll…</p>}
      {error && (
        <div role="alert">
          <p>{error}</p>
          <p>If the outcome is uncertain, reload the campaign before another action.</p>
        </div>
      )}
    </form>
  );
}
