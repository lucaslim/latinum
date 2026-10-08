import type {
  AssignRequest,
  CloseRequest,
  ExpireRequest,
  LifecycleResponse,
  LinkHedgeRequest,
  LinkHedgeResponse,
} from "../contracts/lifecycle.ts";

import type { RollRequest, RollResponse } from "../contracts/roll.ts";

export type LifecycleMutation =
  | { action: "close"; input: CloseRequest }
  | { action: "expire"; input: ExpireRequest }
  | { action: "assign"; input: AssignRequest }
  | { action: "link-hedge"; input: LinkHedgeRequest }
  | { action: "roll"; input: RollRequest };
export type LifecycleResult = LifecycleResponse | LinkHedgeResponse | RollResponse;
export type SaveLifecycle = (
  positionId: string,
  mutation: LifecycleMutation,
) => Promise<LifecycleResult>;

export class LifecycleHttpError extends Error {
  readonly status: number;
  readonly code: "stale_revision" | undefined;

  constructor(
    status: number,
    detail: string,
    options?: ErrorOptions & { code?: "stale_revision" },
  ) {
    super(`${detail} (HTTP ${status})`, options);
    this.status = status;
    this.code = options?.code;
  }
}

export async function saveLifecycle(
  positionId: string,
  mutation: LifecycleMutation,
  signal: AbortSignal,
): Promise<LifecycleResult> {
  if (mutation.action === "roll" && mutation.input.positionId !== positionId)
    throw new RangeError("Roll position does not match");
  const response = await fetch(
    mutation.action === "roll"
      ? "/api/rolls"
      : `/api/positions/${encodeURIComponent(positionId)}/${mutation.action}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify(mutation.input),
      signal,
    },
  );
  if (!response.ok) {
    const fallback = "Could not save lifecycle action";
    let body: unknown = {};
    if (response.headers.get("content-type")?.includes("application/json")) {
      try {
        body = await response.json();
      } catch (cause) {
        throw new LifecycleHttpError(response.status, fallback, { cause });
      }
    }
    const detail =
      typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
        ? body.error
        : fallback;
    const code =
      typeof body === "object" && body !== null && "code" in body && body.code === "stale_revision"
        ? body.code
        : undefined;
    throw new LifecycleHttpError(response.status, detail, code ? { code } : undefined);
  }
  return response.json();
}
