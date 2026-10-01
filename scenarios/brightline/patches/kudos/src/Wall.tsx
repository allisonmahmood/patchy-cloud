import { useEffect, useMemo, useRef, useState, useQuery } from "patchy/preact";
import { isPatchyError, patchy } from "../patchy/_generated/client.js";
import { writeFailure } from "./errors.js";
import { EMOJIS, valueLabel } from "./model.js";
import type { Emoji, Filter, Kudos, People, Reaction } from "./model.js";
import { Avatar, personName, usePeople } from "./people.js";
import { SampleRefused, loadSampleData } from "./sample.js";
import { fullDate, relativeTime } from "./time.js";

const PAGE = 24;

/** Arrivals in one snapshot above this count are a bulk load (sample data), not a moment. */
const MOMENT_MAX = 3;

/** Newest-first kudos, narrowed by the side panel's filter, with live reactions. */
export function Wall({
  filter,
  meId,
  now,
  onFilter
}: {
  filter: Filter;
  meId: string | undefined;
  now: number;
  onFilter: (filter: Filter) => void;
}) {
  const [limit, setLimit] = useState(PAGE);
  const { recipient, value } = filter;
  const wall = useQuery(
    patchy.tables.kudos.list,
    recipient && value
      ? { index: "byRecipientValue", eq: { recipient, value }, order: "desc", limit }
      : recipient
        ? { index: "byRecipient", eq: { recipient }, order: "desc", limit }
        : value
          ? { index: "byValue", eq: { value }, order: "desc", limit }
          : { index: "bySentAt", order: "desc", limit }
  );
  // "Show older kudos" changes the limit, which starts a new subscription. Keep showing the
  // current page until the longer one lands so the wall doesn't blank and jump.
  const [retained, setRetained] = useState(wall.data);
  useEffect(() => {
    if (wall.data) setRetained(wall.data);
  }, [wall.data]);
  const page = wall.data ?? retained;
  // The newest 1,000 reactions, grouped per kudos. Plenty for a studio wall's visible history.
  const reactionsQuery = useQuery(patchy.tables.reactions.list, { limit: 1000 });

  const rows = page?.rows;
  const byKudos = useMemo(() => {
    const grouped = new Map<string, Reaction[]>();
    for (const reaction of reactionsQuery.data?.rows ?? []) {
      const list = grouped.get(reaction.kudos) ?? [];
      list.push(reaction);
      grouped.set(reaction.kudos, list);
    }
    return grouped;
  }, [reactionsQuery.data]);

  const ids = useMemo(
    () => [
      ...(rows ?? []).flatMap((row) => [row.sender, row.recipient]),
      ...(reactionsQuery.data?.rows ?? []).map((reaction) => reaction.member)
    ],
    [rows, reactionsQuery.data]
  );
  const people = usePeople(ids);
  const { fresh, settle, announcement } = useArrivals(rows, meId, people);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  const filtered = recipient !== null || value !== null;

  return (
    <section className="wall" aria-labelledby="wall-title">
      <div className="wall__head">
        <h2 id="wall-title" className="section-title">
          The wall
        </h2>
        {rows && rows.length > 0 && (
          <span className="wall__count">
            {page?.cursor ? `Latest ${rows.length}` : `${rows.length} kudos`}
          </span>
        )}
        <FilterBar filter={filter} onFilter={onFilter} />
      </div>

      {wall.error && (
        <p className="notice notice--error" role="alert">
          The wall couldn't refresh. It will catch up when the connection returns.
        </p>
      )}

      {rows === undefined ? (
        wall.error ? null : (
          <p className="wall__loading">Loading kudos…</p>
        )
      ) : rows.length === 0 ? (
        filtered ? (
          <div className="empty empty--compact">
            <p className="empty__title">No kudos match this filter yet</p>
            <p className="empty__text">
              Clear the filter to see the whole wall, or be the first to send one.
            </p>
          </div>
        ) : (
          <EmptyWall onError={setNotice} />
        )
      ) : (
        <div className="wall__grid">
          {rows.map((row) => (
            <KudosCard
              key={row.id}
              kudos={row}
              people={people}
              reactions={byKudos.get(row.id) ?? []}
              meId={meId}
              now={now}
              fresh={fresh.has(row.id)}
              onSettled={() => settle(row.id)}
              onError={setNotice}
            />
          ))}
        </div>
      )}

      {page?.cursor && (
        <div className="wall__more">
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => setLimit(limit + PAGE)}
            disabled={!wall.data}
          >
            {wall.data ? "Show older kudos" : "Loading…"}
          </button>
        </div>
      )}

      <p className="visually-hidden" aria-live="polite">
        {announcement}
      </p>
      {notice && (
        <div className="toast" role="alert">
          {notice}
        </div>
      )}
    </section>
  );
}

