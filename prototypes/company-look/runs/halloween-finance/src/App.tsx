import { useEffect, useState, useQuery } from "patchy/preact";
import type { Id } from "patchy/config";
import { patchy } from "../patchy/_generated/client.js";

type Category = "scariest" | "funniest" | "group";

const CATEGORIES: readonly { key: Category; label: string; blurb: string; icon: string }[] = [
  { key: "scariest", label: "Scariest", blurb: "Nightmares, made to order.", icon: "💀" },
  { key: "funniest", label: "Funniest", blurb: "Screams of laughter count too.", icon: "🎃" },
  { key: "group", label: "Best group", blurb: "Covens, packs and haunted ensembles.", icon: "👻" }
];

const SAMPLES: readonly { name: string; costume: string; category: Category }[] = [
  { name: "Morticia Vale", costume: "The Thing in the Supply Closet", category: "scariest" },
  { name: "Grimsby Holt", costume: "Unpaid Invoice from Beyond", category: "scariest" },
  { name: "Penny Dreadful", costume: "Sentient Office Plant", category: "funniest" },
  { name: "Barnaby Crow", costume: "Printer Jam (Physical Form)", category: "funniest" },
  { name: "The Hollow Five", costume: "Headless Quarterly Review Board", category: "group" },
  { name: "Night Shift Trio", costume: "Three Witches, One Cauldron", category: "group" }
];

function message(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}

function Cobweb({ className }: { className: string }) {
  return (
    <svg class={`cobweb ${className}`} viewBox="0 0 200 200" aria-hidden="true">
      <g fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round">
        <path d="M0 0 L200 0 M0 0 L190 70 M0 0 L140 140 M0 0 L70 190 M0 0 L0 200" />
        <path d="M40 0 Q36 14 38 13 Q30 28 28 28 Q20 34 14 38 Q12 38 0 40" />
        <path d="M85 0 Q78 28 80 28 Q65 58 62 60 Q44 70 30 78 Q26 80 0 85" />
        <path d="M135 0 Q124 46 126 46 Q102 96 100 100 Q72 112 50 124 Q44 128 0 135" />
        <path d="M185 0 Q172 66 174 66 Q140 136 136 138 Q100 160 68 174 Q60 178 0 185" />
      </g>
      <g class="spider">
        <line x1="104" y1="0" x2="104" y2="104" stroke="currentColor" stroke-width="0.8" />
        <ellipse cx="104" cy="112" rx="7" ry="9" />
        <circle cx="104" cy="101" r="4.5" />
        <path
          d="M98 108 l-10 -6 M98 112 l-11 0 M98 116 l-10 6 M110 108 l10 -6 M110 112 l11 0 M110 116 l10 6"
          stroke="currentColor"
          stroke-width="1.6"
          fill="none"
        />
      </g>
    </svg>
  );
}

