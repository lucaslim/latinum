# Lifecycle actions (T8)

All four actions are `POST /api/positions/:id/<action>`. JSON requests use decimal USD
strings, positive integer quantities and New York `tradeDate` strings. Omitted dates
use `todayNY` on the server; future dates are rejected. Fees are signed (zero or negative)
and default to zero. Responses are private and uncached. Invalid bodies or unsupported
operations are 400; absent records are 404; exhausted quantities/conflicting state are 409.
A client must not automatically retry a mutation after an uncertain network response.

- `close`: `{ "fills": [{ "legId": "<uuid>", "quantity": 5, "price": "0.40", "fees": "-1.30" }], "tradeDate": "2026-10-16" }`.
  Each leg has its own execution price. This does not infer a spread's leg prices from a net fill.
  Spread closes must retain balanced quantities; held covered calls must retain enough stock
  for their remaining calls. Dismantling a strategy into naked residual legs is not supported.
- `expire`: `{ "tradeDate": "2026-10-16" }`. Expires all remaining option quantities at zero
  cash, price and fees. Expiry must have been reached; stock is untouched. Repeating it
  returns 409, not another booking.
- `assign`: `{ "legId": "<uuid>", "tradeDate": "2026-10-16", "fees": "0" }`.
  Only an unadjusted short put in a CSP is supported. Assigns all remaining contracts,
  writes the option event, a separate stock/swing position in the same campaign, its stock
  leg/opening trade at the strike, and the assignment link in one transaction. Calls,
  spreads, long options and adjusted deliverables are rejected with 400.
- `link-hedge`: `{ "campaignId": "<uuid>" }`. Moves an open, non-roll-linked hedge into a
  campaign in the same account. The source campaign remains for audit history; linking
  to its current campaign is a no-op. There is no unlink action.

Close, expiry and assignment return the new trade IDs and net realized allocations.
Assignment also returns stock IDs, shares, gross premium per share and premium-adjusted
wheel basis. DRAM assignment opens 1,500 shares with cash entry 55.00 and wheel basis
53.00. The latter is displayed separately, not substituted into stock realized/unrealized
P/L: the put premium has already been realized. Closing/expiring a held covered call leaves
its shares visible as stock rather than a zero-contract CC.

## Exported realized allocation contract

`allocateRealizedTrades` in `src/domain/lifecyclePnl.ts` takes a leg's quantity-bearing
signed cash/fee events and returns one allocation per non-opening event. It is the shared
calculation for future T10 monthly P/L and T11b trades-CSV P/L; neither consumer is
implemented here. The original full-leg `realizedLeg` remains compatible.

Events are processed by calendar date, preserving input order for same-day ties. Database
callers supply `tradeDate`, `createdAt`, `id` order. An opening fill only enters the pool when
it is reached; future opening fills cannot contribute to an earlier close. A partial close
allocates **remaining opening cash and opening fees separately**, proportional to its
quantity over remaining open quantity. Each allocation truncates toward zero to an integer
Money4 unit using exact integer arithmetic. The final close consumes **both** remainders
exactly. Closing cash and fees are added only to that close's net P/L, and its own date supplies
`bookedMonth`. New opening fills after a partial close join the remaining weighted-average
pool. Reopening after a full close starts a fresh pool. Invalid quantities and over-closing
fail rather than manufacturing a realized amount.

## Pending T6 integration

This PR stays draft until PR #17 merges. The assignment UI retains `stockLegId` and wheel
basis and displays the covered-call offer as unavailable pending trade-form integration.
There is intentionally no duplicate T6 form, create endpoint or invented navigation contract.
After T6 merges, wire the offer to its assigned-share prefill and mark the PR ready.
