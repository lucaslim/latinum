import {
  type CreatePositionRequest,
  type CreatePositionResponse,
  createPositionSchema,
  type ManualTradesResponse,
  type PatchTradeRequest,
  type PatchTradeResponse,
  patchTradeSchema,
  type TradeFormOptions,
} from "../shared/trade.ts";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = await response.text();
    let detail = body;
    try {
      const parsed: unknown = JSON.parse(body);
      if (parsed && typeof parsed === "object" && "error" in parsed) {
        detail = typeof parsed.error === "string" ? parsed.error : JSON.stringify(parsed.error);
      }
    } catch {
      // A plain-text HTTP error is already readable.
    }
    throw new Error(`HTTP ${response.status}: ${detail || response.statusText}`);
  }
  return response.json() as Promise<T>;
}

export const loadTradeFormOptions = (): Promise<TradeFormOptions> =>
  request("/api/trade-form/options");

export const loadManualTrades = (positionId: string): Promise<ManualTradesResponse> =>
  request(`/api/positions/${encodeURIComponent(positionId)}/manual-trades`);

export function createTrade(input: CreatePositionRequest): Promise<CreatePositionResponse> {
  return request("/api/positions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(createPositionSchema.parse(input)),
  });
}

export function editTrade(id: string, patch: PatchTradeRequest): Promise<PatchTradeResponse> {
  return request(`/api/trades/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patchTradeSchema.parse(patch)),
  });
}
