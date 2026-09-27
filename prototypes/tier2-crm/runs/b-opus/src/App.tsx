import { useEffect, useState } from "patchy/preact";
import type { Me } from "patchy/client";
import { patchy } from "../patchy/_generated/client.js";
import { Companies, CompanyPage } from "./Companies.js";
import { Contacts, Import } from "./Contacts.js";
import { DealPage, Pipeline } from "./Deals.js";
import { Finance } from "./Finance.js";
import { App as AppContext, describe, type View } from "./ui.js";

const tabs = [
  ["pipeline", "Pipeline"],
  ["companies", "Companies"],
  ["contacts", "Contacts"],
  ["import", "Import"],
  ["finance", "Finance"]
] as const;

/** Which tab a view lives under, for highlighting. */
const section = (view: View) =>
  view.name === "company" ? "companies" : view.name === "deal" ? "pipeline" : view.name;

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState("");
  const [view, setView] = useState<View>({ name: "pipeline" });
  useEffect(() => {
    patchy
      .me()
      .then(async (viewer) => {
        if (viewer === null) throw new Error("Sign in to use the CRM.");
        // Joining the team roster lets colleagues hand records to this viewer.
        await patchy.server.team.join({});
        setMe(viewer);
      })
      .catch((cause: unknown) => setError(describe(cause)));
  }, []);
  if (error)
    return (
      <p class="alert" role="alert">
        {error}
      </p>
    );
  if (me === null) return <p class="muted pad">Loading…</p>;
  return (
    <AppContext.Provider value={{ me, go: setView }}>
      <nav class="nav">
        <strong class="brand">CRM</strong>
        {tabs.map(([name, label]) => (
          <button
            key={name}
            type="button"
            class={section(view) === name ? "tab active" : "tab"}
            onClick={() => setView({ name })}
          >
            {label}
          </button>
        ))}
        <span class="muted me" id="viewer">
          {me.user.name}
        </span>
      </nav>
      <main>
        {view.name === "pipeline" && <Pipeline />}
        {view.name === "companies" && <Companies />}
        {view.name === "company" && <CompanyPage key={view.id} id={view.id} />}
        {view.name === "deal" && <DealPage key={view.id} id={view.id} />}
        {view.name === "contacts" && <Contacts />}
        {view.name === "import" && <Import />}
        {view.name === "finance" && <Finance />}
      </main>
    </AppContext.Provider>
  );
}
