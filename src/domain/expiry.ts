import { isTradingDay, lastTradingDayOnOrBefore } from "./calendar.ts";
import { dayNumber, fromDayNumber, type IsoDate, weekday } from "./dates.ts";

export function expiryChips(asOf: IsoDate): { date: IsoDate; monthly: boolean }[] {
  // Validate the starting date too: seven covered expiries cannot legitimize an uncovered opening.
  isTradingDay(asOf);
  const chips: { date: IsoDate; monthly: boolean }[] = [];
  let friday = dayNumber(asOf) + ((5 - weekday(asOf) + 7) % 7 || 7);
  while (chips.length < 7) {
    const nominal = fromDayNumber(friday);
    const date = lastTradingDayOnOrBefore(nominal);
    if (date > asOf) {
      const dayOfMonth = new Date(`${nominal}T00:00:00Z`).getUTCDate();
      chips.push({ date, monthly: dayOfMonth >= 15 && dayOfMonth <= 21 });
    }
    friday += 7;
  }
  return chips;
}
