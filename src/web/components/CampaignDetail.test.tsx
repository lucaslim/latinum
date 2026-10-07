import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App.tsx";
import * as campaignApi from "../campaignApi.ts";
import { fetchCampaign, saveManualMark } from "../campaignApi.ts";

vi.mock("./ThemeSelect.tsx", () => ({ ThemeSelect: () => null }));

import type { CampaignResponse } from "../../domain/campaign.ts";
import {
  aaplCampaign as aapl,
  crwdCampaign,
  dramAssignedCampaign,
  dramCampaign,
  nvdlCampaign,
} from "../../domain/test/campaignFixtures.ts";
import { d, m } from "../../domain/test/fixtures.ts";
import { CampaignDetail } from "./CampaignDetail.tsx";

const render = (campaign: CampaignResponse) =>
  renderToStaticMarkup(<CampaignDetail campaign={campaign} onSaveMark={async () => {}} />);
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Hash routes", () => {
  it("renders campaign load errors with a retry and a hash-only Back link", () => {
    vi.stubGlobal("window", { location: { hash: "#/campaigns/missing" } });
    const hook = vi.spyOn(campaignApi, "useCampaign").mockReturnValue({
      load: { status: "error", message: "Could not load campaign (HTTP 404)" },
      retry: vi.fn(),
      saveMark: vi.fn(),
    });
    const html = renderToStaticMarkup(<App />);
    expect(html).toContain('<p role="alert">Could not load campaign (HTTP 404)</p>');
    expect(text(html)).toContain("Retry campaign");
    expect(text(html)).toContain("Back to positions");
    expect(hook).toHaveBeenCalledWith("missing");
  });
  it("renders ready campaign data rather than fetching or rendering the Sheet", () => {
    vi.stubGlobal("window", { location: { hash: "#/campaigns/aapl-campaign" } });
    vi.spyOn(campaignApi, "useCampaign").mockReturnValue({
      load: { status: "ready", data: aapl },
      retry: vi.fn(),
      saveMark: vi.fn(),
    });
    const html = renderToStaticMarkup(<App />);
    expect(html).toContain("AAPL long call campaign");
    expect(text(html)).toContain("Unrealized P/L −$270");
    expect(html).not.toContain('data-testid="sheet-table"');
  });
  it("opens a direct campaign hash in the campaign loading state", () => {
    vi.stubGlobal("window", {
      location: { hash: "#/campaigns/00000000-0000-4000-8000-000000000001" },
    });
    const html = renderToStaticMarkup(<App />);
    expect(text(html)).toContain("Loading campaign…");
    expect(text(html)).not.toContain("Loading positions…");
    expect(html).toContain('href="#/"');
  });
  it("opens the positions hash in the Sheet loading state", () => {
    vi.stubGlobal("window", { location: { hash: "#/" } });
    const html = renderToStaticMarkup(<App />);
    expect(text(html)).toContain("Loading positions…");
    expect(html).toContain('href="#/"');
  });
});

describe("Campaign transport", () => {
  it("loads the encoded campaign URL without cache and forwards its abort signal", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(aapl)));
    vi.stubGlobal("fetch", fetchMock);
    const signal = new AbortController().signal;
    expect(await fetchCampaign("aapl/campaign", signal)).toEqual(aapl);
    expect(fetchMock).toHaveBeenCalledWith("/api/campaigns/aapl%2Fcampaign", {
      signal,
      cache: "no-store",
    });
  });
  it("PUTs decimal strings without converting them to floating point", async () => {
    const response = { legId: "aapl-leg", price: 51000, asOf: "2026-10-01", source: "manual" };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(response)));
    vi.stubGlobal("fetch", fetchMock);
    const signal = new AbortController().signal;
    expect(await saveManualMark("aapl-leg", { price: "5.1000" }, signal)).toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith("/api/legs/aapl-leg/mark", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: '{"price":"5.1000"}',
      signal,
    });
  });
  it("surfaces load and mark HTTP errors at the boundary", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
    const signal = new AbortController().signal;
    await expect(fetchCampaign("missing", signal)).rejects.toThrow(
      "Could not load campaign (HTTP 404)",
    );
    await expect(
      saveManualMark("missing", { price: "1.00", asOf: "2026-10-01" }, signal),
    ).rejects.toThrow("Could not save mark (HTTP 404)");
  });
});