export function App() {
  const entries = useQuery(patchy.tables.entries.list, { limit: 500, order: "asc" });
  const votes = useQuery(patchy.tables.votes.list, { limit: 1000 });
  const [viewer, setViewer] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const [voting, setVoting] = useState<Id<"entries"> | null>(null);
  const [seeding, setSeeding] = useState(false);

  useEffect(() => {
    let active = true;
    void patchy
      .me()
      .then((me) => {
        if (active) setViewer(me?.user.id ?? null);
      })
      .catch((cause: unknown) => {
        if (active) setError(message(cause));
      });
    return () => {
      active = false;
    };
  }, []);

  const rows = entries.data?.rows ?? [];
  const voteRows = votes.data?.rows ?? [];
  const counts = new Map<Id<"entries">, number>();
  const mine = new Map<Id<"entries">, Id<"votes">>();
  for (const vote of voteRows) {
    counts.set(vote.entry, (counts.get(vote.entry) ?? 0) + 1);
    if (viewer && vote.voter === viewer) mine.set(vote.entry, vote.id);
  }

  function enter(form: HTMLFormElement) {
    if (saving || !form.reportValidity()) return;
    const data = new FormData(form);
    const name = String(data.get("name") ?? "").trim();
    const costume = String(data.get("costume") ?? "").trim();
    const category = String(data.get("category") ?? "");
    if (!name || !costume || !CATEGORIES.some((c) => c.key === category)) return;
    setSaving(true);
    setError("");
    setNotice("");
    void patchy.tables.entries
      .insert({ name, costume, category })
      .then(() => {
        form.reset();
        setNotice(`${costume} has risen from the grave. Good luck, ${name}.`);
      })
      .catch((cause: unknown) =>
        setError(`Your entry didn't make it through the veil: ${message(cause)}`)
      )
      .finally(() => setSaving(false));
  }

  function toggleVote(entryId: Id<"entries">) {
    if (!viewer || voting) return;
    const existing = mine.get(entryId);
    setVoting(entryId);
    setError("");
    const call = existing
      ? patchy.tables.votes.delete(existing)
      : patchy.tables.votes.insert({ entry: entryId, voter: viewer });
    void call
      .catch((cause: unknown) => setError(`That vote got lost in the fog: ${message(cause)}`))
      .finally(() => setVoting(null));
  }

  function loadSamples() {
    if (seeding) return;
    setSeeding(true);
    setError("");
    void patchy.tables.entries
      .insertMany(SAMPLES.map((s) => ({ ...s })))
      .catch((cause: unknown) => setError(`The sample ghouls refused to appear: ${message(cause)}`))
      .finally(() => setSeeding(false));
  }

  const firstLoad = entries.loading && !entries.data;

  return (
    <div class="haunt">
      <svg class="defs" aria-hidden="true">
        <filter id="ooze">
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.035 0.09"
            numOctaves="2"
            seed="13"
            result="noise"
          />
          <feDisplacementMap
            in="SourceGraphic"
            in2="noise"
            scale="7"
            xChannelSelector="R"
            yChannelSelector="G"
          />
        </filter>
      </svg>
      <Cobweb className="cobweb-left" />
      <Cobweb className="cobweb-right" />
      <div class="moon" aria-hidden="true" />
      <div class="bats" aria-hidden="true">
        <span>🦇</span>
        <span>🦇</span>
        <span>🦇</span>
      </div>

      <header class="hero">
        <p class="eyebrow">The office presents</p>
        <h1 class="creepy">The Costume Contest</h1>
        <p class="tagline">
          Sign up your disguise, then cast your votes. One vote per entry, per soul.
        </p>
      </header>

      <main>
        <section class="panel enter" aria-labelledby="enter-title">
          <h2 id="enter-title" class="creepy">
            Enter if you dare
          </h2>
          {/* The sandbox blocks native form submission; save through the client instead. */}
          <form
            class="entry-form"
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                event.target instanceof HTMLInputElement &&
                !event.isComposing
              ) {
                event.preventDefault();
                enter(event.currentTarget);
              }
            }}
          >
            <label>
              Your name
              <input
                name="name"
                required
                maxLength={80}
                autoComplete="off"
                placeholder="Vlad from Accounts"
                disabled={saving}
              />
            </label>
            <label>
              Costume title
              <input
                name="costume"
                required
                maxLength={120}
                autoComplete="off"
                placeholder="The Ghost of Budgets Past"
                disabled={saving}
              />
            </label>
            <fieldset disabled={saving}>
              <legend>Category</legend>
              <div class="choices">
                {CATEGORIES.map((c, i) => (
                  <label key={c.key} class="choice">
                    <input
                      type="radio"
                      name="category"
                      value={c.key}
                      required
                      defaultChecked={i === 0}
                    />
                    <span>
                      {c.icon} {c.label}
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            <button
              type="button"
              class="pumpkin-button"
              disabled={saving}
              onClick={(event) => enter(event.currentTarget.form!)}
            >
              {saving ? "Summoning…" : "Enter the contest"}
            </button>
          </form>
          <p class="notice" role="status">
            {notice}
          </p>
        </section>

        {(error || entries.error || votes.error) && (
          <p class="error" role="alert">
            {error || entries.error?.message || votes.error?.message}
          </p>
        )}

        {firstLoad ? (
          <p class="loading" role="status">
            Raising the dead…
          </p>
        ) : rows.length === 0 && !entries.error ? (
          <section class="panel empty">
            <div class="empty-ghost" aria-hidden="true">
              👻
            </div>
            <h2 class="creepy">Eerily quiet in here</h2>
            <p>
              No one has entered yet. Be the first brave soul, or conjure some invented entries to
              see how the contest looks.
            </p>
            <button type="button" class="ghost-button" disabled={seeding} onClick={loadSamples}>
              {seeding ? "Conjuring…" : "Load sample data"}
            </button>
          </section>
        ) : (
          <div class="categories">
            {CATEGORIES.map((c) => {
              const inCategory = rows
                .filter((row) => row.category === c.key)
                .sort((a, b) => (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0));
              const top = inCategory.length > 0 ? (counts.get(inCategory[0].id) ?? 0) : 0;
              return (
                <section
                  key={c.key}
                  class={`category category-${c.key}`}
                  aria-labelledby={`cat-${c.key}`}
                >
                  <header>
                    <h2 id={`cat-${c.key}`} class="creepy">
                      <span aria-hidden="true">{c.icon}</span> {c.label}
                    </h2>
                    <p>{c.blurb}</p>
                  </header>
                  {inCategory.length === 0 ? (
                    <p class="none">No entries yet. The crypt awaits.</p>
                  ) : (
                    <ul>
                      {inCategory.map((row) => {
                        const count = counts.get(row.id) ?? 0;
                        const voted = mine.has(row.id);
                        const leading = count > 0 && count === top;
                        return (
                          <li key={row.id} class={`entry${leading ? " leading" : ""}`}>
                            <div class="entry-text">
                              <strong>{row.costume}</strong>
                              <span>{row.name}</span>
                            </div>
                            <div class="entry-vote">
                              <span
                                class="count"
                                aria-label={`${count} ${count === 1 ? "vote" : "votes"}`}
                              >
                                {leading && (
                                  <span class="crown" title="Leading">
                                    🕯️
                                  </span>
                                )}
                                {count}
                              </span>
                              <button
                                type="button"
                                class={voted ? "vote voted" : "vote"}
                                aria-pressed={voted}
                                disabled={!viewer || voting === row.id}
                                title={viewer ? undefined : "Sign in to vote"}
                                onClick={() => toggleVote(row.id)}
                              >
                                {voted ? "Voted 🩸" : "Vote"}
                              </button>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </section>
              );
            })}
          </div>
        )}
      </main>
      <div class="fog" aria-hidden="true" />
      <footer>Vote again on a costume to take your vote back. Results update live.</footer>
    </div>
  );
}
