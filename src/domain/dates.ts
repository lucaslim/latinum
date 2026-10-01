declare const isoDate: unique symbol;

/** A calendar date, `YYYY-MM-DD`. Trade dates and expiries are America/New_York dates. */
export type IsoDate = string & { readonly [isoDate]: true };

const MS_PER_DAY = 86_400_000;
const ISO_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseIsoDate(input: string): IsoDate {
  const match = ISO_PATTERN.exec(input);
  const [year, month, day] = (match?.slice(1) ?? []).map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    throw new RangeError(`Not a YYYY-MM-DD date: ${JSON.stringify(input)}`);
  }
  const roundTrip = new Date(Date.UTC(year, month - 1, day));
  if (roundTrip.toISOString().slice(0, 10) !== input) {
    throw new RangeError(`Not a real calendar date: ${input}`);
  }
  return input as IsoDate;
}

/** Whole days since 1970-01-01, so that day arithmetic never meets a DST shift. */
export function dayNumber(date: IsoDate): number {
  return Date.parse(`${date}T00:00:00Z`) / MS_PER_DAY;
}

export function fromDayNumber(day: number): IsoDate {
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10) as IsoDate;
}

/** 0 is Sunday. */
export function weekday(date: IsoDate): number {
  return new Date(dayNumber(date) * MS_PER_DAY).getUTCDay();
}

const newYorkParts = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** "Today" for DTE. Never derive it from SQL `CURRENT_DATE` or the server's own zone. */
export function todayNY(now: Date): IsoDate {
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    newYorkParts.formatToParts(now).find((p) => p.type === type)?.value;
  return parseIsoDate(`${part("year")}-${part("month")}-${part("day")}`);
}

const daysBetween = (from: IsoDate, to: IsoDate) => dayNumber(to) - dayNumber(from);

/** Calendar days to expiry; negative once expired. */
export const dte = (expiry: IsoDate, today: IsoDate): number => daysBetween(today, expiry);

/** Calendar days from open to expiry, the denominator for annualizing. */
export const term = (openedOn: IsoDate, expiry: IsoDate): number => daysBetween(openedOn, expiry);
