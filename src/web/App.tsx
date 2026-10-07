import { useEffect, useState } from "react";
import { useOpenPositions } from "./api.ts";
import { useCampaign } from "./campaignApi.ts";
import { CampaignDetail } from "./components/CampaignDetail.tsx";
import { DownloadExport } from "./components/DownloadExport.tsx";
import { PositionsSheet } from "./components/PositionsSheet.tsx";
import { ThemeSelect } from "./components/ThemeSelect.tsx";
import { TradeEditor } from "./components/TradeEditor.tsx";

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

function CampaignRoute({ id }: { id: string }) {
  const { load, retry, saveMark, saveLifecycle } = useCampaign(id);
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
        <CampaignDetail
          campaign={load.data}
          onSaveMark={saveMark}
          onSaveLifecycle={saveLifecycle}
        />
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
