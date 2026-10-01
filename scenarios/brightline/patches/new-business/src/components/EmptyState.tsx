interface EmptyStateProps {
  readonly loading: boolean;
  readonly onLoadSample: () => void;
  readonly onNewDeal: () => void;
  readonly onImport: () => void;
}

/** First-run screen: a sketch of the board and three ways to fill it. */
export function EmptyState({ loading, onLoadSample, onNewDeal, onImport }: EmptyStateProps) {
  return (
    <section class="empty">
      <div class="empty-sketch" aria-hidden="true">
        {["lead", "discovery", "proposal", "negotiation", "won"].map((stage, index) => (
          <div key={stage} class="sketch-column">
            <span class={`dot stage-dot-${stage}`} />
            {Array.from({ length: 3 - Math.min(index, 2) }, (_, card) => (
              <div key={card} class="sketch-card" />
            ))}
          </div>
        ))}
      </div>
      <h2>Your pipeline starts here</h2>
      <p class="muted">
        Track every pitch from first hello to signed work. Add a deal, import a list of leads, or
        load sample deals to see how the board works.
      </p>
      <div class="empty-actions">
        <button type="button" class="btn btn-primary" disabled={loading} onClick={onLoadSample}>
          {loading ? "Loading sample data…" : "Load sample data"}
        </button>
        <button type="button" class="btn btn-ghost" onClick={onNewDeal}>
          New deal
        </button>
        <button type="button" class="btn btn-ghost" onClick={onImport}>
          Import CSV
        </button>
      </div>
    </section>
  );
}