describe("Campaign detail", () => {
  it("renders a read-only campaign without offering a mark save callback", () => {
    const html = renderToStaticMarkup(<CampaignDetail campaign={aapl} />);
    expect(text(html)).toContain("Unrealized P/L −$270");
    expect(html).not.toContain("Save mark for AAPL");
  });
  it("renders unlimited long-call hedge values without inventing a finite return", () => {
    const campaign: CampaignResponse = {
      ...aapl,
      positions: aapl.positions.map((position) => ({ ...position, role: "hedge" })),
    };
    const output = text(render(campaign));
    expect(output).toContain("AAPL hedge");
    expect(output).toContain("Max payout Unlimited");
    expect(output).toContain("Max profit Unlimited");
    expect(output).toContain("Return on risk —");
  });
  it("renders an empty recorded campaign without inventing any event", () => {
    const html = render({ ...aapl, positions: [] });
    expect(text(html)).toContain("No trades recorded.");
    expect(html).not.toContain('class="campaign-event"');
    expect(html).not.toContain("Save mark");
  });
  it("shows every NVDL scenario fixture number with an explicit capital formula", () => {
    const output = text(render(nvdlCampaign));
    expect(output).toContain("NVDL puts + NVDA hedge campaign");
    expect(output).toContain("$75.00 × 100 × 5 + $70.00 × 100 × 5 = $72,500");
    expect(output).toContain("Total premium $2,350");
    expect(output).toContain("Linked hedge");
    expect(output).toContain("NVDA");
    expect(output).toContain("Debit $218");
    expect(output).toContain("Max payout $1,000");
    expect(output).toContain("No assignment");
    expect(output).toContain("Net profit +$2,132");
    expect(output).toContain("Period yield 2.94%");
    expect(output).toContain("Annualized 34.6%");
    expect(output).toContain("Term 31 days");
    expect(output).toContain("Assigned plus hedge");
    expect(output).toContain("Cash +$3,132");
    expect(output).toContain("Cash yield 4.32%");
    expect(output).toContain("Assigned shares 1,000");
    expect(output).toContain("Basis before hedge $72.20 / $68.10");
    expect(output).toContain("Hedge cut $0.78/sh");
    expect(output).toContain("Effective basis $71.42 / $67.32");
  });
  it("labels the synthetic DRAM basis truthfully and shows both covered-call scenarios", () => {
    const html = render(dramCampaign);
    const output = text(html);
    expect(output).toContain("Opening share basis $53.00");
    expect(output).toContain("Adjusted share basis $51.90");
    expect(output).toContain("Collateral $82,500");
    expect(output).toContain("Shares 1,500");
    expect(output).toContain("Not called");
    expect(output).toContain("Premium kept $1,650");
    expect(output).toContain("Called away");
    expect(output).toContain("Called-away gain +$4,650");
    expect(html).not.toContain('data-action="assign"');
    expect(output).not.toContain("Assigned share basis");
    expect(html.match(/class="campaign-event"/g)).toHaveLength(2);
  });
  it("shows the recorded assignment wheel without treating the closed put as an open scenario", () => {
    const html = render(dramAssignedCampaign);
    const output = text(html);
    expect(output).toContain("Assigned share basis $53.00");
    expect(output).toContain("Adjusted share basis $51.90");
    expect(html).toContain('data-action="assign"');
    expect(output).toContain("Assignment linked: 1,500 shares");
    expect(output).toContain("premium $2.00/sh");
    expect(html.match(/class="campaign-event"/g)).toHaveLength(4);
    expect(html).not.toContain('aria-label="Cash-secured put scenarios"');
    const timeline = html.slice(html.indexOf('<ol class="campaign-timeline"'));
    expect(timeline.indexOf('dateTime="2026-07-01"')).toBeLessThan(
      timeline.indexOf('dateTime="2026-07-31"'),
    );
    expect(timeline.indexOf('dateTime="2026-07-31"')).toBeLessThan(
      timeline.indexOf('dateTime="2026-09-18"'),
    );
  });
  it("renders a standalone hedge with debit, payout, profit, breakeven and return on risk", () => {
    const campaign = {
      ...nvdlCampaign,
      title: "NVDA",
      positions: nvdlCampaign.positions.filter((p) => p.role === "hedge"),
    };
    const output = text(render(campaign));
    expect(output).toContain("NVDA hedge");
    expect(output).toContain("Debit $218");
    expect(output).toContain("Max payout $1,000");
    expect(output).toContain("Max profit $782");
    expect(output).toContain("Breakeven $178.91");
    expect(output).toContain("Return on risk 358.7%");
  });
  it("renders CRWD shares and explicit positive unrealized USD", () => {
    const html = render(crwdCampaign);
    const output = text(html);
    expect(output).toContain("Entry $455.20");
    expect(output).toContain("Mark $471.30");
    expect(output).toContain("Quantity 50 shares");
    expect(output).toContain("Unrealized P/L +$805");
    expect(html).toContain('aria-label="Mark price for CRWD"');
    expect(output).toContain("Save mark for CRWD");
  });
  it("keeps closed swing legs and fills in the timeline but not in active cards", () => {
    const campaign: CampaignResponse = {
      ...aapl,
      closedOn: d("2026-10-01"),
      positions: aapl.positions.map((p) => ({
        ...p,
        closedOn: d("2026-10-01"),
        legs: p.legs.map((leg) => ({
          ...leg,
          trades: [
            ...leg.trades,
            {
              id: "aapl-close",
              action: "close",
              tradeDate: d("2026-10-01"),
              quantity: 1,
              price: m("5.10"),
              cash: m("510"),
              fees: m("0"),
            },
          ],
        })),
      })),
    };
    const html = render(campaign);
    expect(html).toContain('data-action="close"');
    expect(text(html)).toContain("AAPL long call");
    expect(html).not.toContain('aria-label="AAPL swing"');
    expect(html).not.toContain("Save mark for AAPL");
    expect(html.match(/class="campaign-event"/g)).toHaveLength(2);
  });
  it("keeps unsupported stored strategies visible as recorded legs and events", () => {
    const campaign: CampaignResponse = {
      ...aapl,
      positions: aapl.positions.map((position) => ({ ...position, strategy: "day_trade" })),
    };
    const html = render(campaign);
    expect(text(html)).toContain("day_trade");
    expect(text(html)).toContain("Recorded legs");
    expect(text(html)).toContain("AAPL long call");
    expect(text(html)).toContain("Scenario cards are not available for this recorded strategy.");
    expect(html.match(/class="campaign-event"/g)).toHaveLength(1);
  });
  it("renders the recorded AAPL leg, entry, mark, loss and accessible mark controls", () => {
    const html = render(aapl);
    expect(html).toContain("<h1>AAPL long call campaign</h1>");
    expect(text(html)).toContain("Entry $7.80");
    expect(text(html)).toContain("Mark $5.10");
    expect(text(html)).toContain("Unrealized P/L −$270");
    expect(html).toContain('aria-label="Mark price for AAPL"');
    expect(text(html)).toContain("Save mark for AAPL");
    expect(html).toContain('dateTime="2026-09-10"');
    expect(text(html)).toContain("AAPL long call");
    expect(text(html)).toContain("open");
  });
  it("does not invent a mark or P/L when no mark is recorded", () => {
    const campaign = {
      ...aapl,
      positions: aapl.positions.map((position) => ({
        ...position,
        legs: position.legs.map((leg) => ({ ...leg, mark: null })),
      })),
    };
    const output = text(render(campaign));
    expect(output).toContain("No mark recorded");
    expect(output).toContain("Unrealized P/L —");
    expect(output).not.toContain("−$270");
  });
});