/**
 * Spots kudos that arrive live from someone else so their card can play its one-shot highlight.
 * The first snapshot, older pages and bulk loads never count as arrivals.
 */
function useArrivals(rows: readonly Kudos[] | undefined, meId: string | undefined, people: People) {
  const seen = useRef<{ ids: Set<string>; newest: string } | null>(null);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(() => new Set());
  const [arrived, setArrived] = useState<Kudos | null>(null);

  useEffect(() => {
    if (!rows) return;
    const newest = rows.reduce(
      (max, row) => (row.createdAt > max ? row.createdAt : max),
      seen.current?.newest ?? ""
    );
    const previous = seen.current;
    seen.current = {
      ids: new Set([...(previous?.ids ?? []), ...rows.map((row) => row.id)]),
      newest
    };
    if (!previous) return;
    const incoming = rows.filter(
      (row) => !previous.ids.has(row.id) && row.createdAt > previous.newest && row.sender !== meId
    );
    if (incoming.length === 0 || incoming.length > MOMENT_MAX) return;
    setFresh((current) => new Set([...current, ...incoming.map((row) => row.id)]));
    setArrived(incoming[0]!);
  }, [rows, meId]);

  return {
    fresh,
    settle: (id: string) =>
      setFresh((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      }),
    announcement: arrived
      ? `New kudos: ${personName(people.get(arrived.sender))} thanked ${personName(people.get(arrived.recipient))}.`
      : ""
  };
}

function KudosCard({
  kudos,
  people,
  reactions,
  meId,
  now,
  fresh,
  onSettled,
  onError
}: {
  kudos: Kudos;
  people: People;
  reactions: readonly Reaction[];
  meId: string | undefined;
  now: number;
  fresh: boolean;
  onSettled: () => void;
  onError: (message: string) => void;
}) {
  const sender = people.get(kudos.sender);
  const recipient = people.get(kudos.recipient);
  return (
    <article
      className={`kudos-card${fresh ? " is-fresh" : ""}`}
      data-value={kudos.value}
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget) onSettled();
      }}
    >
      <header className="kudos-card__head">
        <div className="kudos-card__people">
          <Avatar id={kudos.sender} person={sender} />
          <span className="kudos-card__sender">{personName(sender)}</span>
          <svg className="kudos-card__arrow" viewBox="0 0 16 16" aria-label="thanked" role="img">
            <path
              d="M3 8h9m-3.5-3.5L12 8l-3.5 3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <Avatar id={kudos.recipient} person={recipient} />
          <span className="kudos-card__recipient">{personName(recipient)}</span>
        </div>
        <div className="kudos-card__when">
          {fresh && <span className="fresh-tag">Just in</span>}
          <time dateTime={kudos.sentAt} title={fullDate(kudos.sentAt)}>
            {relativeTime(kudos.sentAt, now)}
          </time>
        </div>
      </header>
      <span className="value-chip" data-value={kudos.value}>
        <span className="value-dot" aria-hidden="true" />
        {valueLabel(kudos.value)}
      </span>
      <p className="kudos-card__message">{kudos.message}</p>
      <Reactions
        kudos={kudos}
        reactions={reactions}
        people={people}
        meId={meId}
        onError={onError}
      />
    </article>
  );
}

