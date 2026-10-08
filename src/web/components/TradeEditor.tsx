import { useEffect, useRef, useState } from "react";
import {
  absMoney4,
  addMoney4,
  divMoney4,
  formatMoney4,
  Money4RangeError,
  mulMoney4,
  parseMoney4,
  subMoney4,
  sumMoney4,
} from "../../domain/money.ts";
import type { OpenPosition } from "../../domain/sheet.ts";
import {
  type ManualTrade,
  type ManualTradesResponse,
  type PatchTradeRequest,
  patchTradeSchema,
} from "../../shared/trade.ts";
import { previewTrade, type TradePreview } from "../../shared/tradeForm.ts";
import { editTrade, loadManualTrades } from "../tradeApi.ts";
import { DerivedTradeMetrics } from "./TradeForm.tsx";

export function previewEditedTrade(
  position: OpenPosition,
  trades: readonly ManualTrade[],
  id: string,
  patch: PatchTradeRequest,
): TradePreview {
  try {
    const parsed = patchTradeSchema.safeParse(patch);
    if (!parsed.success) {
      return { success: false, errors: parsed.error.issues.map((issue) => issue.message) };
    }
    const selected = trades.find((trade) => trade.id === id);
    if (!selected?.editable) return { success: false, errors: ["Choose an editable manual fill"] };
    const price = parsed.data.price === undefined ? selected.price : parseMoney4(parsed.data.price);
    const legTrades = trades.filter((trade) => trade.legId === selected.legId);
    const totalQuantity = legTrades.reduce((sum, trade) => sum + Math.abs(trade.quantity), 0);
    if (totalQuantity === 0) return { success: false, errors: ["Opening fill has no quantity"] };
    const delta = divMoney4(
      mulMoney4(subMoney4(price, selected.price), Math.abs(selected.quantity)),
      totalQuantity,
    );
    const common = {
      underlying: position.underlying,
      openedOn: position.openedOn,
      tags: [],
      strategy: position.strategy,
      fees: parsed.data.fees ?? formatMoney4(absMoney4(selected.fees), 4),
    };
    if ("shares" in position) {
      return previewTrade(
        {
          ...common,
          shares: position.shares,
          price: formatMoney4(addMoney4(position.price, delta), 4),
        },
        [],
      );
    }
    const option = {
      ...common,
      expiry: position.expiry,
      quantity: position.qty,
      adjusted: position.adjusted,
    };
    if ("longStrike" in position) {
      const average = (side: "long" | "short") => {
        const fills = trades.filter((trade) => trade.kind !== "stock" && trade.side === side);
        const quantity = fills.reduce((sum, trade) => sum + Math.abs(trade.quantity), 0);
        if (quantity === 0) return null;
        return divMoney4(
          sumMoney4(
            fills.map((trade) =>
              mulMoney4(trade.id === id ? price : trade.price, Math.abs(trade.quantity)),
            ),
          ),
          quantity,
        );
      };
      const long = average("long");
      const short = average("short");
      if (long === null || short === null)
        return { success: false, errors: ["Both spread legs are required for a preview"] };
      const { fees, ...spread } = option;
      return previewTrade(
        {
          ...spread,
          long: {
            strike: formatMoney4(position.longStrike, 4),
            price: formatMoney4(long, 4),
            fees,
          },
          short: {
            strike: formatMoney4(position.shortStrike, 4),
            price: formatMoney4(short, 4),
            fees,
          },
          ...(position.role === "income" ? {} : { role: position.role }),
        },
        [],
      );
    }
    const stockFill = selected.kind === "stock";
    return previewTrade(
      {
        ...option,
        strike: formatMoney4(position.strike, 4),
        price: formatMoney4(stockFill ? position.price : addMoney4(position.price, delta), 4),
        ...(position.strategy === "cc"
          ? {
              cover: {
                kind: "held",
                basis: formatMoney4(
                  stockFill ? addMoney4(position.basis, delta) : position.basis,
                  4,
                ),
              },
            }
          : {}),
        ...(position.role === "income" ? {} : { role: position.role }),
      },
      [],
    );
  } catch (error) {
    if (error instanceof Money4RangeError) return { success: false, errors: [error.message] };
    throw error;
  }
}

type Load<T> =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: T };

