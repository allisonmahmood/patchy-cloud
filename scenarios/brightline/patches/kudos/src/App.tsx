import { useEffect, useState } from "patchy/preact";
import { patchy } from "../patchy/_generated/client.js";
import { Composer } from "./Composer.js";
import type { Filter } from "./model.js";
import { Avatar } from "./people.js";
import { SidePanel } from "./SidePanel.js";
import { useNow } from "./time.js";
import { Wall } from "./Wall.js";

type Me = Awaited<ReturnType<typeof patchy.me>>;

const EVERYONE: Filter = { recipient: null, value: null };

export function App() {
  // undefined while loading; null on a public page, where nobody is signed in.
  const [me, setMe] = useState<Me | undefined>(undefined);
  const [filter, setFilter] = useState<Filter>(EVERYONE);
  const now = useNow();

  useEffect(() => {
    let current = true;
    patchy.me().then(
      (viewer) => current && setMe(viewer),
      () => current && setMe(null)
    );
    return () => {
      current = false;
    };
  }, []);

  const meId = me?.user.id;

  return (
    <div className="app">
      <header className="page-head">
        <div>
          <p className="eyebrow">Brightline Studio</p>
          <h1 className="page-title">Kudos</h1>
          <p className="page-sub">Say thanks where everyone can see it.</p>
        </div>
        {me && (
          <div className="whoami">
            <Avatar
              id={me.user.id}
              person={{ ...me.user, admin: me.admin, active: true }}
              size="sm"
            />
            <span>
              Signed in as <strong>{me.user.name}</strong>
            </span>
          </div>
        )}
      </header>

      <div className="layout">
        <main className="main">
          {me === null ? (
            <p className="notice">Sign in to Patchy to give kudos and react.</p>
          ) : (
            <Composer meId={meId} />
          )}
          <Wall
            key={`${filter.recipient}:${filter.value}`}
            filter={filter}
            meId={meId}
            now={now}
            onFilter={setFilter}
          />
        </main>
        <aside className="aside" aria-label="Recognition summary">
          <SidePanel filter={filter} now={now} onFilter={setFilter} />
        </aside>
      </div>
    </div>
  );
}
