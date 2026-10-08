import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CampaignResponse } from "../../domain/campaign.ts";
import { parseIsoDate as d } from "../../domain/dates.ts";
import { parseMoney4 as m } from "../../domain/money.ts";
import { nvdlCampaign } from "../../domain/test/campaignFixtures.ts";
import { RollTimeline } from "./RollTimeline.tsx";

const original = nvdlCampaign.positions[0];
if (!original) throw new Error("Missing position");
const campaign: CampaignResponse = {
  ...nvdlCampaign,
  positions: [
    {
      ...original,
      id: "old",
      rollChainId: "chain",
      underlying: "TQQQ",
      closedOn: d("2026-09-24"),
      legs: [
        {
          id: "old-leg",
          kind: "put",
          side: "short",
          underlying: "TQQQ",
          strike: m("58"),
          expiry: d("2026-09-25"),
          multiplier: 100,
          adjusted: false,
          mark: null,
          trades: [
            {
              id: "old-open",
              action: "open",
              tradeDate: d("2026-08-28"),
              quantity: 20,
              price: m("1.70"),
              cash: m("3400"),
              fees: m("-6.60"),
            },
            {
              id: "old-close",
              action: "close",
              tradeDate: d("2026-09-24"),
              quantity: 20,
              price: m("2.10"),
              cash: m("-4200"),
              fees: m("-6.60"),
              rollId: "roll",
            },
          ],
        },
      ],
    },
    {
      ...original,
      id: "new",
      rollChainId: "chain",
      underlying: "TQQQ",
      openedOn: d("2026-09-24"),
      legs: [
        {
          id: "new-leg",
          kind: "put",
          side: "short",
          underlying: "TQQQ",
          strike: m("55"),
          expiry: d("2026-10-23"),
          multiplier: 100,
          adjusted: false,
          mark: null,
          trades: [
            {
              id: "new-open",
              action: "open",
              tradeDate: d("2026-09-24"),
              quantity: 20,
              price: m("2.45"),
              cash: m("4900"),
              fees: m("0"),
              rollId: "roll",
            },
          ],
        },
      ],
    },
    ...nvdlCampaign.positions.slice(1),
  ],
  rolls: [{ id: "roll", rollChainId: "chain", rolledOn: d("2026-09-24") }],
};
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("RollTimeline", () => {
  it("groups chain positions, sums only their option cash and fees, and labels gross/net", () => {
    const html = renderToStaticMarkup(<RollTimeline campaign={campaign} />);
    expect(text(html)).toContain("Chain cash gross +$4,100.00");
    expect(text(html)).toContain("Chain fees −$13.20");
    expect(text(html)).toContain("Chain cash net +$4,086.80");
    expect(text(html)).toContain("Realized gross −$800.00");
    expect(text(html)).toContain("Realized net −$813.20");
    expect(text(html)).toContain("Booked in 2026-09");
    expect(text(html)).toContain("Roll recorded 2026-09-24");
    expect(html.match(/aria-label="Roll chain /g)).toHaveLength(1);
    expect(text(html)).not.toContain("NVDA");
  });

  it("uses weighted preceding opens and prior partial closes rather than latest entry price", () => {
    const old = campaign.positions[0];
    const leg = old?.legs[0];
    if (!old || !leg) throw new Error("Missing old position");
    const partial: CampaignResponse = {
      ...campaign,
      positions: [
        {
          ...old,
          legs: [
            {
              ...leg,
              trades: [
                {
                  id: "open1",
                  action: "open",
                  tradeDate: d("2026-09-01"),
                  quantity: 10,
                  price: m("2"),
                  cash: m("2000"),
                  fees: m("-5"),
                },
                {
                  id: "open2",
                  action: "open",
                  tradeDate: d("2026-09-02"),
                  quantity: 10,
                  price: m("3"),
                  cash: m("3000"),
                  fees: m("-5"),
                },
                {
                  id: "partial",
                  action: "close",
                  tradeDate: d("2026-09-03"),
                  quantity: 5,
                  price: m("1"),
                  cash: m("-500"),
                  fees: m("-2"),
                },
                {
                  id: "roll-close",
                  action: "close",
                  tradeDate: d("2026-10-01"),
                  quantity: 15,
                  price: m("3.19"),
                  cash: m("-4785"),
                  fees: m("-9.75"),
                  rollId: "roll",
                },
              ],
            },
          ],
        },
      ],
    };
    const html = text(renderToStaticMarkup(<RollTimeline campaign={partial} />));
    expect(html).toContain("Realized gross −$1,035.00");
    expect(html).toContain("Realized net −$1,052.25");
    expect(html).toContain("Booked in 2026-10");
  });

  it("orders repeated same-day rolls by linked closes and opens, not position UUID order", () => {
    const old = campaign.positions[0];
    const replacement = campaign.positions[1];
    const oldLeg = old?.legs[0];
    const replacementLeg = replacement?.legs[0];
    if (!old || !replacement || !oldLeg || !replacementLeg)
      throw new Error("Missing chain fixtures");
    const sameDay: CampaignResponse = {
      ...campaign,
      positions: [
        {
          ...replacement,
          id: "a-final",
          legs: [
            {
              ...replacementLeg,
              id: "final-leg",
              trades: [
                {
                  ...replacementLeg.trades[0],
                  id: "final-open",
                  action: "open",
                  tradeDate: d("2026-09-24"),
                  quantity: 20,
                  price: m("3.54"),
                  cash: m("7080"),
                  fees: m("0"),
                  rollId: "second-roll",
                },
              ],
            },
          ],
        },
        { ...old, id: "root" },
        {
          ...replacement,
          id: "z-intermediate",
          closedOn: d("2026-09-24"),
          legs: [
            {
              ...replacementLeg,
              trades: [
                ...replacementLeg.trades,
                {
                  id: "intermediate-close",
                  action: "close",
                  tradeDate: d("2026-09-24"),
                  quantity: 20,
                  price: m("3.19"),
                  cash: m("-6380"),
                  fees: m("0"),
                  rollId: "second-roll",
                },
              ],
            },
          ],
        },
      ],
    };
    const html = renderToStaticMarkup(<RollTimeline campaign={sameDay} />);
    const rows = [...html.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((match) =>
      text(match[1] ?? ""),
    );
    expect(rows).toHaveLength(5);
    expect(rows.map((row) => /contracts @ ([^ ]+)/.exec(row)?.[1])).toEqual([
      "$1.70",
      "$2.10",
      "$2.45",
      "$3.19",
      "$3.54",
    ]);
  });

  it("omits an empty timeline without inferring a roll from ordinary closes", () => {
    const html = renderToStaticMarkup(<RollTimeline campaign={nvdlCampaign} />);
    expect(html).toBe("");
  });
});
