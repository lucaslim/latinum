import { afterAll, beforeAll, expect, test } from "vitest";
import { testDatabase } from "./test/database.ts";

let database: Awaited<ReturnType<typeof testDatabase>>;
beforeAll(async () => {
  database = await testDatabase();
  await database.client.exec(`
    INSERT INTO accounts (id,label,broker) VALUES ('00000000-0000-4000-8000-000000000001','control','manual');
    INSERT INTO campaigns (id,account_id,title,opened_on) VALUES ('00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','control','2026-09-01');
    INSERT INTO roll_chains (id,campaign_id) VALUES ('00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000002');
    INSERT INTO positions (id,campaign_id,underlying,strategy,role,opened_on) VALUES ('00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000002','AAPL','csp','income','2026-09-01');
    INSERT INTO legs (id,position_id,kind,side,underlying,strike,expiry) VALUES ('00000000-0000-4000-8000-000000000005','00000000-0000-4000-8000-000000000004','put','short','AAPL',250,'2026-10-16');
    INSERT INTO rolls (roll_chain_id,rolled_on) VALUES ('00000000-0000-4000-8000-000000000003','2026-09-01');
    INSERT INTO trades (id,leg_id,action,trade_date,quantity,price,cash) VALUES ('00000000-0000-4000-8000-000000000006','00000000-0000-4000-8000-000000000005','open','2026-09-01',1,1,100), ('00000000-0000-4000-8000-000000000007','00000000-0000-4000-8000-000000000005','open','2026-09-01',1,1,100);
    INSERT INTO assignments (option_trade_id,stock_trade_id,shares,premium_per_share) VALUES ('00000000-0000-4000-8000-000000000006','00000000-0000-4000-8000-000000000007',100,1);
    INSERT INTO marks (leg_id,as_of,price,source) VALUES ('00000000-0000-4000-8000-000000000005','2026-09-01',1,'manual');
  `);
});
afterAll(async () => {
  await database.client.close();
});

const matrix = [
  ["accounts", "broker='manual'", "broker='other'", "accounts_broker"],
  ["campaigns", "closed_on='2026-09-02'", "closed_on='2026-08-31'", "campaigns_dates"],
  ["positions", "underlying='BRK.B'", "underlying='aapl'", "positions_underlying"],
  ["positions", "closed_on='2026-09-02'", "closed_on='2026-08-31'", "positions_dates"],
  ["legs", "strike=250", "strike=0", "legs_strike"],
  ["legs", "multiplier=100", "multiplier=0", "legs_multiplier"],
  ["legs", "kind='stock',strike=NULL,expiry=NULL,multiplier=1", "strike=250", "legs_shape"],
  [
    "legs",
    "kind='stock',strike=NULL,expiry=NULL,multiplier=1",
    "expiry='2026-10-16'",
    "legs_shape",
  ],
  ["legs", "kind='put',strike=250,expiry='2026-10-16'", "strike=NULL", "legs_shape"],
  ["legs", "kind='put',strike=250,expiry='2026-10-16'", "expiry=NULL", "legs_shape"],
  ["legs", "kind='call',strike=250,expiry='2026-10-16'", "strike=NULL", "legs_shape"],
  ["legs", "kind='call',strike=250,expiry='2026-10-16'", "expiry=NULL", "legs_shape"],
  [
    "legs",
    "kind='stock',strike=NULL,expiry=NULL,multiplier=1",
    "multiplier=100",
    "legs_stock_multiplier",
  ],
  ["rolls", "detected_by='manual'", "detected_by='other'", "rolls_detected_by"],
  ["trades", "quantity=1", "quantity=0", "trades_quantity"],
  ["trades", "price=0", "price=-1", "trades_price"],
  ["trades", "fees=-0.6527", "fees=1", "trades_fees"],
  ["trades", "currency='USD'", "currency='CAD'", "trades_currency"],
  ["assignments", "shares=100", "shares=0", "assignments_shares"],
  ["marks", "price=1", "price=0", "marks_price"],
  ["marks", "source='manual'", "source='other'", "marks_source"],
] as const;

test.each(matrix)("%s: valid %s; rejects %s (%s)", async (table, valid, invalid, constraint) => {
  const { client } = database;
  await client.exec("BEGIN");
  try {
    await expect(client.query(`UPDATE ${table} SET ${valid} RETURNING *`)).resolves.toMatchObject({
      affectedRows: table === "trades" ? 2 : 1,
    });
    await expect(client.exec(`UPDATE ${table} SET ${invalid}`)).rejects.toMatchObject({
      code: "23514",
      constraint,
    });
  } finally {
    await client.exec("ROLLBACK");
  }
});
