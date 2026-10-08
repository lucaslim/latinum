import { useEffect, useState } from "react";
import type { MonthlyPnlResponse } from "../domain/monthlyPnlTypes.ts";

export type MonthlyPnlLoad =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: MonthlyPnlResponse };

export async function fetchMonthlyPnl(signal: AbortSignal): Promise<MonthlyPnlResponse> {
  const response = await fetch("/api/pl/monthly", { signal, cache: "no-store" });
  if (!response.ok) throw new Error(`Could not load monthly P/L (HTTP ${response.status})`);
  return response.json();
}

export function useMonthlyPnl() {
  const [load, setLoad] = useState<MonthlyPnlLoad>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry restarts the read without changing its URL.
  useEffect(() => {
    const controller = new AbortController();
    setLoad({ status: "loading" });
    fetchMonthlyPnl(controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setLoad({ status: "ready", data });
      },
      (error: unknown) => {
        if (!controller.signal.aborted) {
          setLoad({
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      },
    );
    return () => controller.abort();
  }, [attempt]);
  return { load, retry: () => setAttempt((value) => value + 1) };
}
