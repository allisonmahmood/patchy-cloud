import { useEffect, useQuery, useState } from "patchy/preact";
import { patchy } from "../patchy/_generated/client.js";
import { Pipeline } from "./Pipeline.js";
import { Companies, CompanyDetail, Contacts } from "./Records.js";
import { CompanyEditor, ContactEditor, DealDetail, DealEditor } from "./Editors.js";
import { ImportContacts } from "./ImportContacts.js";
import { FinanceReport } from "./Integrations.js";
import { ErrorBox, errorMessage } from "./ui.js";
import type { Company, Contact, Deal } from "./ui.js";
import "./style.css";

type Editor =
  | { kind: "company"; row?: Company }
  | { kind: "contact"; row?: Contact; companyId?: Company["id"] }
  | { kind: "deal"; row?: Deal; companyId?: Company["id"] }
  | { kind: "detail"; id: Deal["id"] };
const navigation = [
  { path: "/pipeline", name: "Pipeline", icon: "M3 4h5v16H3zM10 4h5v10h-5zM17 4h4v13h-4z" },
  {
    path: "/contacts",
    name: "Contacts",
    icon: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M16 3a4 4 0 0 1 0 8M22 21v-2a4 4 0 0 0-3-3.87M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0"
  },
  {
    path: "/companies",
    name: "Companies",
    icon: "M4 21V3h12v18M2 21h20M16 9h4v12M8 7h4M8 11h4M8 15h4"
  },
  { path: "/import", name: "Import contacts", icon: "M12 3v12M7 10l5 5 5-5M4 16v5h16v-5" },
  { path: "/finance", name: "Finance", icon: "M3 21h18M6 17V9M12 17V3M18 17v-6" }
];
export function App() {
  const [route, setRoute] = useState("/pipeline");
  const [editor, setEditor] = useState<Editor>();
  const [notice, setNotice] = useState("");
  const [startupError, setStartupError] = useState("");
  const { data: team, error: teamError, status } = useQuery(patchy.server.team.list, {});
  useEffect(() => {
    void patchy.server.team
      .join({})
      .catch((cause: unknown) => setStartupError(errorMessage(cause)));
    void patchy.route
      .get()
      .then((path) => setRoute(path === "/" ? "/pipeline" : path))
      .catch((cause: unknown) => setStartupError(errorMessage(cause)));
    return patchy.route.subscribe((path) => {
      setRoute(path === "/" ? "/pipeline" : path);
      setEditor(undefined);
    });
  }, []);
  const navigate = (path: string) => {
    setRoute(path);
    setEditor(undefined);
    setNotice("");
    void patchy.route.set(path).catch((cause: unknown) => setStartupError(errorMessage(cause)));
  };
  const saved = (message: string) => {
    setEditor(undefined);
    setNotice(message);
  };
  const viewer = team?.members.find((m) => m.userId === team.viewerId);
  const companyId = route.startsWith("/companies/")
    ? (route.slice("/companies/".length) as Company["id"])
    : undefined;
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">c</span>
          <div>
            Common<span>TEAM CRM</span>
          </div>
        </div>
        <div className="workspace-label">WORKSPACE</div>
        <nav aria-label="Main navigation">
          {navigation.map((item) => (
            <button
              type="button"
              key={item.path}
              className={
                route === item.path || (item.path === "/companies" && companyId) ? "selected" : ""
              }
              onClick={() => navigate(item.path)}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d={item.icon} />
              </svg>
              {item.name}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="workspace-note">
            A shared view.
            <br />
            Clear ownership.
          </div>
          <div className="viewer">
            <span className="avatar">{viewer?.name.slice(0, 1) ?? "?"}</span>
            <div>
              <strong>{viewer?.name ?? "Connecting…"}</strong>
              <small>{viewer?.email ?? "Authenticated workspace"}</small>
            </div>
          </div>
        </div>
      </aside>
      <main>
        <div className="topbar">
          <span>
            Workspace <span className="slash">/</span>{" "}
            {companyId
              ? "Companies"
              : (navigation.find((n) => n.path === route)?.name ?? "Pipeline")}
          </span>
          <span className="session-label">
            {status === "up-to-date"
              ? "Connected"
              : status === "resyncing"
                ? "Reconnecting…"
                : "Connecting…"}
          </span>
        </div>
        <div className="page-content">
          <ErrorBox error={startupError || teamError} />
          {notice && (
            <div className="notice dismissible" role="status">
              {notice}
              <button
                type="button"
                className="text-button"
                aria-label="Dismiss notification"
                onClick={() => setNotice("")}
              >
                Dismiss
              </button>
            </div>
          )}
          {team && !teamError ? (
            <>
              {companyId ? (
                <CompanyDetail
                  key={companyId}
                  id={companyId}
                  team={team}
                  back={() => navigate("/companies")}
                  edit={(row) => setEditor({ kind: "company", row })}
                  newContact={() => setEditor({ kind: "contact", companyId })}
                  editContact={(row) => setEditor({ kind: "contact", row })}
                  newDeal={() => setEditor({ kind: "deal", companyId })}
                  openDeal={(id) => setEditor({ kind: "detail", id })}
                />
              ) : route === "/contacts" ? (
                <Contacts
                  team={team}
                  create={() => setEditor({ kind: "contact" })}
                  edit={(row) => setEditor({ kind: "contact", row })}
                />
              ) : route === "/companies" ? (
                <Companies
                  team={team}
                  create={() => setEditor({ kind: "company" })}
                  open={(id) => navigate(`/companies/${encodeURIComponent(id)}`)}
                />
              ) : route === "/import" ? (
                <ImportContacts />
              ) : route === "/finance" ? (
                <>
                  <header className="page-heading">
                    <div>
                      <div className="eyebrow">FINANCE LEDGER</div>
                      <h1>Finance</h1>
                      <p>Invoiced, paid and outstanding for your companies.</p>
                    </div>
                  </header>
                  <FinanceReport />
                </>
              ) : (
                <Pipeline
                  team={team}
                  create={() => setEditor({ kind: "deal" })}
                  open={(id) => setEditor({ kind: "detail", id })}
                />
              )}
              {editor?.kind === "company" && (
                <CompanyEditor
                  row={editor.row}
                  team={team}
                  close={() => setEditor(undefined)}
                  saved={saved}
                />
              )}
              {editor?.kind === "contact" && (
                <ContactEditor
                  row={editor.row}
                  companyId={editor.companyId}
                  team={team}
                  close={() => setEditor(undefined)}
                  saved={saved}
                />
              )}
              {editor?.kind === "deal" && (
                <DealEditor
                  row={editor.row}
                  companyId={editor.companyId}
                  team={team}
                  close={() => setEditor(undefined)}
                  saved={saved}
                />
              )}
              {editor?.kind === "detail" && (
                <DealDetail
                  id={editor.id}
                  team={team}
                  close={() => setEditor(undefined)}
                  saved={saved}
                  edit={(row) => setEditor({ kind: "deal", row })}
                />
              )}
            </>
          ) : (
            !teamError && <p>Opening your CRM…</p>
          )}
        </div>
      </main>
    </div>
  );
}
