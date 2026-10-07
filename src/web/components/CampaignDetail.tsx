import { type ReactNode, useEffect, useRef, useState } from "react";
import type { CampaignResponse, ManualMarkRequest, SwingView } from "../../domain/campaign.ts";
import { buildCampaignView, openLegQuantity } from "../../domain/campaignMetrics.ts";
import { allocateRealizedTrades } from "../../domain/lifecyclePnl.ts";
import { formatMoney4, type Money4, sumMoney4 } from "../../domain/money.ts";
import { percent, usd } from "../format.ts";
import type { LifecycleMutation, LifecycleResult, SaveLifecycle } from "../lifecycleApi.ts";
import { LifecycleActions } from "./LifecycleActions.tsx";
import "./campaign.css";

export interface CampaignDetailProps {
  campaign: CampaignResponse;
  onSaveMark?: (legId: string, input: ManualMarkRequest) => Promise<void>;
  onSaveLifecycle?: SaveLifecycle;
  onSellCoveredCall?: (stockLegId: string) => void;
}

const signedUsd = (amount: Money4) => `${amount >= 0 ? "+" : ""}${usd(amount)}`;
/** Format Money4 as USD to cents with an explicit plus sign for nonnegative amounts. */
const signedCents = (amount: Money4) => `${amount >= 0 ? "+" : ""}${usd(amount, 2)}`;
const count = (quantity: number) => quantity.toLocaleString("en-US");

