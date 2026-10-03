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

export function useOpenPositions(): Load {
  const [load, setLoad] = useState<Load>({ status: "loading" });

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
  }, []);

  return load;
}
