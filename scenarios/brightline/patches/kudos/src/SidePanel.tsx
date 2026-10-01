import { useMemo, useQuery } from "patchy/preact";
import { patchy } from "../patchy/_generated/client.js";
import { VALUES } from "./model.js";
import type { Filter } from "./model.js";
import { Avatar, hueFor, personName, usePeople } from "./people.js";
import { daysAgoStart } from "./time.js";

const WINDOW_DAYS = 30;
const LEADERS = 5;

/**
 * Rolling 30-day recognition: a headline count, the most-thanked people and the value mix.
 * Clicking a person or value narrows the wall; clicking it again clears that filter.
 */
export function SidePanel({
  filter,
  now,
  onFilter
}: {
  filter: Filter;
  now: number;
  onFilter: (filter: Filter) => void;
}) {
  // Stable for a whole day, so the subscription only changes at midnight.
  const since = daysAgoStart(now, WINDOW_DAYS);
  const recent = useQuery(patchy.tables.kudos.list, {
    index: "bySentAt",
    range: { column: "sentAt", gte: since },
    order: "desc",
    limit: 1000
  });
  const rows = recent.data?.rows;

  const { leaders, values, thanked } = useMemo(() => {
    const received = new Map<string, { count: number; latest: string }>();
    const byValue = new Map<string, number>();
    for (const row of rows ?? []) {
      const entry = received.get(row.recipient) ?? { count: 0, latest: row.sentAt };
      received.set(row.recipient, {
        count: entry.count + 1,
        latest: entry.latest > row.sentAt ? entry.latest : row.sentAt
      });
      byValue.set(row.value, (byValue.get(row.value) ?? 0) + 1);
    }
    return {
      leaders: [...received]
        .sort(([, a], [, b]) => b.count - a.count || b.latest.localeCompare(a.latest))
        .slice(0, LEADERS)
        .map(([id, { count }]) => ({ id, count })),
      values: VALUES.map((value) => ({ ...value, count: byValue.get(value.key) ?? 0 })),
      thanked: received.size
    };
  }, [rows]);

  const people = usePeople(useMemo(() => leaders.map((leader) => leader.id), [leaders]));
  const total = rows?.length ?? 0;
  const topCount = leaders[0]?.count ?? 0;
  const topValue = Math.max(1, ...values.map((value) => value.count));

  return (
    <div className="side">
      <div className="hero-tile">
        <p className="hero-tile__label">Last {WINDOW_DAYS} days</p>
        <p className="hero-tile__value">{rows ? total : "–"}</p>
        <p className="hero-tile__sub">
          {rows === undefined
            ? "Counting kudos…"
            : total === 0
              ? "Nothing shared yet. Start the streak."
              : `kudos shared · ${thanked} ${thanked === 1 ? "person" : "people"} thanked`}
        </p>
      </div>

      {recent.error && (
        <p className="notice notice--error" role="alert">
          Totals couldn't refresh. They'll catch up when the connection returns.
        </p>
      )}

      <section className="panel" aria-labelledby="leaders-title">
        <h2 id="leaders-title" className="section-title section-title--sm">
          Most appreciated
        </h2>
        {leaders.length === 0 ? (
          <p className="panel__empty">
            {rows === undefined ? "Loading…" : "Nobody has been thanked in the last 30 days yet."}
          </p>
        ) : (
          <ol className="leaders">
            {leaders.map((leader, index) => {
              const person = people.get(leader.id);
              const active = filter.recipient === leader.id;
              return (
                <li key={leader.id}>
                  <button
                    type="button"
                    className="leader"
                    data-hue={hueFor(leader.id)}
                    aria-pressed={active}
                    title={
                      active
                        ? "Show everyone's kudos"
                        : `Show kudos for ${personName(person) || "this person"}`
                    }
                    onClick={() => onFilter({ ...filter, recipient: active ? null : leader.id })}
                  >
                    <span className="leader__rank">{index + 1}</span>
                    <Avatar id={leader.id} person={person} size="sm" />
                    <span className="leader__name">{personName(person)}</span>
                    <span className="leader__count">{leader.count}</span>
                    <span className="bar" aria-hidden="true">
                      <span
                        className="bar__fill"
                        style={{ width: `${(leader.count / topCount) * 100}%` }}
                      />
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      <section className="panel" aria-labelledby="values-title">
        <h2 id="values-title" className="section-title section-title--sm">
          By value
        </h2>
        <ul className="value-breakdown">
          {values.map((value) => {
            const active = filter.value === value.key;
            return (
              <li key={value.key}>
                <button
                  type="button"
                  className="value-row"
                  data-value={value.key}
                  aria-pressed={active}
                  title={active ? "Show every value" : value.hint}
                  onClick={() => onFilter({ ...filter, value: active ? null : value.key })}
                >
                  <span className="value-dot" aria-hidden="true" />
                  <span className="value-row__label">{value.label}</span>
                  <span className="value-row__count">{value.count}</span>
                  <span className="bar" aria-hidden="true">
                    <span
                      className="bar__fill"
                      style={{ width: `${(value.count / topValue) * 100}%` }}
                    />
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