function Reactions({
  kudos,
  reactions,
  people,
  meId,
  onError
}: {
  kudos: Kudos;
  reactions: readonly Reaction[];
  people: People;
  meId: string | undefined;
  onError: (message: string) => void;
}) {
  const [pending, setPending] = useState<ReadonlySet<Emoji>>(() => new Set());

  async function toggle(emoji: Emoji, mine: Reaction | undefined) {
    if (meId === undefined || pending.has(emoji)) return;
    setPending((current) => new Set(current).add(emoji));
    try {
      if (mine) await patchy.tables.reactions.delete(mine.id);
      else await patchy.tables.reactions.insert({ kudos: kudos.id, member: meId, emoji });
    } catch (cause) {
      // A double click can race another tab; an existing reaction is already the state we wanted.
      if (!isPatchyError(cause, "unique_violation")) onError(writeFailure(cause, "reaction"));
    } finally {
      setPending((current) => {
        const next = new Set(current);
        next.delete(emoji);
        return next;
      });
    }
  }

  return (
    <div className="reactions" role="group" aria-label="Reactions">
      {EMOJIS.map((emoji) => {
        const given = reactions.filter((reaction) => reaction.emoji === emoji);
        const mine = given.find((reaction) => reaction.member === meId);
        const names = given
          .map((reaction) =>
            reaction.member === meId ? "You" : personName(people.get(reaction.member))
          )
          .filter(Boolean);
        return (
          <button
            key={emoji}
            type="button"
            className={`reaction${given.length > 0 ? " has-count" : ""}`}
            aria-pressed={mine !== undefined}
            aria-busy={pending.has(emoji)}
            title={names.length > 0 ? `${names.join(", ")}` : `React with ${emoji}`}
            disabled={meId === undefined}
            onClick={() => void toggle(emoji, mine)}
          >
            <span className="reaction__emoji" aria-hidden="true">
              {emoji}
            </span>
            {given.length > 0 && <span className="reaction__count">{given.length}</span>}
            <span className="visually-hidden">
              {mine ? `Remove your ${emoji}` : `React with ${emoji}`}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** First-run state: nothing on the wall yet, with an optional set of realistic examples. */
function EmptyWall({ onError }: { onError: (message: string) => void }) {
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      await loadSampleData();
    } catch (cause) {
      onError(cause instanceof SampleRefused ? cause.message : writeFailure(cause, "sample kudos"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="empty">
      <div className="empty__emoji" aria-hidden="true">
        👏
      </div>
      <p className="empty__title">No kudos yet</p>
      <p className="empty__text">
        Be the first to thank someone above, or load a few example kudos to see how the wall comes
        alive.
      </p>
      <button
        type="button"
        className="btn btn--ghost"
        disabled={loading}
        onClick={() => void load()}
      >
        {loading ? "Adding sample kudos…" : "Load sample data"}
      </button>
    </div>
  );
}

/** The active filters as removable chips, shown only while the wall is narrowed. */
function FilterBar({ filter, onFilter }: { filter: Filter; onFilter: (filter: Filter) => void }) {
  const people = usePeople(filter.recipient ? [filter.recipient] : []);
  if (filter.recipient === null && filter.value === null) return null;
  return (
    <div className="filter-bar" role="group" aria-label="Wall filters">
      <span className="filter-bar__label">Showing</span>
      {filter.recipient && (
        <button
          type="button"
          className="filter-chip"
          onClick={() => onFilter({ ...filter, recipient: null })}
        >
          Kudos for {personName(people.get(filter.recipient)) || "…"}
          <span aria-hidden="true" className="filter-chip__x">
            ×
          </span>
          <span className="visually-hidden">Remove filter</span>
        </button>
      )}
      {filter.value && (
        <button
          type="button"
          className="filter-chip"
          data-value={filter.value}
          onClick={() => onFilter({ ...filter, value: null })}
        >
          <span className="value-dot" aria-hidden="true" />
          {valueLabel(filter.value)}
          <span aria-hidden="true" className="filter-chip__x">
            ×
          </span>
          <span className="visually-hidden">Remove filter</span>
        </button>
      )}
      <button
        type="button"
        className="link-button"
        onClick={() => onFilter({ recipient: null, value: null })}
      >
        Clear
      </button>
    </div>
  );
}
