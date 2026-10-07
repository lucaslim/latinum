import { useEffect, useState } from "react";
import type { IsoDate } from "../domain/dates.ts";
import type { AssignedStockOption, TradeFormOptions } from "../shared/trade.ts";
import { useOpenPositions } from "./api.ts";
import { useCampaign } from "./campaignApi.ts";
import { CampaignDetail } from "./components/CampaignDetail.tsx";
import { DownloadExport } from "./components/DownloadExport.tsx";
import { PositionsSheet } from "./components/PositionsSheet.tsx";
import { ThemeSelect } from "./components/ThemeSelect.tsx";
import { TradeEditor } from "./components/TradeEditor.tsx";
import { TradeForm } from "./components/TradeForm.tsx";
import { loadTradeFormOptions } from "./tradeApi.ts";

function PositionsRoute() {
  const load = useOpenPositions();
  const [editingPositionId, setEditingPositionId] = useState<string | null>(null);
  return (
    <>
      {load.status === "loading" && <p role="status">Loading positions…</p>}
      {load.status === "error" && <p role="alert">{load.message}</p>}
      {load.status === "ready" && (
        <>
          <TradeEditor
            asOf={load.data.asOf}
            positions={load.data.positions}
            onSaved={load.refresh}
            editingPositionId={editingPositionId}
            onEditDone={() => setEditingPositionId(null)}
          />
          <PositionsSheet
            positions={load.data.positions}
            asOf={load.data.asOf}
            onEdit={setEditingPositionId}
          />
        </>
      )}
    </>
  );
}

type CoveredCallLoad =
  | { status: "loading" }
  | { status: "error" | "unavailable"; message: string }
  | { status: "ready"; options: TradeFormOptions; assignedStock: AssignedStockOption };

function AssignedCallForm({
  stockLegId,
  asOf,
  onSaved,
  onCancel,
}: {
  stockLegId: string;
  asOf: IsoDate;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [load, setLoad] = useState<CoveredCallLoad>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry must restart a failed options request.
  useEffect(() => {
    let active = true;
    setLoad({ status: "loading" });
    loadTradeFormOptions().then(
      (options) => {
        if (!active) return;
        const assignedStock = options.assignedStock.find((stock) => stock.legId === stockLegId);
        if (!assignedStock || assignedStock.uncoveredShares < 100) {
          setLoad({
            status: "unavailable",
            message: assignedStock
              ? "Insufficient uncovered shares: at least 100 are required."
              : "Assigned shares are no longer available for a covered call.",
          });
          return;
        }
        setLoad({ status: "ready", options, assignedStock });
      },
      (cause: unknown) => {
        if (active) {
          setLoad({
            status: "error",
            message: cause instanceof Error ? cause.message : String(cause),
          });
        }
      },
    );
    return () => {
      active = false;
    };
  }, [stockLegId, attempt]);

  if (load.status === "ready") {
    return (
      <TradeForm
        asOf={asOf}
        options={load.options}
        assignedStock={load.assignedStock}
        onSaved={onSaved}
        onCancel={onCancel}
      />
    );
  }
  return (
    <section aria-label="Sell covered call">
      {load.status === "loading" ? (
        <p role="status">Loading covered call options…</p>
      ) : (
        <>
          <p role="alert">{load.message}</p>
          <button type="button" onClick={() => setAttempt((value) => value + 1)}>
            Retry covered call
          </button>
        </>
      )}
      <button type="button" onClick={onCancel}>
        Cancel
      </button>
    </section>
  );
}

function CampaignRoute({ id }: { id: string }) {
  const { load, retry, saveMark, saveLifecycle } = useCampaign(id);
  const [stockLegId, setStockLegId] = useState<string | null>(null);
  return (
    <>
      <a className="campaign-back" href="#/">
        Back to positions
      </a>
      {load.status === "loading" && <p role="status">Loading campaign…</p>}
      {load.status === "error" && (
        <div>
          <p role="alert">{load.message}</p>
          <button type="button" onClick={retry}>
            Retry campaign
          </button>
        </div>
      )}
      {load.status === "ready" && (
        <>
          {stockLegId && (
            <AssignedCallForm
              key={stockLegId}
              stockLegId={stockLegId}
              asOf={load.data.asOf}
              onCancel={() => setStockLegId(null)}
              onSaved={() => {
                setStockLegId(null);
                retry();
              }}
            />
          )}
          <CampaignDetail
            campaign={load.data}
            onSaveMark={saveMark}
            onSaveLifecycle={saveLifecycle}
            onSellCoveredCall={setStockLegId}
          />
        </>
      )}
    </>
  );
}

export function App() {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onHashChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  const campaignId = /^#\/campaigns\/([^/]+)$/.exec(hash)?.[1];

  return (
    <div className="frame">
      <div className="app">
        <header className="side">
          <div className="logo">Trading Journal</div>
          <nav aria-label="Main">
            <a className="nav-link" href="#/" aria-current={campaignId ? undefined : "page"}>
              Positions
            </a>
          </nav>
          <ThemeSelect />
        </header>
        <main className="main">
          <DownloadExport />
          {campaignId ? <CampaignRoute key={campaignId} id={campaignId} /> : <PositionsRoute />}
        </main>
      </div>
    </div>
  );
}
