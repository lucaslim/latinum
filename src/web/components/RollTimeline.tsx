import type { CampaignResponse } from "../../domain/campaign.ts";
import { allocateRealizedTrades } from "../../domain/lifecyclePnl.ts";
import { addMoney4, type Money4, subMoney4, sumMoney4 } from "../../domain/money.ts";
import { usd } from "../format.ts";
import "./roll.css";

const signed = (value: Money4) => `${value >= 0 ? "+" : ""}${usd(value, 2)}`;

export function RollTimeline({ campaign }: { campaign: CampaignResponse }) {
  const chainIds = [
    ...new Set(
      campaign.positions.flatMap((position) =>
        position.rollChainId == null ? [] : [position.rollChainId],
      ),
    ),
  ];
  if (chainIds.length === 0) return null;
  return (
    <section className="campaign-panel roll-timeline" aria-label="Roll chains">
      <h2>Roll chains</h2>
      {chainIds.map((chainId) => {
        const positions = campaign.positions.filter((position) => position.rollChainId === chainId);
        const events = positions
          .flatMap((position) =>
            position.legs
              .filter((leg) => leg.kind !== "stock")
              .flatMap((leg) => {
                const allocations = new Map(
                  allocateRealizedTrades(
                    leg.trades.map((trade) => ({ ...trade, date: trade.tradeDate })),
                  ).map((allocation) => [allocation.tradeId, allocation]),
                );
                return leg.trades.map((trade) => ({
                  position,
                  leg,
                  trade,
                  allocation: allocations.get(trade.id),
                }));
              }),
          )
          .sort((a, b) => a.trade.tradeDate.localeCompare(b.trade.tradeDate));
        const groupKey = ({ position, trade }: (typeof events)[number]) =>
          `${position.id}:${trade.tradeDate}:${trade.action}:${trade.rollId ?? trade.id}`;
        const groups = Map.groupBy(events, groupKey);
        const successors = new Map([...groups.keys()].map((key) => [key, new Set<string>()]));
        const incoming = new Map([...groups.keys()].map((key) => [key, 0]));
        const link = (before: string, after: string) => {
          if (before === after) return;
          const next = successors.get(before);
          const count = incoming.get(after);
          if (!next || count === undefined) throw new Error("Missing roll timeline group");
          if (!next.has(after)) {
            next.add(after);
            incoming.set(after, count + 1);
          }
        };
        // Same-day position UUID order is arbitrary; preserve leg order and close→open roll links.
        for (const legEvents of Map.groupBy(events, ({ leg }) => leg.id).values()) {
          for (let i = 1; i < legEvents.length; i++) {
            const before = legEvents[i - 1];
            const after = legEvents[i];
            if (!before || !after) throw new Error("Missing leg timeline event");
            link(groupKey(before), groupKey(after));
          }
        }
        for (const rollEvents of Map.groupBy(
          events.filter(({ trade }) => trade.rollId != null),
          ({ trade }) => trade.rollId,
        ).values()) {
          const closes = rollEvents.filter(({ trade }) => trade.action === "close");
          const opens = rollEvents.filter(({ trade }) => trade.action === "open");
          for (const close of closes)
            for (const open of opens) link(groupKey(close), groupKey(open));
        }
        const ordered: [string, typeof events][] = [];
        while (incoming.size > 0) {
          const next = [...groups].find(([key]) => incoming.get(key) === 0);
          if (!next) throw new Error("Cyclic roll timeline links");
          ordered.push(next);
          incoming.delete(next[0]);
          for (const key of successors.get(next[0]) ?? []) {
            const count = incoming.get(key);
            if (count === undefined) throw new Error("Roll timeline successor already ordered");
            incoming.set(key, count - 1);
          }
        }
        const gross = sumMoney4(events.map(({ trade }) => trade.cash));
        const fees = sumMoney4(events.map(({ trade }) => trade.fees));
        return (
          <section key={chainId} aria-label={`Roll chain ${chainId}`}>
            <h3>{positions[0]?.underlying} chain</h3>
            <dl>
              <div>
                <dt>Chain cash gross</dt>
                <dd>{signed(gross)}</dd>
              </div>
              <div>
                <dt>Chain fees</dt>
                <dd>{signed(fees)}</dd>
              </div>
              <div>
                <dt>Chain cash net</dt>
                <dd>{signed(addMoney4(gross, fees))}</dd>
              </div>
            </dl>
            {campaign.rolls
              ?.filter((roll) => roll.rollChainId === chainId)
              .map((roll) => (
                <p key={roll.id}>Roll recorded {roll.rolledOn}</p>
              ))}
            <ol>
              {ordered.map(([key, group]) => {
                const first = group[0];
                if (!first) throw new Error("Empty roll event group");
                const cash = sumMoney4(group.map(({ trade }) => trade.cash));
                const eventFees = sumMoney4(group.map(({ trade }) => trade.fees));
                const realized = group.flatMap(({ trade, allocation }) =>
                  allocation
                    ? [
                        {
                          net: allocation.pnl,
                          gross: subMoney4(
                            subMoney4(allocation.pnl, allocation.openingFees),
                            trade.fees,
                          ),
                          month: allocation.bookedMonth,
                        },
                      ]
                    : [],
                );
                return (
                  <li key={key}>
                    <strong>
                      {first.trade.tradeDate} · {first.trade.action} · {first.position.underlying}
                    </strong>
                    <p>
                      {group
                        .map(
                          ({ leg, trade }) =>
                            `${leg.side} ${leg.kind} ${leg.strike === null ? "" : usd(leg.strike, 2)} · ${leg.expiry} · ${trade.quantity} contracts @ ${usd(trade.price, 2)}`,
                        )
                        .join(" / ")}
                    </p>
                    <p>
                      Cash gross {signed(cash)} · Fees {signed(eventFees)} · Cash net{" "}
                      {signed(addMoney4(cash, eventFees))}
                    </p>
                    {realized.length > 0 && (
                      <p>
                        Realized gross {signed(sumMoney4(realized.map((value) => value.gross)))} ·
                        Realized net {signed(sumMoney4(realized.map((value) => value.net)))} ·
                        Booked in {realized[0]?.month}
                      </p>
                    )}
                  </li>
                );
              })}
            </ol>
          </section>
        );
      })}
    </section>
  );
}