function Metric({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function MarkForm({
  swing,
  onSaveMark,
}: {
  swing: SwingView;
  onSaveMark: NonNullable<CampaignDetailProps["onSaveMark"]>;
}) {
  const [price, setPrice] = useState(swing.mark ? formatMoney4(swing.mark.price, 4) : "");
  const [feedback, setFeedback] = useState<
    { status: "idle" | "pending" | "saved" } | { status: "error"; message: string }
  >({ status: "idle" });
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  return (
    <form
      className="campaign-mark"
      onSubmit={async (event) => {
        event.preventDefault();
        if (feedback.status === "pending") return;
        setFeedback({ status: "pending" });
        try {
          await onSaveMark(swing.legId, { price });
          if (mounted.current) setFeedback({ status: "saved" });
        } catch (error: unknown) {
          if (mounted.current) {
            setFeedback({
              status: "error",
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }}
    >
      <label>
        <span>Mark price for {swing.underlying}</span>
        <input
          aria-label={`Mark price for ${swing.underlying}`}
          type="text"
          inputMode="decimal"
          pattern="[0-9]+(\.[0-9]{1,4})?"
          required
          value={price}
          disabled={feedback.status === "pending"}
          onChange={(event) => {
            setPrice(event.target.value);
            setFeedback({ status: "idle" });
          }}
        />
      </label>
      <button type="submit" disabled={feedback.status === "pending"}>
        Save mark for {swing.underlying}
      </button>
      {feedback.status === "pending" && <p role="status">Saving mark…</p>}
      {feedback.status === "saved" && <p role="status">Mark saved; campaign refreshed.</p>}
      {feedback.status === "error" && <p role="alert">{feedback.message}</p>}
    </form>
  );
}

/** Render campaign metrics, lifecycle controls and recorded trades with allocated realized P/L. */
export function CampaignDetail({
  campaign,
  onSaveMark,
  onSaveLifecycle,
  onSellCoveredCall,
}: CampaignDetailProps) {
  const view = buildCampaignView(campaign);
  const [lastLifecycle, setLastLifecycle] = useState<{
    mutation: LifecycleMutation;
    result: LifecycleResult;
  } | null>(null);
  const realized = campaign.positions.flatMap((position) =>
    position.legs.flatMap((leg) =>
      allocateRealizedTrades(leg.trades.map((trade) => ({ ...trade, date: trade.tradeDate }))),
    ),
  );
  const realizedByTrade = new Map(realized.map((allocation) => [allocation.tradeId, allocation]));
  const spreadPositionIds = new Set(
    campaign.positions
      .filter(
        (position) =>
          position.strategy === "put_debit_spread" || position.strategy === "call_debit_spread",
      )
      .map((position) => position.id),
  );
  const scenarioHedges = view.hedges.filter((hedge) => spreadPositionIds.has(hedge.positionId));
  const capitalTerms = campaign.positions
    .filter(
      (position) =>
        position.strategy === "csp" &&
        position.role === "income" &&
        position.closedOn === null &&
        !view.unsupportedPositionIds.includes(position.id),
    )
    .flatMap((position) => position.legs)
    .flatMap((leg) => {
      const quantity = openLegQuantity(leg);
      if (leg.kind !== "put" || leg.side !== "short" || leg.strike === null || quantity <= 0) {
        return [];
      }
      return [`${usd(leg.strike, 2)} × ${leg.multiplier} × ${quantity}`];
    });

  return (
    <div className="campaign-detail">
      <h1>{campaign.title} campaign</h1>
      <p className="subtitle">
        Opened {campaign.openedOn} · As of {campaign.asOf}
        {campaign.closedOn && ` · Closed ${campaign.closedOn}`}
      </p>
      {campaign.notes && <p>{campaign.notes}</p>}
      {lastLifecycle && (
        <div className="lifecycle-feedback campaign-panel" role="status">
          {lastLifecycle.mutation.action === "link-hedge" ? (
            <>
              <p>
                {lastLifecycle.result.campaignId === campaign.id
                  ? "Hedge already belongs to this campaign."
                  : "Hedge moved; source campaign preserved."}
              </p>
              <a href={`#/campaigns/${lastLifecycle.result.campaignId}`}>Open target campaign</a>
            </>
          ) : (
            "realized" in lastLifecycle.result && (
              <>
                <p>
                  Lifecycle saved; campaign refreshed. Realized net P/L{" "}
                  {signedCents(
                    sumMoney4(lastLifecycle.result.realized.map((allocation) => allocation.pnl)),
                  )}
                </p>
                {lastLifecycle.result.assignment && (
                  <p
                    data-stock-leg-id={lastLifecycle.result.assignment.stockLegId}
                    data-share-basis={lastLifecycle.result.assignment.basis}
                  >
                    Assignment: {count(lastLifecycle.result.assignment.shares)} shares · Wheel basis{" "}
                    {usd(lastLifecycle.result.assignment.basis, 2)}
                  </p>
                )}
              </>
            )
          )}
        </div>
      )}

      <section className="campaign-panel" aria-label="Recorded legs">
        <h2>Recorded legs</h2>
        <ul className="campaign-legs">
          {campaign.positions.map((position) => (
            <li key={position.id}>
              <strong>{position.underlying}</strong> · {position.strategy} · {position.role}
              {position.notes && <p>{position.notes}</p>}
              <ul>
                {position.legs.map((leg) => (
                  <li key={leg.id}>
                    {leg.underlying} {leg.side} {leg.kind}
                    {leg.strike !== null && ` · Strike ${usd(leg.strike, 2)}`}
                    {leg.expiry && ` · Expiry ${leg.expiry}`}
                    {` · ${count(openLegQuantity(leg))} open ${leg.kind === "stock" ? "shares" : "contracts"}`}
                    {leg.adjusted && " · Adjusted deliverable"}
                  </li>
                ))}
              </ul>
              {onSaveLifecycle && (
                <LifecycleActions
                  position={position}
                  onSave={async (positionId, mutation) => {
                    const result = await onSaveLifecycle(positionId, mutation);
                    setLastLifecycle({ mutation, result });
                    return result;
                  }}
                />
              )}
              {view.unsupportedPositionIds.includes(position.id) && (
                <p className="tone-muted">
                  Scenario cards are not available for this recorded strategy.
                </p>
              )}
            </li>
          ))}
        </ul>
      </section>

      {view.csp && (
        <section className="campaign-panel" aria-label="Cash-secured put scenarios">
          <h2>Cash-secured puts</h2>
          <dl className="campaign-metrics">
            <Metric label="Capital (strike × 100 × qty)">
              {capitalTerms.join(" + ")} = {usd(view.csp.capital)}
            </Metric>
            <Metric label="Total premium">{usd(view.csp.premium)}</Metric>
          </dl>
          <aside className="campaign-linked">
            <h3>Linked hedge</h3>
            <p>
              {scenarioHedges.length
                ? scenarioHedges.map((hedge) => hedge.underlying).join(", ")
                : "No linked hedge"}
            </p>
            <dl className="campaign-metrics">
              <Metric label="Debit">{usd(view.csp.hedgeDebit)}</Metric>
              <Metric label="Max payout">{usd(view.csp.hedgePayout)}</Metric>
            </dl>
          </aside>
          <div className="campaign-grid">
            <article className="campaign-scenario">
              <h3>No assignment</h3>
              <dl className="campaign-metrics">
                <Metric label="Net profit">{signedUsd(view.csp.noAssignment.netProfit)}</Metric>
                <Metric label="Period yield">
                  {percent(view.csp.noAssignment.periodYield, 2)}
                </Metric>
                <Metric label="Annualized">{percent(view.csp.noAssignment.annualized, 1)}</Metric>
                <Metric label="Term">{view.csp.noAssignment.term} days</Metric>
              </dl>
            </article>
            <article className="campaign-scenario">
              <h3>Assigned plus hedge</h3>
              <dl className="campaign-metrics">
                <Metric label="Cash">{signedUsd(view.csp.assigned.cash)}</Metric>
                <Metric label="Cash yield">{percent(view.csp.assigned.cashYield, 2)}</Metric>
                <Metric label="Assigned shares">{count(view.csp.assigned.shares)}</Metric>
                <Metric label="Basis before hedge">
                  {view.csp.assigned.basisBeforeHedge.map((basis) => usd(basis, 2)).join(" / ")}
                </Metric>
                <Metric label="Hedge cut">{usd(view.csp.assigned.hedgeCut, 2)}/sh</Metric>
                <Metric label="Effective basis">
                  {view.csp.assigned.effectiveBasis.map((basis) => usd(basis, 2)).join(" / ")}
                </Metric>
              </dl>
            </article>
          </div>
          <p className="campaign-note">
            Scenarios are gross, before fees. Assigned cash excludes share P/L and assumes maximum
            hedge payout. Effective basis is a campaign view, not tax basis.
          </p>
        </section>
      )}

      {view.coveredCalls.map((covered) => (
        <section
          key={covered.positionId}
          className="campaign-panel"
          aria-label={`${covered.underlying} covered call`}
        >
          <h2>{covered.underlying} covered call</h2>
          <dl className="campaign-metrics">
            <Metric label="Collateral">{usd(covered.collateral)}</Metric>
            <Metric label="Shares">{count(covered.shares)}</Metric>
            <Metric
              label={
                covered.basisSource === "assignment"
                  ? "Assigned share basis"
                  : "Opening share basis"
              }
            >
              {usd(covered.basis, 2)}
            </Metric>
            <Metric label="Adjusted share basis">{usd(covered.adjustedBasis, 2)}</Metric>
            <Metric label="Call strike">{usd(covered.strike, 2)}</Metric>
          </dl>
          <div className="campaign-grid">
            <article className="campaign-scenario">
              <h3>Not called</h3>
              <dl className="campaign-metrics">
                <Metric label="Premium kept">{usd(covered.premium)}</Metric>
                <Metric label="Adjusted share basis">{usd(covered.adjustedBasis, 2)}</Metric>
              </dl>
              <p>Shares remain held; future share P/L is not included.</p>
            </article>
            <article className="campaign-scenario">
              <h3>Called away</h3>
              <dl className="campaign-metrics">
                <Metric label="Called-away gain">{signedUsd(covered.calledAwayGain)}</Metric>
              </dl>
              <p>Gain at the call strike, including call premium, before fees.</p>
            </article>
          </div>
        </section>
      ))}

      {view.hedges.map((hedge) => (
        <section
          key={hedge.positionId}
          className="campaign-panel campaign-hedge"
          aria-label={`${hedge.underlying} hedge`}
        >
          <h2>{hedge.underlying} hedge</h2>
          <dl className="campaign-metrics">
            <Metric label="Debit">{usd(hedge.metrics.debit)}</Metric>
            <Metric label="Max payout">
              {hedge.maxPayout === null ? "Unlimited" : usd(hedge.maxPayout)}
            </Metric>
            <Metric label="Max profit">
              {hedge.metrics.maxProfit === "unlimited" ? "Unlimited" : usd(hedge.metrics.maxProfit)}
            </Metric>
            <Metric label="Breakeven">{usd(hedge.metrics.breakeven, 2)}</Metric>
            <Metric label="Return on risk">
              {hedge.metrics.returnOnRisk === null ? "—" : percent(hedge.metrics.returnOnRisk, 1)}
            </Metric>
          </dl>
        </section>
      ))}

      {view.swings.map((swing) => (
        <section
          key={swing.legId}
          className="campaign-panel campaign-swing"
          aria-label={`${swing.underlying} swing`}
        >
          <h2>{swing.underlying} swing</h2>
          <dl className="campaign-metrics">
            <Metric label="Quantity">
              {count(swing.quantity)} {swing.kind === "stock" ? "shares" : "contracts"}
            </Metric>
            <Metric label="Entry">{usd(swing.entry, 2)}</Metric>
            {swing.assignmentBasis !== undefined && (
              <Metric label="Assigned share basis">{usd(swing.assignmentBasis, 2)}</Metric>
            )}
            <Metric label="Mark">
              {swing.mark ? usd(swing.mark.price, 2) : "No mark recorded"}
            </Metric>
            <Metric label="Unrealized P/L">
              {swing.unrealized === null ? "—" : signedUsd(swing.unrealized)}
            </Metric>
          </dl>
          {swing.mark && (
            <p className="campaign-note">
              {swing.mark.source} mark · {swing.mark.asOf}
            </p>
          )}
          {onSaveMark && <MarkForm swing={swing} onSaveMark={onSaveMark} />}
          {swing.assignmentBasis !== undefined && (
            <div data-stock-leg-id={swing.legId} data-share-basis={swing.assignmentBasis}>
              <button
                type="button"
                disabled={!onSellCoveredCall || swing.quantity < 100}
                onClick={() => onSellCoveredCall?.(swing.legId)}
              >
                Sell covered call
              </button>
              {swing.quantity < 100 && <p>At least 100 open assigned shares are required.</p>}
            </div>
          )}
        </section>
      ))}

      <section className="campaign-panel" aria-label="Recorded timeline">
        <h2>Recorded timeline</h2>
        {realized.length > 0 && (
          <dl className="campaign-metrics">
            <Metric label="Total realized net P/L">
              {signedCents(sumMoney4(realized.map((allocation) => allocation.pnl)))}
            </Metric>
          </dl>
        )}
        {view.timeline.length === 0 && <p>No trades recorded.</p>}
        <ol className="campaign-timeline">
          {view.timeline.map((event) => {
            const allocation = realizedByTrade.get(event.trade.id);
            return (
              <li className="campaign-event" key={event.trade.id} data-action={event.trade.action}>
                <time dateTime={event.trade.tradeDate}>{event.trade.tradeDate}</time>
                <div>
                  <strong>
                    {event.underlying} {event.side} {event.kind} · {event.trade.action}
                  </strong>
                  <p>
                    {count(event.trade.quantity)} {event.kind === "stock" ? "shares" : "contracts"}{" "}
                    at {usd(event.trade.price, 2)} · Cash {signedUsd(event.trade.cash)} · Fees{" "}
                    {usd(event.trade.fees, 2)}
                  </p>
                  {allocation && <p>Realized net P/L {signedCents(allocation.pnl)}</p>}
                  {event.assignment && (
                    <p>
                      Assignment linked: {count(event.assignment.shares)} shares · premium{" "}
                      {usd(event.assignment.premiumPerShare, 2)}/sh
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      </section>
    </div>
  );
}
