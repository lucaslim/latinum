import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { parseIsoDate } from "../../domain/dates.ts";
import { TradeForm } from "./TradeForm.tsx";

vi.mock("../../domain/calendar.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../domain/calendar.ts")>()),
  FIRST_YEAR: 2025,
  LAST_YEAR: 2031,
}));

it("reads the expiry warning range from the calendar exports", () => {
  const html = renderToStaticMarkup(
    <TradeForm
      asOf={parseIsoDate("2029-01-02")}
      options={{ tickers: [], tags: [], assignedStock: [] }}
      onSaved={() => {}}
      onCancel={() => {}}
    />,
  );
  expect(html).toContain("coverage: 2025–2031");
});
