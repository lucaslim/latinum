import { useOpenPositions } from "./api.ts";
import { PositionsSheet } from "./components/PositionsSheet.tsx";
import { ThemeSelect } from "./components/ThemeSelect.tsx";

export function App() {
  const load = useOpenPositions();

  return (
    <div className="frame">
      <div className="app">
        <header className="side">
          <div className="logo">Trading Journal</div>
          <nav aria-label="Main">
            <a className="nav-link" href="/" aria-current="page">
              Positions
            </a>
          </nav>
          <ThemeSelect />
        </header>
        <main className="main">
          {load.status === "loading" && <p role="status">Loading positions…</p>}
          {load.status === "error" && <p role="alert">{load.message}</p>}
          {load.status === "ready" && (
            <PositionsSheet positions={load.data.positions} asOf={load.data.asOf} />
          )}
        </main>
      </div>
    </div>
  );
}
