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
    const body: { error?: string } = response.headers
      .get("content-type")
      ?.includes("application/json")
      ? await response.json()
      : {};
    throw new Error(`${body.error ?? "Could not save lifecycle action"} (HTTP ${response.status})`);
  }
  return response.json();
}