function EditManualForm({
  position,
  trades,
  onSaved,
  onCancel,
}: {
  position: OpenPosition;
  trades: readonly ManualTrade[];
  onSaved: () => void;
  onCancel: () => void;
}) {
  const editable = trades.filter((trade) => trade.editable);
  const [selectedId, setSelectedId] = useState(editable[0]?.id ?? "");
  const selected = editable.find((trade) => trade.id === selectedId);
  const [price, setPrice] = useState(selected ? formatMoney4(selected.price, 4) : "");
  const [fees, setFees] = useState(selected ? formatMoney4(absMoney4(selected.fees), 4) : "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const preview = previewEditedTrade(position, trades, selectedId, { price, fees });

  async function save(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!preview.success || busy.current) return;
    busy.current = true;
    setSaving(true);
    setError(null);
    try {
      await editTrade(selectedId, { price, fees });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      busy.current = false;
      setSaving(false);
      return;
    }
    onSaved();
  }

  return (
    <form className="trade-form" aria-label={`Edit ${position.underlying} trade`} onSubmit={save}>
      <h2>Edit {position.underlying} trade</h2>
      {editable.length === 0 ? (
        <p>No editable manual opening fills.</p>
      ) : (
        <fieldset disabled={saving}>
          <legend>Manual opening fill</legend>
          <label>
            Fill
            <select
              value={selectedId}
              onChange={(event) => {
                const trade = editable.find((fill) => fill.id === event.target.value);
                if (!trade) return;
                setSelectedId(trade.id);
                setPrice(formatMoney4(trade.price, 4));
                setFees(formatMoney4(absMoney4(trade.fees), 4));
                setError(null);
              }}
            >
              {editable.map((trade) => (
                <option key={trade.id} value={trade.id}>
                  {trade.kind} {trade.side}{" "}
                  {trade.strike === null ? "shares" : formatMoney4(trade.strike, 2)} —{" "}
                  {trade.tradeDate} ({Math.abs(trade.quantity)})
                </option>
              ))}
            </select>
          </label>
          <div className="trade-fields">
            <label>
              Fill price
              <input
                inputMode="decimal"
                value={price}
                onChange={(event) => setPrice(event.target.value)}
              />
            </label>
            <label>
              Fees
              <input
                inputMode="decimal"
                value={fees}
                onChange={(event) => setFees(event.target.value)}
              />
            </label>
          </div>
        </fieldset>
      )}
      {preview.success ? (
        <DerivedTradeMetrics metrics={preview.metrics} costBasis={preview.costBasis} />
      ) : (
        <section aria-label="Derived trade metrics" aria-live="polite">
          <ul className="trade-errors">
            {[...new Set(preview.errors)].map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </section>
      )}
      {error && <p role="alert">{error}</p>}
      <div className="trade-actions">
        <button type="submit" disabled={!preview.success || saving}>
          {saving ? "Saving…" : "Save changes"}
        </button>
        <button type="button" disabled={saving} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function TradeEditor({
  positions,
  onSaved,
  editingPositionId,
  onEditDone,
}: {
  positions: readonly OpenPosition[];
  onSaved: () => void;
  editingPositionId: string | null;
  onEditDone: () => void;
}) {
  const [manual, setManual] = useState<{ id: string | null; load: Load<ManualTradesResponse> }>({
    id: null,
    load: { status: "loading" },
  });
  const [retry, setRetry] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry must restart a failed request.
  useEffect(() => {
    if (editingPositionId === null) return;
    const id = editingPositionId;
    let active = true;
    setManual({ id, load: { status: "loading" } });
    loadManualTrades(id).then(
      (data) => {
        if (active) setManual({ id, load: { status: "ready", data } });
      },
      (cause: unknown) => {
        if (active)
          setManual({
            id,
            load: {
              status: "error",
              message: cause instanceof Error ? cause.message : String(cause),
            },
          });
      },
    );
    return () => {
      active = false;
    };
  }, [editingPositionId, retry]);

  if (editingPositionId === null) return null;
  const position = positions.find((p) => p.id === editingPositionId);
  const load = manual.id === editingPositionId ? manual.load : { status: "loading" as const };
  const saved = () => {
    onSaved();
    onEditDone();
  };

  return (
    <section className="trade-editor" aria-label="Trade editor">
      {!position ? (
        <>
          <p role="alert">This position is no longer open.</p>
          <button type="button" onClick={onEditDone}>
            Cancel
          </button>
        </>
      ) : load.status === "loading" ? (
        <>
          <p role="status">Loading trade details…</p>
          <button type="button" onClick={onEditDone}>
            Cancel
          </button>
        </>
      ) : load.status === "error" ? (
        <>
          <p role="alert">{load.message}</p>
          <button type="button" onClick={() => setRetry(retry + 1)}>
            Retry
          </button>
          <button type="button" onClick={onEditDone}>
            Cancel
          </button>
        </>
      ) : (
        <EditManualForm
          key={editingPositionId}
          position={position}
          trades={load.data.trades}
          onSaved={saved}
          onCancel={onEditDone}
        />
      )}
    </section>
  );
}
