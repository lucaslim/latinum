import { useEffect, useState } from "react";
import type { OpenPositionsResponse } from "../domain/sheet.ts";

export type Load =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: OpenPositionsResponse };

async function fetchOpenPositions(signal: AbortSignal): Promise<OpenPositionsResponse> {
  const res = await fetch("/api/positions?status=open", { signal });
  if (!res.ok) throw new Error(`Could not load positions (HTTP ${res.status})`);
  return res.json();
}

export function useOpenPositions(): Load & { refresh: () => void } {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [revision, setRevision] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Saving a fill invalidates the book without reloading the page.
  useEffect(() => {
    const abort = new AbortController();
    fetchOpenPositions(abort.signal).then(
      (data) => setLoad({ status: "ready", data }),
      (error: unknown) => {
        if (abort.signal.aborted) return;
        setLoad({
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      },
    );
    return () => abort.abort();
  }, [revision]);

  return { ...load, refresh: () => setRevision((value) => value + 1) };
}
