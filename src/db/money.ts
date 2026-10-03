import { customType } from "drizzle-orm/pg-core";
import { formatMoney4, type Money4, parseMoney4 } from "../domain/money.ts";

export const moneyColumn = customType<{
  data: Money4;
  driverData: string;
  config: { precision: 12 | 14 };
}>({
  dataType: ({ precision } = { precision: 14 }) => `numeric(${precision},4)`,
  toDriver: (value) => formatMoney4(value),
  fromDriver: (value) => parseMoney4(value),
});
