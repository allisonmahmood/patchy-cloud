import { useCallback, useEffect, useMemo, useState, useQuery } from "patchy/preact";
import { patchy } from "../patchy/_generated/client.js";
import type { LostReason, Stage } from "../helpers/pipeline.js";
import { boardCsv } from "./csv.js";
import { describeError, isDismissedDownload } from "./errors.js";
import { isoDate } from "./format.js";
import { useNow } from "./hooks.js";
import type { Deal, PendingMove, Viewer } from "./types.js";
import { Board } from "./components/Board.js";
import { DealDrawer } from "./components/DealDrawer.js";
import { EmptyState } from "./components/EmptyState.js";
import { ImportDialog } from "./components/ImportDialog.js";
import { Kpis } from "./components/Kpis.js";
import { LostReasonDialog } from "./components/LostReason.js";
import { NewDealDialog } from "./components/NewDealDialog.js";
import { Toasts, useToasts } from "./components/Toasts.js";

const dealFromPath = (path: string) => /^\/deal\/([^/]+)$/.exec(path)?.[1] ?? null;

const without = (moves: ReadonlyMap<string, PendingMove>, id: string) => {
  const next = new Map(moves);
  next.delete(id);
  return next;
};

export function App() {
  const board = useQuery(patchy.server.deals.board, {});
  const now = useNow();
  const { toasts, notify, dismiss } = useToasts();
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [mineOnly, setMineOnly] = useState(false);
  const [showLost, setShowLost] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"new" | "import" | null>(null);
  /** A card dropped on Lost, waiting for its reason. */
  const [losing, setLosing] = useState<Deal | null>(null);
  const [pending, setPending] = useState<ReadonlyMap<string, PendingMove>>(new Map());
  const [loadingSample, setLoadingSample] = useState(false);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    let active = true;
    patchy
      .me()
      .then((me) => {
        if (active) setViewer(me);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  // The drawer lives at /deal/<id>, so a deal can be linked to and back/forward work.
  useEffect(() => patchy.route.subscribe((path) => setOpenId(dealFromPath(path))), []);
  const openDeal = useCallback((id: string | null) => {
    setOpenId(id);
    patchy.route.set(id === null ? "/" : `/deal/${id}`).catch(() => undefined);
  }, []);
  const closeDeal = useCallback(() => openDeal(null), [openDeal]);
  const closeDialog = useCallback(() => setDialog(null), []);
  const cancelLosing = useCallback(() => setLosing(null), []);

  const deals = board.data?.deals;
  const people = useMemo(
    () => new Map((board.data?.people ?? []).map((person) => [person.id, person])),
    [board.data]
  );

  // A move stays pending until the live board shows it, so cards never jump back and forth.
  useEffect(() => {
    if (deals === undefined) return;
    setPending((current) => {
      let next = current;
      for (const [id, move] of current) {
        const deal = deals.find((candidate) => candidate.id === id);
        if (
          deal === undefined ||
          deal.stage === move.to ||
          (move.committed && deal.stage !== move.from)
        )
          next = without(next, id);
      }
      return next;
    });
  }, [deals]);

  /** Every stage change, from drag and drop or the drawer, goes through here to deals.move. Lost needs a reason. */
  const moveDeal = useCallback(
    async (deal: Deal, stage: Stage, reason?: LostReason): Promise<string | null> => {
      if (deal.stage === stage) return null;
      const startedAt = Date.now();
      const mine = (moves: ReadonlyMap<string, PendingMove>) =>
        moves.get(deal.id)?.startedAt === startedAt;
      setPending((current) =>
        new Map(current).set(deal.id, { from: deal.stage, to: stage, committed: false, startedAt })
      );
      try {
        await patchy.server.deals.move({ deal: deal.id, stage, reason });
        setPending((current) =>
          mine(current)
            ? new Map(current).set(deal.id, { ...current.get(deal.id)!, committed: true })
            : current
        );
        setTimeout(
          () => setPending((current) => (mine(current) ? without(current, deal.id) : current)),
          10_000
        );
        return null;
      } catch (error) {
        setPending((current) => (mine(current) ? without(current, deal.id) : current));
        return describeError(error);
      }
    },
    []
  );

  const visible = useMemo(
    () =>
      deals === undefined
        ? []
        : mineOnly && viewer !== null
          ? deals.filter((deal) => deal.owner === viewer.user.id)
          : deals,
    [deals, mineOnly, viewer]
  );
  const openDealRow = openId === null ? undefined : deals?.find((deal) => deal.id === openId);

  async function loadSample() {
    setLoadingSample(true);
    try {
      const result = await patchy.server.sample.load({});
      notify(`Loaded ${result.deals} sample deals.`, { tone: "success" });
    } catch (error) {
      notify(describeError(error));
    } finally {
      setLoadingSample(false);
    }
  }

  async function exportBoard() {
    setExporting(true);
    try {
      const csv = boardCsv(visible, people, Date.now());
      await patchy.download(
        `brightline-pipeline-${isoDate(Date.now())}.csv`,
        new Blob([csv], { type: "text/csv" })
      );
      notify(`Exported ${visible.length} deal${visible.length === 1 ? "" : "s"}.`, {
        tone: "success"
      });
    } catch (error) {
      if (!isDismissedDownload(error)) notify(describeError(error));
    } finally {
      setExporting(false);
    }
  }

  const empty = deals !== undefined && deals.length === 0;
  return (
    <div class="app">
      <header class="top">
        <div class="titles">
          <p class="eyebrow">Brightline Studio</p>
          <h1>New Business</h1>
          <p class="subtitle">Every pitch from first hello to signed work.</p>
        </div>
        <div class="actions">
          <button
            type="button"
            class="btn btn-ghost btn-toggle"
            aria-pressed={mineOnly}
            disabled={viewer === null || empty}
            onClick={() => setMineOnly(!mineOnly)}
          >
            <span class="toggle-box" aria-hidden="true" />
            Mine only
          </button>
          <button type="button" class="btn btn-ghost" onClick={() => setDialog("import")}>
            Import CSV
          </button>
          <button
            type="button"
            class="btn btn-ghost"
            disabled={exporting || visible.length === 0}
            onClick={() => void exportBoard()}
          >
            {exporting ? "Exporting…" : "Export CSV"}
          </button>
          <button type="button" class="btn btn-primary" onClick={() => setDialog("new")}>
            New deal
          </button>
        </div>
      </header>

      {deals === undefined ? (
        <section class="status-panel">
          {board.error ? (
            <>
              <h2>The pipeline couldn't load</h2>
              <p class="muted">{describeError(board.error)} Reload the page to try again.</p>
            </>
          ) : (
            <p class="muted">Loading the pipeline…</p>
          )}
        </section>
      ) : empty ? (
        <EmptyState
          loading={loadingSample}
          onLoadSample={() => void loadSample()}
          onNewDeal={() => setDialog("new")}
          onImport={() => setDialog("import")}
        />
      ) : (
        <>
          <Kpis deals={visible} now={now} mineOnly={mineOnly} />
          {board.error && (
            <p class="banner">
              Live updates are reconnecting. The board shows the latest saved view.
            </p>
          )}
          {mineOnly && visible.length === 0 && (
            <p class="banner">
              You don't own any deals yet. Turn off “Mine only” to see the whole studio's pipeline.
            </p>
          )}
          <Board
            deals={visible}
            people={people}
            pending={pending}
            now={now}
            showLost={showLost}
            onToggleLost={() => setShowLost(!showLost)}
            onOpen={openDeal}
            onMove={(deal, stage) => {
              if (stage === "lost") setLosing(deal);
              else
                void moveDeal(deal, stage).then((refusal) => refusal !== null && notify(refusal));
            }}
          />
        </>
      )}

      {openDealRow !== undefined && (
        <DealDrawer
          key={openDealRow.id}
          deal={openDealRow}
          people={people}
          viewer={viewer}
          pending={pending.get(openDealRow.id)}
          now={now}
          notify={notify}
          onMove={moveDeal}
          onClose={closeDeal}
        />
      )}
      {losing !== null && (
        <LostReasonDialog
          deal={losing}
          onCancel={cancelLosing}
          onConfirm={(reason) => {
            setLosing(null);
            void moveDeal(losing, "lost", reason).then(
              (refusal) => refusal !== null && notify(refusal)
            );
          }}
        />
      )}
      {dialog === "new" && (
        <NewDealDialog notify={notify} onClose={closeDialog} onCreated={closeDialog} />
      )}
      {dialog === "import" && <ImportDialog notify={notify} onClose={closeDialog} />}
      <Toasts toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
