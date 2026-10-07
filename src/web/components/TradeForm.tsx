import { useEffect, useId, useRef, useState } from "react";
import { CalendarCoverageError, FIRST_YEAR, LAST_YEAR } from "../../domain/calendar.ts";
import type { IsoDate } from "../../domain/dates.ts";
import { expiryChips } from "../../domain/expiry.ts";
import { formatMoney4, type Money4 } from "../../domain/money.ts";
import type { Metrics } from "../../domain/positions.ts";
import { tagSuggestions, tickerSuggestions } from "../../shared/symbols.ts";
import {
  type AssignedStockOption,
  STRATEGY_LABELS,
  TRADE_STRATEGIES,
  type TradeFormOptions,
  type TradeStrategy,
} from "../../shared/trade.ts";
import { defaultFee, previewTrade } from "../../shared/tradeForm.ts";
import { percent, usd } from "../format.ts";
import { createTrade } from "../tradeApi.ts";
import "./trade-form.css";

export function DerivedTradeMetrics({
  metrics,
  costBasis = null,
}: {
  metrics: Metrics;
  costBasis?: Money4 | null;
}) {
  const money = (amount: Money4) => usd(amount, amount % 10000 === 0 ? 0 : 2);
  const lines: [string, string][] =
    metrics.kind === "income"
      ? [
          ["Premium", money(metrics.premium)],
          ["Collateral", money(metrics.collateral)],
          ["Yield", percent(metrics.yield, 2)],
          ["Term", `${metrics.term} days`],
          ["Annualized", percent(metrics.annualized, 1)],
          ["Breakeven", usd(metrics.breakeven, 2)],
          ...(costBasis === null
            ? []
            : [["Cost basis if assigned", `${usd(costBasis, 2)}/sh`] as [string, string]]),
        ]
      : metrics.kind === "debit"
        ? [
            ["Debit", money(metrics.debit)],
            ["Collateral", money(metrics.collateral)],
            ["Term", `${metrics.term} days`],
            ["Breakeven", usd(metrics.breakeven, 2)],
            [
              "Max profit",
              metrics.maxProfit === "unlimited" ? "Unlimited" : money(metrics.maxProfit),
            ],
            ["Max loss", money(metrics.maxLoss)],
            [
              "Return on risk",
              metrics.returnOnRisk === null ? "Unlimited" : percent(metrics.returnOnRisk, 1),
            ],
          ]
        : [["Capital", money(metrics.collateral)]];
  return (
    <section aria-label="Derived trade metrics" aria-live="polite" className="trade-metrics">
      <dl>
        {lines.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <p className="note">Gross, before fees.</p>
    </section>
  );
}

export function TradeForm({
  asOf,
  options,
  assignedStock,
  onSaved,
  onCancel,
}: {
  asOf: IsoDate;
  options: TradeFormOptions;
  assignedStock?: AssignedStockOption;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [strategy, setStrategy] = useState<TradeStrategy>(assignedStock ? "cc" : "csp");
  const [ticker, setTicker] = useState(assignedStock?.underlying ?? "");
  const [openedOn, setOpenedOn] = useState<string>(asOf);
  let chips: ReturnType<typeof expiryChips> = [];
  let calendarUnsupported = false;
  try {
    chips = expiryChips(asOf);
  } catch (cause) {
    if (!(cause instanceof CalendarCoverageError)) throw cause;
    calendarUnsupported = true;
  }
  const [expiry, setExpiry] = useState<string>(chips[0]?.date ?? "");
  const [quantity, setQuantity] = useState(
    assignedStock ? String(Math.floor(assignedStock.uncoveredShares / 100)) : "1",
  );
  const [strike, setStrike] = useState("");
  const [price, setPrice] = useState("");
  const [fees, setFees] = useState<string | null>(null);
  const [longStrike, setLongStrike] = useState("");
  const [shortStrike, setShortStrike] = useState("");
  const [longPrice, setLongPrice] = useState("");
  const [shortPrice, setShortPrice] = useState("");
  const [longFees, setLongFees] = useState<string | null>(null);
  const [shortFees, setShortFees] = useState<string | null>(null);
  const [role, setRole] = useState<"hedge" | "swing">("hedge");
  const [adjusted, setAdjusted] = useState(false);
  const [cover, setCover] = useState(assignedStock?.legId ?? "held");
  const [basis, setBasis] = useState("");
  const [tag, setTag] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const stock = strategy === "stock" || strategy === "day_trade";
  const spread = strategy.endsWith("_spread");
  const hasRole = strategy.includes("debit") || strategy.startsWith("long_");
  const qty = Number(quantity);
  const feeDefault = stock
    ? "0.00"
    : Number.isSafeInteger(qty) && qty > 0 && qty <= 2147483647
      ? formatMoney4(defaultFee(qty), 2)
      : "";
  const common = { underlying: ticker, openedOn, tags, notes };
  const option = { expiry, quantity: qty, adjusted };
  const raw = stock
    ? { ...common, strategy, shares: qty, price, fees: fees ?? feeDefault }
    : spread
      ? {
          ...common,
          ...option,
          strategy,
          short: { strike: shortStrike, price: shortPrice, fees: shortFees ?? feeDefault },
          long: { strike: longStrike, price: longPrice, fees: longFees ?? feeDefault },
          ...(hasRole ? { role } : {}),
        }
      : {
          ...common,
          ...option,
          strategy,
          strike,
          price,
          fees: fees ?? feeDefault,
          ...(hasRole ? { role } : {}),
          ...(strategy === "cc"
            ? {
                cover:
                  cover === "held"
                    ? { kind: "held", basis }
                    : { kind: "assigned", stockLegId: cover },
              }
            : {}),
        };
  const preview = previewTrade(raw, options.assignedStock);
  const availableStock = options.assignedStock.filter((s) => s.underlying === ticker);
  const selectedStock = availableStock.find((s) => s.legId === cover);
  const input = (label: string, value: string, update: (value: string) => void, type = "text") => (
    <label>
      {label}
      <input
        type={type}
        inputMode={type === "text" ? "decimal" : undefined}
        value={value}
        onChange={(event) => update(event.target.value)}
      />
    </label>
  );
  const addTag = () => {
    const clean = tag.trim();
    if (clean && !tags.includes(clean)) setTags([...tags, clean]);
    setTag("");
  };

  async function save(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!preview.success || busy.current) return;
    busy.current = true;
    setSaving(true);
    setError(null);
    try {
      await createTrade(preview.input);
    } catch (cause) {
      if (!mounted.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
      busy.current = false;
      setSaving(false);
      return;
    }
    if (mounted.current) onSaved();
  }

  return (
    <form aria-label="Add trade" className="trade-form" onSubmit={save}>
      <h2>Add trade</h2>
      <fieldset disabled={saving}>
        <legend>Strategy</legend>
        <div className="trade-chips">
          {TRADE_STRATEGIES.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={strategy === value}
              onClick={() => setStrategy(value)}
            >
              {STRATEGY_LABELS[value]}
            </button>
          ))}
        </div>
        {strategy === "day_trade" && (
          <p>Long stock day trade. Closing trades are recorded separately.</p>
        )}
        <div className="trade-fields">
          <label>
            Ticker
            <input
              value={ticker}
              list={`${id}-tickers`}
              autoCapitalize="characters"
              onChange={(event) => {
                setTicker(event.target.value.toUpperCase());
                setCover("held");
              }}
            />
          </label>
          <datalist id={`${id}-tickers`}>
            {tickerSuggestions(ticker, options.tickers).map((value) => (
              <option key={value} value={value} />
            ))}
          </datalist>
          {input("Opened on", openedOn, setOpenedOn, "date")}
          {!stock && input("Expiry", expiry, setExpiry, "date")}
          {input("Quantity", quantity, setQuantity, "number")}
          {!stock && !spread && input("Strike", strike, setStrike)}
          {spread ? (
            <>
              {input("Long strike", longStrike, setLongStrike)}
              {input("Short strike", shortStrike, setShortStrike)}
              {input("Long fill price", longPrice, setLongPrice)}
              {input("Short fill price", shortPrice, setShortPrice)}
              {input("Long fees", longFees ?? feeDefault, setLongFees)}
              {input("Short fees", shortFees ?? feeDefault, setShortFees)}
            </>
          ) : (
            <>
              {input("Fill price", price, setPrice)}
              {input("Fees", fees ?? feeDefault, setFees)}
            </>
          )}
          {hasRole && (
            <label>
              Role
              <select
                value={role}
                onChange={(event) => setRole(event.target.value === "swing" ? "swing" : "hedge")}
              >
                <option value="hedge">Hedge</option>
                <option value="swing">Swing</option>
              </select>
            </label>
          )}
          {strategy === "cc" && (
            <>
              <label>
                Covered shares
                <select value={cover} onChange={(event) => setCover(event.target.value)}>
                  <option value="held">Held shares</option>
                  {availableStock.map((s) => (
                    <option key={s.legId} value={s.legId}>
                      {s.underlying} — {s.uncoveredShares} assigned shares ({s.assignedOn})
                    </option>
                  ))}
                </select>
              </label>
              {cover === "held" ? (
                input("Share basis", basis, setBasis)
              ) : (
                <label>
                  Share basis
                  <input
                    readOnly
                    value={selectedStock ? formatMoney4(selectedStock.basis, 4) : ""}
                  />
                </label>
              )}
            </>
          )}
        </div>
        {stock && <p>Quantity is shares. Stock fees default to zero.</p>}
        {!stock && (
          <>
            {calendarUnsupported && (
              <p role="status">
                NYSE calendar unsupported for these expiry quick choices (coverage: {FIRST_YEAR}–
                {LAST_YEAR}). Enter an expiry date manually.
              </p>
            )}
            <fieldset aria-label="Expiry quick choices" className="trade-chips">
              {chips.map((chip) => (
                <button
                  type="button"
                  key={chip.date}
                  aria-pressed={expiry === chip.date}
                  onClick={() => setExpiry(chip.date)}
                >
                  {chip.date}
                  {chip.monthly ? " M" : ""}
                </button>
              ))}
            </fieldset>
            <label className="trade-check">
              <input
                type="checkbox"
                checked={adjusted}
                onChange={(event) => setAdjusted(event.target.checked)}
              />
              Adjusted contract
            </label>
          </>
        )}
        <div className="trade-tags">
          <label>
            Tags
            <input
              value={tag}
              list={`${id}-tags`}
              onChange={(event) => setTag(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addTag();
                }
              }}
            />
          </label>
          <datalist id={`${id}-tags`}>
            {tagSuggestions(tag, options.tags).map((value) => (
              <option key={value} value={value} />
            ))}
          </datalist>
          <button type="button" onClick={addTag} disabled={!tag.trim()}>
            Add tag
          </button>
          <section aria-label="Selected tags" className="trade-chips">
            {tags.map((value) => (
              <button
                type="button"
                key={value}
                aria-label={`Remove tag ${value}`}
                onClick={() => setTags(tags.filter((t) => t !== value))}
              >
                {value} ×
              </button>
            ))}
          </section>
        </div>
        <label>
          Notes
          <textarea
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            maxLength={4000}
          />
        </label>
      </fieldset>
      {preview.success ? (
        <DerivedTradeMetrics metrics={preview.metrics} costBasis={preview.costBasis} />
      ) : (
        <section aria-label="Derived trade metrics" aria-live="polite">
          <p>Complete valid trade details to see metrics.</p>
          <ul className="trade-errors">
            {[...new Set(preview.errors)].map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </section>
      )}
      {error && <p role="alert">{error}</p>}
      <div className="trade-actions">
        <button type="submit" disabled={!preview.success || saving}>
          {saving ? "Saving…" : "Save trade"}
        </button>
        <button type="button" disabled={saving} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
