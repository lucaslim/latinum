import { useEffect, useId, useRef, useState } from "react";
import { CalendarCoverageError, FIRST_YEAR, LAST_YEAR } from "../../domain/calendar.ts";
import { dte, type IsoDate } from "../../domain/dates.ts";
import { expiryChips } from "../../domain/expiry.ts";
import { formatMoney4, type Money4 } from "../../domain/money.ts";
import type { Metrics } from "../../domain/positions.ts";
import { tagSuggestions, tickerSuggestions } from "../../shared/symbols.ts";
import type { AssignedStockOption, TradeFormOptions, TradeStrategy } from "../../shared/trade.ts";
import { defaultFee, previewTrade } from "../../shared/tradeForm.ts";
import { percent, usd } from "../format.ts";
import { createTrade } from "../tradeApi.ts";
import { tradeFormFeedback } from "../tradeFormFeedback.ts";
import { type ComboOption, SearchCombobox } from "./SearchCombobox.tsx";
import "./trade-form.css";

const strategies: (ComboOption<TradeStrategy> & { aliases: string })[] = [
  {
    value: "csp",
    label: "Cash-secured put",
    detail: "CSP",
    group: "Income",
    tone: "credit",
    aliases: "wheel",
  },
  {
    value: "cc",
    label: "Covered call",
    detail: "CC",
    group: "Income",
    tone: "credit",
    aliases: "wheel",
  },
  {
    value: "put_credit_spread",
    label: "Put credit spread",
    detail: "PCS",
    group: "Spreads",
    tone: "credit",
    aliases: "bull put vertical",
  },
  {
    value: "call_credit_spread",
    label: "Call credit spread",
    detail: "CCS",
    group: "Spreads",
    tone: "credit",
    aliases: "bear call vertical",
  },
  {
    value: "put_debit_spread",
    label: "Put debit spread",
    detail: "PDS",
    group: "Spreads",
    tone: "debit",
    aliases: "bear put vertical hedge",
  },
  {
    value: "call_debit_spread",
    label: "Call debit spread",
    detail: "CDS",
    group: "Spreads",
    tone: "debit",
    aliases: "bull call vertical",
  },
  {
    value: "long_put",
    label: "Long put",
    detail: "LP",
    group: "Directional",
    tone: "debit",
    aliases: "hedge",
  },
  {
    value: "long_call",
    label: "Long call",
    detail: "LC",
    group: "Directional",
    tone: "debit",
    aliases: "",
  },
  { value: "stock", label: "Stock", group: "Stock", aliases: "" },
  { value: "day_trade", label: "Day trade", group: "Stock", aliases: "" },
];
const strategyOptions = (query: string) =>
  strategies.filter((option) =>
    `${option.label} ${option.detail ?? ""} ${option.aliases}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
const uppercase = (query: string) => query.toUpperCase();

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
  onDirtyChange,
}: {
  asOf: IsoDate;
  options: TradeFormOptions;
  assignedStock?: AssignedStockOption;
  onSaved: () => void;
  onCancel: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const id = useId();
  const [strategy, setStrategy] = useState<TradeStrategy>(assignedStock ? "cc" : "csp");
  const [ticker, setTicker] = useState(assignedStock?.underlying ?? "");
  const [tickerQuery, setTickerQuery] = useState<string | null>(null);
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
  const [otherExpiry, setOtherExpiry] = useState(false);
  const expiryInput = useRef<HTMLInputElement>(null);
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
  const [pickedRole, setPickedRole] = useState<"hedge" | "swing" | null>(null);
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
  const initial = useRef({ strategy, ticker, openedOn, expiry, quantity, cover });
  const stock = strategy === "stock" || strategy === "day_trade";
  const spread = strategy.endsWith("_spread");
  const hasRole = strategy.includes("debit") || strategy.startsWith("long_");
  const defaultRole = strategy.includes("put") ? "hedge" : "swing";
  const role = pickedRole ?? defaultRole;
  const qty = Number(quantity);
  const feeDefault = stock
    ? "0.00"
    : Number.isSafeInteger(qty) && qty > 0 && qty <= 2147483647
      ? formatMoney4(defaultFee(qty), 2)
      : "";
  const common = { underlying: tickerQuery ?? ticker, openedOn, tags, notes };
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
  // A fee field typed back to its default is not an edit; every other field is dirty once it
  // differs from its first-render value.
  const edited = (value: string | null) => value !== null && value !== feeDefault;
  const dirty =
    strategy !== initial.current.strategy ||
    ticker !== initial.current.ticker ||
    (tickerQuery !== null && tickerQuery !== "" && tickerQuery !== ticker) ||
    openedOn !== initial.current.openedOn ||
    expiry !== initial.current.expiry ||
    quantity !== initial.current.quantity ||
    cover !== initial.current.cover ||
    [strike, price, longStrike, shortStrike, longPrice, shortPrice, basis, tag, notes].some(
      (value) => value !== "",
    ) ||
    [fees, longFees, shortFees].some(edited) ||
    (pickedRole !== null && pickedRole !== defaultRole) ||
    adjusted ||
    tags.length > 0;
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
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

  const put = strategy === "csp" || strategy.includes("put");
  const rows = strategy.includes("credit")
    ? (["short", "long"] as const)
    : (["long", "short"] as const);
  const customExpiry = otherExpiry || !chips.some((chip) => chip.date === expiry);
  const headline = stock
    ? `${ticker} ×${quantity} sh`
    : `${ticker} ${spread ? rows.map((leg) => (leg === "long" ? longStrike : shortStrike)).join("/") : strike}${put ? "p" : "c"} ${expiry.slice(5)} ×${quantity}`;

  return (
    <form aria-label="Add trade" className="trade-form" onSubmit={save}>
      <h2>Add trade</h2>
      <div className="trade-ticket">
        <fieldset disabled={saving} className="trade-main">
          <div className="trade-entry-fields">
            <SearchCombobox
              label="Strategy"
              value={strategy}
              displayValue={
                strategies.find((option) => option.value === strategy)?.label ?? strategy
              }
              options={strategyOptions}
              onPick={(value) => {
                if (value === strategy) return;
                setStrategy(value);
                setPickedRole(null);
              }}
            />
            <SearchCombobox
              label="Ticker"
              value={ticker}
              displayValue={ticker}
              freeText={{ normalize: uppercase, onQueryChange: setTickerQuery }}
              options={(query) => {
                const symbols = tickerSuggestions(query, options.tickers);
                const choices: ComboOption<string>[] = symbols.map((value) => ({
                  value,
                  label: value,
                  group: options.tickers.includes(value) ? "In journal" : "Suggestions",
                }));
                if (query && !symbols.includes(query))
                  choices.push({ value: query, label: `Use ${query}`, group: "New symbol" });
                return choices;
              }}
              onPick={(value) => {
                if (value === ticker) return;
                setTicker(value);
                setCover("held");
              }}
            />
            {input(stock ? "Shares" : "Quantity", quantity, setQuantity, "number")}
          </div>
          {strategy === "day_trade" && (
            <p>Long stock day trade. Closing trades are recorded separately.</p>
          )}
          {stock && <p>Quantity is shares. Stock fees default to zero.</p>}
          {!stock && (
            <div className="trade-expiry">
              <p className="trade-label">Expiry</p>
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
                    aria-pressed={!customExpiry && expiry === chip.date}
                    onClick={() => {
                      setExpiry(chip.date);
                      setOtherExpiry(false);
                    }}
                  >
                    {chip.date.slice(5)}
                    {chip.monthly ? " M" : ""} {dte(chip.date, asOf)}d
                  </button>
                ))}
                <button
                  type="button"
                  aria-pressed={customExpiry}
                  onClick={() => {
                    if (chips.some((chip) => chip.date === expiry)) setOtherExpiry(!otherExpiry);
                    else expiryInput.current?.focus();
                  }}
                >
                  Other…
                </button>
              </fieldset>
              {customExpiry && (
                <label>
                  Expiry
                  <input
                    ref={expiryInput}
                    type="date"
                    value={expiry}
                    onChange={(event) => setExpiry(event.target.value)}
                  />
                </label>
              )}
              <p className="note">Selected expiry: {expiry || "Choose a date"}</p>
            </div>
          )}
          <section aria-label="Legs" className="trade-legs-card">
            {stock ? (
              input("Fill price", price, setPrice)
            ) : (
              <table className="trade-legs">
                <thead>
                  <tr>
                    <th scope="col">Side</th>
                    <th scope="col">Strike</th>
                    <th scope="col">Fill</th>
                  </tr>
                </thead>
                <tbody>
                  {spread ? (
                    rows.map((leg) => (
                      <tr key={leg}>
                        <th scope="row">
                          <span className={leg === "long" ? "trade-buy" : "trade-sell"}>
                            {leg === "long" ? "Buy" : "Sell"}
                          </span>{" "}
                          {put ? "Put" : "Call"}
                        </th>
                        <td>
                          {input(
                            leg === "long" ? "Long strike" : "Short strike",
                            leg === "long" ? longStrike : shortStrike,
                            leg === "long" ? setLongStrike : setShortStrike,
                          )}
                        </td>
                        <td>
                          {input(
                            leg === "long" ? "Long fill price" : "Short fill price",
                            leg === "long" ? longPrice : shortPrice,
                            leg === "long" ? setLongPrice : setShortPrice,
                          )}
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <th scope="row">
                        <span className={hasRole ? "trade-buy" : "trade-sell"}>
                          {hasRole ? "Buy" : "Sell"}
                        </span>{" "}
                        {put ? "Put" : "Call"}
                      </th>
                      <td>{input("Strike", strike, setStrike)}</td>
                      <td>{input("Fill price", price, setPrice)}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            )}
            <div className="trade-fee-line">
              <span>
                Fees
                {feeDefault === "" && fees === null && longFees === null && shortFees === null
                  ? ""
                  : spread && (longFees !== null || shortFees !== null)
                    ? ` $${longFees ?? feeDefault} / $${shortFees ?? feeDefault} (long / short)`
                    : ` $${spread ? feeDefault : (fees ?? feeDefault)}${spread ? " per leg" : ""}`}
                {!stock &&
                  feeDefault !== "" &&
                  (spread ? longFees === null && shortFees === null : fees === null) &&
                  ` (0.65 × ${quantity})`}{" "}
                ·{" "}
              </span>
              <details className="trade-fee-editor">
                <summary aria-label="Edit fees">Edit</summary>
                <div className="trade-fields">
                  {spread ? (
                    <>
                      {input("Long fees", longFees ?? feeDefault, setLongFees)}
                      {input("Short fees", shortFees ?? feeDefault, setShortFees)}
                    </>
                  ) : (
                    input("Fees", fees ?? feeDefault, setFees)
                  )}
                </div>
              </details>
            </div>
            {hasRole && (
              <div className="trade-role">
                <fieldset aria-label="Role" className="trade-segment">
                  <legend>Role</legend>
                  {(["hedge", "swing"] as const).map((value) => (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={role === value}
                      onClick={() => setPickedRole(value)}
                    >
                      {value === "hedge" ? "Hedge" : "Swing"}
                    </button>
                  ))}
                </fieldset>
                <p className="note">
                  Defaults to {put ? "Hedge: downside protection." : "Swing: directional."}
                </p>
              </div>
            )}
            {strategy === "cc" && (
              <div className="trade-fields">
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
              </div>
            )}
          </section>
          <details className="trade-extra">
            <summary>Tags, notes, opened date, adjusted contract</summary>
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

            {input("Opened on", openedOn, setOpenedOn, "date")}
            {!stock && (
              <label className="trade-check">
                <input
                  type="checkbox"
                  checked={adjusted}
                  onChange={(event) => setAdjusted(event.target.checked)}
                />
                Adjusted contract
              </label>
            )}
          </details>
        </fieldset>
        <aside className="trade-summary">
          {preview.success ? (
            <>
              <p className="trade-headline">{headline}</p>
              <DerivedTradeMetrics metrics={preview.metrics} costBasis={preview.costBasis} />
            </>
          ) : (
            <section aria-label="Derived trade metrics" aria-live="polite">
              <p className="note">Complete valid trade details to see metrics.</p>
              {tradeFormFeedback(raw, preview.errors, spread).map((message) => (
                <p className="trade-errors" key={message}>
                  {message}
                </p>
              ))}
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
        </aside>
      </div>
    </form>
  );
}
