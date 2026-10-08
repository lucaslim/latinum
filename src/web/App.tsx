import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import type { IsoDate } from "../domain/dates.ts";
import type { AssignedStockOption, TradeFormOptions } from "../shared/trade.ts";
import { useOpenPositions } from "./api.ts";
import { useCampaign } from "./campaignApi.ts";
import { CampaignDetail } from "./components/CampaignDetail.tsx";
import { DownloadExport } from "./components/DownloadExport.tsx";
import { MonthlyPnlRoute } from "./components/MonthlyPnlDashboard.tsx";
import { PositionsSheet } from "./components/PositionsSheet.tsx";
import { ThemeSelect } from "./components/ThemeSelect.tsx";
import { TradeEditor } from "./components/TradeEditor.tsx";
import { TradeForm } from "./components/TradeForm.tsx";
import { loadTradeFormOptions } from "./tradeApi.ts";

const NEW_TRADE_HASH = "#/trades/new";
const DISCARD_PROMPT = "Discard this trade?";

// Every history entry carries its position in `history.state`, so a refused navigation can be
// undone by traversing back to the form's entry instead of pushing a new one.
function ordinalOf(state: unknown): number | undefined {
  if (typeof state === "object" && state !== null && "tradingJournalEntry" in state) {
    const { tradingJournalEntry } = state;
    if (typeof tradingJournalEntry === "number") return tradingJournalEntry;
  }
  return undefined;
}

function stampEntry(ordinal: number): number {
  window.history.replaceState({ tradingJournalEntry: ordinal }, "");
  return ordinal;
}

function openNewTrade() {
  if (window.location.hash !== NEW_TRADE_HASH) window.location.hash = NEW_TRADE_HASH;
}

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

type OptionsLoad =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; options: TradeFormOptions };

// `asOf` comes from the positions response so the trading date matches the Sheet's.
function NewTradeRoute({
  dirtyRef,
  leave,
}: {
  dirtyRef: RefObject<boolean>;
  leave: (target: string) => void;
}) {
  const positions = useOpenPositions();
  const [options, setOptions] = useState<OptionsLoad>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [dirty, setDirty] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry must restart a failed options request.
  useEffect(() => {
    let active = true;
    setOptions({ status: "loading" });
    loadTradeFormOptions().then(
      (loaded) => {
        if (active) setOptions({ status: "ready", options: loaded });
      },
      (cause: unknown) => {
        if (active) {
          setOptions({
            status: "error",
            message: cause instanceof Error ? cause.message : String(cause),
          });
        }
      },
    );
    return () => {
      active = false;
    };
  }, [attempt]);

  useEffect(() => {
    dirtyRef.current = dirty;
    return () => {
      dirtyRef.current = false;
    };
  }, [dirty, dirtyRef]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const failure =
    positions.status === "error"
      ? positions.message
      : options.status === "error"
        ? options.message
        : null;
  if (failure !== null) {
    return (
      <div>
        <p role="alert">{failure}</p>
        <button
          type="button"
          onClick={() => {
            positions.refresh();
            setAttempt((value) => value + 1);
          }}
        >
          Retry
        </button>
      </div>
    );
  }
  if (positions.status !== "ready" || options.status !== "ready") {
    return <p role="status">Loading trade form…</p>;
  }
  return (
    <TradeForm
      asOf={positions.data.asOf}
      options={options.options}
      onDirtyChange={setDirty}
      onSaved={() => {
        // Saved input is not unsaved input: skip the prompt that the hash change would raise.
        dirtyRef.current = false;
        window.location.hash = "#/";
      }}
      onCancel={() => leave("#/")}
    />
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
  const dirtyRef = useRef(false);
  // The entry the rendered route belongs to, and the hash whose prompt was already answered.
  const committedEntry = useRef(0);
  const approvedHash = useRef<string | null>(null);

  // The form stays dirty until its route unmounts, so a prompt that is accepted for a navigation
  // that then does not happen can never leave the form unguarded.
  const leave = useCallback((target: string) => {
    if (dirtyRef.current && !window.confirm(DISCARD_PROMPT)) return;
    approvedHash.current = target;
    window.location.hash = target;
  }, []);

  useEffect(() => {
    committedEntry.current = ordinalOf(window.history.state) ?? stampEntry(0);
    const onHashChange = () => {
      const next = window.location.hash;
      const approved = approvedHash.current === next;
      approvedHash.current = null;
      // An entry the browser just created (hash assignment, typed URL) has no ordinal yet; it sits
      // right after the entry it was created from.
      const entry = ordinalOf(window.history.state) ?? stampEntry(committedEntry.current + 1);
      if (next !== NEW_TRADE_HASH && dirtyRef.current && !approved) {
        if (!window.confirm(DISCARD_PROMPT)) {
          // Traversing back to the form's entry (rather than pushing its URL again) leaves the
          // history as it was, and the restoring hashchange lands on the unchanged route.
          const delta = committedEntry.current - entry;
          if (delta === 0) {
            // Entries from before ordinals existed can collide with the form's, and `go(0)` would
            // reload the page: rewrite this entry's URL back to the form instead.
            const { pathname, search } = window.location;
            window.history.replaceState(
              { tradingJournalEntry: committedEntry.current },
              "",
              pathname + search + NEW_TRADE_HASH,
            );
            return;
          }
          window.history.go(delta);
          return;
        }
      }
      committedEntry.current = entry;
      setHash(next);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "n" || event.repeat || event.defaultPrevented) return;
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || target.closest("input, textarea, select"))
      ) {
        return;
      }
      openNewTrade();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Only an unmodified click on a link to another screen can leave the form: a refused click then
  // never creates a history entry.
  const nav = useRef<HTMLElement>(null);
  useEffect(() => {
    const element = nav.current;
    if (!element) return;
    const guardLink = (event: MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      const link =
        event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!link || link.hash === window.location.hash || !dirtyRef.current) return;
      event.preventDefault();
      leave(link.hash);
    };
    element.addEventListener("click", guardLink);
    return () => element.removeEventListener("click", guardLink);
  }, [leave]);

  const campaignId = /^#\/campaigns\/([^/]+)$/.exec(hash)?.[1];
  const monthlyPnl = hash === "#/pl";
  const newTrade = hash === NEW_TRADE_HASH;

  return (
    <div className="frame">
      <div className="app">
        <header className="side">
          <div className="logo">Latinum</div>
          <button
            type="button"
            className="new-trade"
            aria-label="New trade"
            aria-keyshortcuts="N"
            aria-current={newTrade ? "page" : undefined}
            onClick={openNewTrade}
          >
            + New trade <kbd>N</kbd>
          </button>
          <nav aria-label="Main" ref={nav}>
            <a
              className="nav-link"
              href="#/"
              aria-current={campaignId || monthlyPnl || newTrade ? undefined : "page"}
            >
              Positions
            </a>
            <a className="nav-link" href="#/pl" aria-current={monthlyPnl ? "page" : undefined}>
              Monthly P/L
            </a>
          </nav>
          <ThemeSelect />
        </header>
        <main className="main">
          <DownloadExport />
          {campaignId ? (
            <CampaignRoute key={campaignId} id={campaignId} />
          ) : monthlyPnl ? (
            <MonthlyPnlRoute />
          ) : newTrade ? (
            <NewTradeRoute dirtyRef={dirtyRef} leave={leave} />
          ) : (
            <PositionsRoute />
          )}
        </main>
      </div>
    </div>
  );
}
