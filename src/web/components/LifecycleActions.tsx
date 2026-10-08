import { useEffect, useRef, useState } from "react";
import type { CampaignLeg, CampaignPosition } from "../../domain/campaign.ts";
import { openLegQuantity } from "../../domain/campaignMetrics.ts";
import { formatMoney4 } from "../../domain/money.ts";
import { defaultFeeInput, feeToApi } from "../fees.ts";
import type { LifecycleMutation, SaveLifecycle } from "../lifecycleApi.ts";
import "./lifecycle.css";

type Mode = { action: "close" | "expire" | "link-hedge" } | { action: "assign"; legId: string };
const legName = (leg: CampaignLeg) =>
  `${leg.underlying} ${leg.side} ${leg.kind}${leg.strike === null ? "" : ` ${formatMoney4(leg.strike, 2)}`}`;
const submitLabel = {
  close: "Record close",
  expire: "Record expiration",
  assign: "Record assignment",
  "link-hedge": "Record hedge link",
};

export function LifecycleActions({
  position,
  onSave,
}: {
  position: CampaignPosition;
  onSave: SaveLifecycle;
}) {
  const [mode, setMode] = useState<Mode | null>(null);
  const [included, setIncluded] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Closing quantity per leg once the user has typed a valid one; an edited fee stops following it.
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [editedFees, setEditedFees] = useState<Record<string, string>>({});
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const openLegs = position.legs.filter((leg) => openLegQuantity(leg) > 0);
  if (openLegs.length === 0) return null;
  const assignable =
    position.strategy === "csp" && position.role === "income" && position.legs.length === 1
      ? openLegs.filter(
          (leg) =>
            leg.kind === "put" && leg.side === "short" && !leg.adjusted && leg.multiplier === 100,
        )
      : [];
  function choose(next: Mode) {
    setMode(next);
    setIncluded(openLegs.map((leg) => leg.id));
    setError(null);
    setQuantities({});
    setEditedFees({});
  }
  return (
    <section
      className="lifecycle-actions"
      aria-label={`Lifecycle actions for ${position.underlying}`}
    >
      <h3>{position.underlying} lifecycle</h3>
      <div className="lifecycle-buttons">
        <button type="button" disabled={pending} onClick={() => choose({ action: "close" })}>
          Close {position.underlying} position
        </button>
        {openLegs.some((leg) => leg.kind !== "stock") && (
          <button type="button" disabled={pending} onClick={() => choose({ action: "expire" })}>
            Expire {position.underlying} options
          </button>
        )}
        {assignable.map((leg) => (
          <button
            key={leg.id}
            type="button"
            disabled={pending}
            onClick={() => choose({ action: "assign", legId: leg.id })}
          >
            Assign {position.underlying} put
          </button>
        ))}
        {position.role === "hedge" && (
          <button type="button" disabled={pending} onClick={() => choose({ action: "link-hedge" })}>
            Link {position.underlying} hedge
          </button>
        )}
      </div>
      {mode && (
        <form
          key={`${mode.action}${mode.action === "assign" ? mode.legId : ""}`}
          onSubmit={async (event) => {
            event.preventDefault();
            if (inFlight.current) return;
            const form = new FormData(event.currentTarget);
            const tradeDate = String(form.get("tradeDate") ?? "");
            const observed = { expectedRevision: position.revision };
            const date = tradeDate ? { ...observed, tradeDate } : observed;
            let mutation: LifecycleMutation;
            switch (mode.action) {
              case "close":
                mutation = {
                  action: "close",
                  input: {
                    ...date,
                    fills: openLegs
                      .filter((leg) => included.includes(leg.id))
                      .map((leg) => ({
                        legId: leg.id,
                        quantity: Number(form.get(`quantity-${leg.id}`)),
                        price: String(form.get(`price-${leg.id}`)),
                        fees: feeToApi(String(form.get(`fees-${leg.id}`))),
                      })),
                  },
                };
                break;
              case "expire":
                mutation = { action: "expire", input: date };
                break;
              case "assign":
                mutation = {
                  action: "assign",
                  input: { ...date, legId: mode.legId, fees: feeToApi(String(form.get("fees"))) },
                };
                break;
              case "link-hedge":
                mutation = {
                  action: "link-hedge",
                  input: { ...observed, campaignId: String(form.get("campaignId")) },
                };
                break;
            }
            inFlight.current = true;
            setPending(true);
            setError(null);
            try {
              await onSave(position.id, mutation);
              if (mounted.current) setMode(null);
            } catch (failure: unknown) {
              if (mounted.current)
                setError(failure instanceof Error ? failure.message : String(failure));
            } finally {
              inFlight.current = false;
              if (mounted.current) setPending(false);
            }
          }}
        >
          <fieldset disabled={pending}>
            <legend>{submitLabel[mode.action]}</legend>
            {mode.action !== "link-hedge" && (
              <label>
                Trade date
                <input
                  aria-label="Trade date"
                  aria-describedby={`trade-date-help-${position.id}`}
                  name="tradeDate"
                  type="date"
                  min={position.openedOn}
                />
                <small id={`trade-date-help-${position.id}`}>
                  Leave blank for today in New York.
                </small>
              </label>
            )}
            {mode.action === "close" && (
              <>
                <p>
                  Enter a fill for each selected leg. Spread remainders must stay balanced; covered
                  calls must remain covered.
                </p>
                {openLegs.map((leg) => (
                  <div key={leg.id} className="lifecycle-fill">
                    <label className="lifecycle-include">
                      <input
                        type="checkbox"
                        checked={included.includes(leg.id)}
                        onChange={(event) =>
                          setIncluded((ids) =>
                            event.target.checked
                              ? [...ids, leg.id]
                              : ids.filter((id) => id !== leg.id),
                          )
                        }
                      />
                      Include {legName(leg)}
                    </label>
                    <fieldset disabled={!included.includes(leg.id)}>
                      <legend>{legName(leg)}</legend>
                      <label>
                        Quantity for {legName(leg)}
                        <input
                          name={`quantity-${leg.id}`}
                          type="number"
                          min="1"
                          max={openLegQuantity(leg)}
                          step="1"
                          defaultValue={openLegQuantity(leg)}
                          onChange={(event) => {
                            const quantity = Number(event.target.value);
                            if (
                              event.target.value !== "" &&
                              Number.isInteger(quantity) &&
                              quantity >= 1 &&
                              quantity <= openLegQuantity(leg)
                            )
                              setQuantities((current) => ({ ...current, [leg.id]: quantity }));
                          }}
                          required
                        />
                      </label>
                      <label>
                        Close price for {legName(leg)}
                        <input
                          name={`price-${leg.id}`}
                          type="text"
                          inputMode="decimal"
                          pattern="[0-9]+(\.[0-9]{1,4})?"
                          required
                        />
                      </label>
                      <label>
                        Close fees (charge) for {legName(leg)}
                        <input
                          name={`fees-${leg.id}`}
                          type="text"
                          inputMode="decimal"
                          pattern="[0-9]+(\.[0-9]{1,4})?"
                          value={
                            editedFees[leg.id] ??
                            defaultFeeInput(quantities[leg.id] ?? openLegQuantity(leg))
                          }
                          onChange={(event) =>
                            setEditedFees((current) => ({
                              ...current,
                              [leg.id]: event.target.value,
                            }))
                          }
                          required
                        />
                      </label>
                    </fieldset>
                  </div>
                ))}
              </>
            )}
            {mode.action === "expire" && (
              <p>
                Expire all remaining option contracts at zero price, cash and fees. Stock stays
                untouched. The trade date must not precede any option expiry.
              </p>
            )}
            {mode.action === "assign" && (
              <>
                <p>
                  Assign all remaining contracts. Stock cash entry is the strike; wheel basis
                  subtracts gross put premium.
                </p>
                <label>
                  Assignment fees (charge)
                  <input
                    name="fees"
                    type="text"
                    inputMode="decimal"
                    pattern="[0-9]+(\.[0-9]{1,4})?"
                    defaultValue="0"
                    required
                  />
                </label>
              </>
            )}
            {mode.action === "link-hedge" && (
              <>
                <label>
                  Target campaign UUID
                  <input
                    name="campaignId"
                    type="text"
                    pattern="[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
                    required
                  />
                </label>
                <p>
                  Move this open hedge to a campaign in the same account. The source campaign is
                  preserved. Roll-linked positions cannot move.
                </p>
              </>
            )}
            <div className="lifecycle-buttons">
              <button type="submit" disabled={mode.action === "close" && included.length === 0}>
                {submitLabel[mode.action]}
              </button>
              <button
                type="button"
                onClick={() => {
                  setMode(null);
                  setError(null);
                }}
              >
                Cancel
              </button>
            </div>
          </fieldset>
          {pending && <p role="status">Saving lifecycle action…</p>}
          {error && (
            <div role="alert">
              <p>{error}</p>
              <p>
                If the connection was interrupted, check the recorded timeline before submitting
                again.
              </p>
            </div>
          )}
        </form>
      )}
    </section>
  );
}
