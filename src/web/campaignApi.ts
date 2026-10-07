import { useEffect, useRef, useState } from "react";
import type {
  CampaignResponse,
  ManualMarkRequest,
  ManualMarkResponse,
} from "../domain/campaign.ts";
import {
  LifecycleHttpError,
  type LifecycleResult,
  saveLifecycle as postLifecycle,
  type SaveLifecycle,
} from "./lifecycleApi.ts";

export type CampaignLoad =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: CampaignResponse };

export async function fetchCampaign(id: string, signal: AbortSignal): Promise<CampaignResponse> {
  const response = await fetch(`/api/campaigns/${encodeURIComponent(id)}`, {
    signal,
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Could not load campaign (HTTP ${response.status})`);
  return response.json();
}

export async function saveManualMark(
  legId: string,
  input: ManualMarkRequest,
  signal: AbortSignal,
): Promise<ManualMarkResponse> {
  const response = await fetch(`/api/legs/${encodeURIComponent(legId)}/mark`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal,
  });
  if (!response.ok) throw new Error(`Could not save mark (HTTP ${response.status})`);
  return response.json();
}

export function useCampaign(id: string) {
  const [load, setLoad] = useState<CampaignLoad>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const active = useRef<{ id: string; abort: AbortController; revision: number } | null>(null);

  useEffect(() => {
    const request = { id, abort: new AbortController(), revision: attempt };
    active.current = request;
    setLoad({ status: "loading" });
    fetchCampaign(id, request.abort.signal).then(
      (data) => {
        if (!request.abort.signal.aborted && active.current === request) {
          setLoad({ status: "ready", data });
        }
      },
      (error: unknown) => {
        if (!request.abort.signal.aborted && active.current === request) {
          setLoad({
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      },
    );
    return () => {
      request.abort.abort();
      if (active.current === request) active.current = null;
    };
  }, [id, attempt]);

  async function saveMark(legId: string, input: ManualMarkRequest): Promise<void> {
    const request = active.current;
    if (!request || request.id !== id) throw new Error("Campaign is no longer active");
    await saveManualMark(legId, input, request.abort.signal);
    const revision = ++request.revision;
    const data = await fetchCampaign(id, request.abort.signal);
    // Two mark forms may save concurrently; only the newest refresh can update the view.
    if (
      !request.abort.signal.aborted &&
      active.current === request &&
      request.revision === revision
    ) {
      setLoad({ status: "ready", data });
    }
  }

  const saveLifecycle: SaveLifecycle = async (positionId, mutation) => {
    const request = active.current;
    if (!request || request.id !== id) throw new Error("Campaign is no longer active");
    let result: LifecycleResult;
    try {
      result = await postLifecycle(positionId, mutation, request.abort.signal);
    } catch (error) {
      if (
        error instanceof LifecycleHttpError &&
        error.status === 409 &&
        error.code === "stale_revision"
      ) {
        const message = "Position changed. Reload the campaign before another action.";
        if (active.current === request) {
          active.current = null;
          setLoad({ status: "error", message });
        }
        throw error;
      }
      if (error instanceof LifecycleHttpError && error.status >= 400 && error.status < 500)
        throw error;
      const status = error instanceof LifecycleHttpError ? ` (HTTP ${error.status})` : "";
      const message = `Lifecycle action outcome is uncertain${status}. Reload the campaign before another action.`;
      if (active.current === request) {
        active.current = null;
        setLoad({ status: "error", message });
      }
      throw new Error(message, { cause: error });
    }
    const revision = ++request.revision;
    let data: CampaignResponse;
    try {
      data = await fetchCampaign(id, request.abort.signal);
    } catch (error) {
      const message =
        "Lifecycle action was saved, but campaign refresh failed. Reload the campaign before another action.";
      if (active.current === request) {
        active.current = null;
        setLoad({ status: "error", message });
      }
      throw new Error(message, { cause: error });
    }
    if (
      !request.abort.signal.aborted &&
      active.current === request &&
      request.revision === revision
    ) {
      setLoad({ status: "ready", data });
    }
    return result;
  };
  return { load, retry: () => setAttempt((value) => value + 1), saveMark, saveLifecycle };
}
