import { describe, expect, it } from "vitest";
import { realizedLeg, type Trade, type TradeAction } from "./pnl.ts";
import { d, m } from "./test/fixtures.ts";

const trade = <A extends TradeAction>(
  action: A,
  date: string,
  cash: string,
  fees: string,
): Trade<A> => ({
  action,
  date: d(date),
  cash: m(cash),
  fees: m(fees),
});

describe("realized P/L net of fees", () => {
  it("MUU 25P x10 expired: 1,500 - 6.60 = 1,493.40", () => {
    const r = realizedLeg(
      [trade("open", "2026-09-04", "1500", "-6.60")],
      trade("expire", "2026-09-11", "0", "0"),
    );
    expect(r.pnl).toBe(m("1493.40"));
    expect(r.bookedMonth).toBe("2026-09");
  });

  it("SPXL 240P x2 sold 3.10, bought back 0.40: 540 - 2.60 = 537.40", () => {
    const r = realizedLeg(
      [trade("open", "2026-09-04", "620", "-1.30")],
      trade("close", "2026-09-11", "-80", "-1.30"),
    );
    expect(r.pnl).toBe(m("537.40"));
  });

  it("DRAM 55P x15 assigned: 3,000 - 9.90 = 2,990.10, booked in the assignment month (D3)", () => {
    const r = realizedLeg(
      [trade("open", "2026-08-21", "3000", "-9.90")],
      trade("assign", "2026-09-18", "0", "0"),
    );
    expect(r.pnl).toBe(m("2990.10"));
    expect(r.bookedMonth).toBe("2026-09");
  });

  it("a rolled leg books in its close month (D4), not its open month", () => {
    const r = realizedLeg(
      [trade("open", "2026-08-28", "3400", "0")],
      trade("close", "2026-09-24", "-4200", "0"),
    );
    expect(r.pnl).toBe(m("-800"));
    expect(r.bookedMonth).toBe("2026-09");
  });
});
