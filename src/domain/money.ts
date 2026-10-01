declare const money4: unique symbol;

/** Integer count of 1/10,000 USD. Matches the `numeric(14,4)` and `numeric(12,4)` columns. */
export type Money4 = number & { readonly [money4]: true };

const SCALE = 10_000;
const MONEY_PATTERN = /^(-)?(\d+)(?:\.(\d{1,4}))?$/;

/** Parses a plain decimal string such as `26.67` or `-0.6527`; more than four decimals is an error. */
export function parseMoney4(input: string): Money4 {
  const match = MONEY_PATTERN.exec(input);
  if (!match)
    throw new RangeError(`Not a USD amount with at most 4 decimals: ${JSON.stringify(input)}`);
  const [, sign, whole = "", fraction = ""] = match;
  const units = Number(whole) * SCALE + Number(fraction.padEnd(4, "0"));
  if (!Number.isSafeInteger(units)) throw new RangeError(`USD amount out of range: ${input}`);
  return (sign && units !== 0 ? -units : units) as Money4;
}

/** Plain digits with no `$` or grouping; rounds half away from zero when `decimals` is below 4. */
export function formatMoney4(amount: Money4, decimals: 0 | 2 | 4 = 4): string {
  const unit = 10 ** (4 - decimals);
  const rounded = Math.floor((Math.abs(amount) * 2 + unit) / (2 * unit));
  const scale = 10 ** decimals;
  const whole = Math.floor(rounded / scale);
  const fraction = decimals === 0 ? "" : `.${String(rounded % scale).padStart(decimals, "0")}`;
  return `${amount < 0 && rounded !== 0 ? "-" : ""}${whole}${fraction}`;
}

export const addMoney4 = (a: Money4, b: Money4): Money4 => (a + b) as Money4;
export const subMoney4 = (a: Money4, b: Money4): Money4 => (a - b) as Money4;
export const negMoney4 = (a: Money4): Money4 => (a === 0 ? a : -a) as Money4;
export const absMoney4 = (a: Money4): Money4 => Math.abs(a) as Money4;

export function sumMoney4(amounts: readonly Money4[]): Money4 {
  return amounts.reduce(addMoney4, 0 as Money4);
}

/** Scales by a whole number: contracts times multiplier, shares, and the like. */
export const mulMoney4 = (a: Money4, factor: number): Money4 => (a * factor) as Money4;

/** Divides by a whole number, rounding half away from zero to 1/10,000. */
export function divMoney4(a: Money4, divisor: number): Money4 {
  if (divisor === 0) throw new RangeError("Cannot divide an amount by zero");
  const numerator = BigInt(a);
  const denominator = BigInt(divisor);
  const magnitude = (n: bigint) => (n < 0n ? -n : n);
  const quotient =
    (2n * magnitude(numerator) + magnitude(denominator)) / (2n * magnitude(denominator));
  return Number(numerator < 0n !== denominator < 0n ? -quotient : quotient) as Money4;
}

/** A dimensionless ratio of two amounts, for yields and percentages. */
export function ratio(numerator: Money4, denominator: Money4): number {
  if (denominator === 0) throw new RangeError("Cannot take a ratio over a zero amount");
  return numerator / denominator;
}
