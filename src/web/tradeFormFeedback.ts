import { createPositionSchema } from "../shared/trade.ts";

// Use issue paths from the form's current values, not schema message text: the same
// decimal message can describe a strike, a fill, or a share basis.
export function tradeFormFeedback(raw: unknown, errors: string[], spread: boolean): string[] {
  const parsed = createPositionSchema.safeParse(raw);
  if (parsed.success) return [...new Set(errors)];
  const fields = new Set<string>();
  const sentences = new Set<string>();
  const labels: Record<string, string> = {
    underlying: "ticker",
    quantity: "quantity",
    shares: "shares",
    expiry: "expiry",
    strike: spread ? "strikes" : "strike",
    price: spread ? "fills" : "fill",
    fees: "fees",
    basis: "share basis",
    stockLegId: "covered shares",
    tags: "tags",
    notes: "notes",
    openedOn: "opened date",
  };
  for (const issue of parsed.error.issues) {
    if (issue.path.length === 0 && issue.code === "custom") sentences.add(issue.message);
    else {
      const field = issue.path.findLast((part) => typeof part === "string" && part in labels);
      fields.add(field === undefined ? "trade details" : (labels[String(field)] as string));
    }
  }
  const order = [
    "ticker",
    "quantity",
    "shares",
    "expiry",
    "strikes",
    "strike",
    "fills",
    "fill",
    "fees",
    "covered shares",
    "share basis",
    "tags",
    "notes",
    "opened date",
    "trade details",
  ];
  return [
    ...(fields.size ? [`Needs ${order.filter((field) => fields.has(field)).join(", ")}`] : []),
    ...sentences,
  ];
}
