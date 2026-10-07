import { useEffect, useState } from "react";
import { useOpenPositions } from "./api.ts";
import { useCampaign } from "./campaignApi.ts";
import { CampaignDetail } from "./components/CampaignDetail.tsx";
import { PositionsSheet } from "./components/PositionsSheet.tsx";
import { ThemeSelect } from "./components/ThemeSelect.tsx";

function PositionsRoute() {
  const load = useOpenPositions();
  return (
    <>
      {load.status === "loading" && <p role="status">Loading positions…</p>}
      {load.status === "error" && <p role="alert">{load.message}</p>}
      {load.status === "ready" && (
        <PositionsSheet positions={load.data.positions} asOf={load.data.asOf} />
      )}
    </>
  );
}

function CampaignRoute({ id }: { id: string }) {
  const { load, retry, saveMark } = useCampaign(id);
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
      {load.status === "ready" && <CampaignDetail campaign={load.data} onSaveMark={saveMark} />}
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
          {campaignId ? <CampaignRoute key={campaignId} id={campaignId} /> : <PositionsRoute />}
        </main>
      </div>
    </div>
  );
}
