import { dayNumber, fromDayNumber, type IsoDate, parseIsoDate, weekday } from "./dates.ts";

/**
 * NYSE hours-calendars page, fetched 2026-10-01. Holidays that fall on a Saturday are not
 * observed on the Friday (2028-01-01), so they are absent. The page's 2028 summary dropped
 * Tuesday 2028-07-04; it is a holiday, with the 07-03 early close beside it.
 */
const TABLE: Record<number, { holidays: readonly string[]; earlyCloses: readonly string[] }> = {
  2026: {
    holidays: [
      "2026-01-01",
      "2026-01-19",
      "2026-02-16",
      "2026-04-03",
      "2026-05-25",
      "2026-06-19",
      "2026-07-03",
      "2026-09-07",
      "2026-11-26",
      "2026-12-25",
    ],
    earlyCloses: ["2026-11-27", "2026-12-24"],
  },
  2027: {
    holidays: [
      "2027-01-01",
      "2027-01-18",
      "2027-02-15",
      "2027-03-26",
      "2027-05-31",
      "2027-06-18",
      "2027-07-05",
      "2027-09-06",
      "2027-11-25",
      "2027-12-24",
    ],
    earlyCloses: ["2027-11-26"],
  },
  2028: {
    holidays: [
      "2028-01-17",
      "2028-02-21",
      "2028-04-14",
      "2028-05-29",
      "2028-06-19",
      "2028-07-04",
      "2028-09-04",
      "2028-11-23",
      "2028-12-25",
    ],
    earlyCloses: ["2028-07-03", "2028-11-24"],
  },
};

const years = Object.keys(TABLE).map(Number);
const FIRST_YEAR = Math.min(...years);
const LAST_YEAR = Math.max(...years);

const holidays = new Set(Object.values(TABLE).flatMap((y) => y.holidays.map(parseIsoDate)));
const earlyCloses = new Set(Object.values(TABLE).flatMap((y) => y.earlyCloses.map(parseIsoDate)));

/** Throws outside the table: a wrong "open" answer is worse than a loud stop. */
function assertCovered(date: IsoDate): void {
  const year = new Date(`${date}T00:00:00Z`).getUTCFullYear();
  if (year < FIRST_YEAR || year > LAST_YEAR) {
    throw new RangeError(
      `NYSE calendar covers ${FIRST_YEAR}-${LAST_YEAR}; add ${year} to src/domain/calendar.ts`,
    );
  }
}

export function isTradingDay(date: IsoDate): boolean {
  assertCovered(date);
  const day = weekday(date);
  return day !== 0 && day !== 6 && !holidays.has(date);
}

export function isEarlyClose(date: IsoDate): boolean {
  assertCovered(date);
  return earlyCloses.has(date);
}

/** Trading days in `(from, to]`; 0 when `to` is not after `from`. */
export function tradingDaysBetween(from: IsoDate, to: IsoDate): number {
  let count = 0;
  for (let day = dayNumber(from) + 1; day <= dayNumber(to); day++) {
    if (isTradingDay(fromDayNumber(day))) count++;
  }
  return count;
}

export const businessDte = (expiry: IsoDate, today: IsoDate): number =>
  tradingDaysBetween(today, expiry);

/** Expiry that falls on a closed day moves to the prior session (Good Friday expires Thursday). */
export function lastTradingDayOnOrBefore(date: IsoDate): IsoDate {
  let day = dayNumber(date);
  while (!isTradingDay(fromDayNumber(day))) day--;
  return fromDayNumber(day);
}
