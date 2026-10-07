import type {
  AssignRequest,
  CloseRequest,
  ExpireRequest,
  LifecycleResponse,
  LinkHedgeRequest,
  LinkHedgeResponse,
} from "../contracts/lifecycle.ts";

export type LifecycleMutation =
  | { action: "close"; input: CloseRequest }
  | { action: "expire"; input: ExpireRequest }
  | { action: "assign"; input: AssignRequest }
  | { action: "link-hedge"; input: LinkHedgeRequest };
export type LifecycleResult = LifecycleResponse | LinkHedgeResponse;
export type SaveLifecycle = (
  positionId: string,
  mutation: LifecycleMutation,
) => Promise<LifecycleResult>;

export class LifecycleHttpError extends Error {
  readonly status: number;

  /** Preserve an HTTP failure status, detail and optional cause for recovery decisions. */
  constructor(status: number, detail: string, options?: ErrorOptions) {
    super(`${detail} (HTTP ${status})`, options);
    this.status = status;
  }
}

/**
 * POST one lifecycle mutation without retries and return its typed response.
 * HTTP failures retain the status and server detail when available; malformed JSON
 * error bodies use the fallback message and preserve the parsing error as the cause.
 */
export async function saveLifecycle(
  positionId: string,
  mutation: LifecycleMutation,
  signal: AbortSignal,
): Promise<LifecycleResult> {
  const response = await fetch(
    `/api/positions/${encodeURIComponent(positionId)}/${mutation.action}`,
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
    throw new LifecycleHttpError(response.status, detail);
  }
  return response.json();
}
