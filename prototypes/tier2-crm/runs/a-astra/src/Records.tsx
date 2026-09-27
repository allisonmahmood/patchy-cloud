import { useQuery, useState } from "patchy/preact";
import { patchy } from "../patchy/_generated/client.js";
import { CompanyContracts } from "./Integrations.js";
import { Empty, ErrorBox, OwnerName, Pager, money } from "./ui.js";
import type { Company, Contact, Deal, Team } from "./ui.js";

export function Contacts({
  team,
  companyId,
  create,
  edit
}: {
  team: Team;
  companyId?: Company["id"];
  create: () => void;
  edit: (contact: Contact) => void;
}) {
  const [cursor, setCursor] = useState<string>();
  const { data, error } = useQuery(patchy.server.contacts.list, {
    ...(companyId ? { companyId } : {}),
    ...(cursor ? { cursor } : {})
  });
  return (
    <section>
      <header className={companyId ? "section-heading" : "page-heading"}>
        <div>
          {!companyId && <div className="eyebrow">YOUR NETWORK</div>}
          {companyId ? <h2>Contacts</h2> : <h1>Contacts</h1>}
          {!companyId && <p>The people behind every conversation.</p>}
        </div>
        <button type="button" onClick={create}>
          + New contact
        </button>
      </header>
      <ErrorBox error={error} />
      {!error && data && (
        <div className="panel">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Contact</th>
                  {!companyId && <th>Company</th>}
                  <th>Role / phone</th>
                  <th>Owner</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <strong>
                        {[row.firstName, row.lastName].filter(Boolean).join(" ") || row.email}
                      </strong>
                      <small>{row.email}</small>
                    </td>
                    {!companyId && (
                      <td>
                        {data.companies.find((c) => c.id === row.companyId)?.name ??
                          "Company unavailable"}
                      </td>
                    )}
                    <td>
                      {row.title || "—"}
                      <small>{row.phone || "No phone"}</small>
                    </td>
                    <td>
                      <OwnerName id={row.ownerId} team={team} />
                    </td>
                    <td>
                      {row.ownerId === team.viewerId ? (
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => edit(row)}
                          aria-label={`Edit ${row.email}`}
                        >
                          Edit
                        </button>
                      ) : (
                        <span className="muted">View only</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!data.rows.length && <Empty>No contacts yet. Add one or import your CSV.</Empty>}
          <Pager cursor={data.cursor} next={setCursor} reset={() => setCursor(undefined)} />
        </div>
      )}
      {!data && !error && <p className="muted">Loading contacts…</p>}
    </section>
  );
}
export function Companies({
  team,
  create,
  open
}: {
  team: Team;
  create: () => void;
  open: (id: Company["id"]) => void;
}) {
  const [search, setSearch] = useState("");
  const [cursor, setCursor] = useState<string>();
  const { data, error } = useQuery(patchy.server.companies.list, {
    search,
    ...(cursor ? { cursor } : {})
  });
  return (
    <>
      <header className="page-heading">
        <div>
          <div className="eyebrow">CUSTOMER ACCOUNTS</div>
          <h1>Companies</h1>
          <p>Relationships, contracts and opportunities in one place.</p>
        </div>
        <button type="button" onClick={create}>
          + New company
        </button>
      </header>
      <div className="toolbar">
        <input
          className="search"
          aria-label="Search companies"
          placeholder="Search company names…"
          value={search}
          onChange={(e) => {
            setSearch(e.currentTarget.value);
            setCursor(undefined);
          }}
        />
        <span className="muted">Shared with your team</span>
      </div>
      <ErrorBox error={error} />
      {!error && data && (
        <div className="panel">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Company</th>
                  <th>Owner</th>
                  <th>Added</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <button
                        type="button"
                        className="text-button company-name"
                        onClick={() => open(row.id)}
                      >
                        <span className="company-mark">{row.name.slice(0, 2).toUpperCase()}</span>
                        {row.name}
                      </button>
                    </td>
                    <td>
                      <OwnerName id={row.ownerId} team={team} />
                    </td>
                    <td className="muted">{new Date(row.createdAt).toLocaleDateString()}</td>
                    <td>
                      <button type="button" className="secondary" onClick={() => open(row.id)}>
                        Open
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!data.rows.length && (
            <Empty>
              {search
                ? "No matching companies. Try the start of another name."
                : "Start with a company, or import contacts to create companies automatically."}
            </Empty>
          )}
          <Pager cursor={data.cursor} next={setCursor} reset={() => setCursor(undefined)} />
        </div>
      )}
    </>
  );
}
function CompanyDeals({
  companyId,
  open
}: {
  companyId: Company["id"];
  open: (id: Deal["id"]) => void;
}) {
  const [cursor, setCursor] = useState<string>();
  const { data, error } = useQuery(patchy.server.deals.list, {
    companyId,
    ...(cursor ? { cursor } : {})
  });
  return (
    <>
      <ErrorBox error={error} />
      {!error && data && (
        <div className="panel">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Deal</th>
                  <th>Stage</th>
                  <th>Value</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <button type="button" className="text-button" onClick={() => open(row.id)}>
                        {row.title}
                      </button>
                      {row.private && <span className="badge private">Private</span>}
                    </td>
                    <td>
                      <span className="badge">{row.stage}</span>
                    </td>
                    <td>{money(row.valueCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!data.rows.length && <Empty>No visible deals on this page.</Empty>}
          <Pager cursor={data.cursor} next={setCursor} reset={() => setCursor(undefined)} />
        </div>
      )}
    </>
  );
}
export function CompanyDetail({
  id,
  team,
  back,
  edit,
  newContact,
  editContact,
  newDeal,
  openDeal
}: {
  id: Company["id"];
  team: Team;
  back: () => void;
  edit: (row: Company) => void;
  newContact: () => void;
  editContact: (row: Contact) => void;
  newDeal: () => void;
  openDeal: (id: Deal["id"]) => void;
}) {
  const { data, error } = useQuery(patchy.server.companies.get, { id });
  return (
    <>
      <button type="button" className="text-button breadcrumb" onClick={back}>
        ‹ All companies
      </button>
      <ErrorBox error={error} />
      {!error && data && (
        <>
          <header className="page-heading">
            <div>
              <div className="eyebrow">COMPANY</div>
              <h1>{data.name}</h1>
              <p>
                Owned by <OwnerName id={data.ownerId} team={team} />
              </p>
            </div>
            {data.ownerId === team.viewerId && (
              <button type="button" className="secondary" onClick={() => edit(data)}>
                Edit company
              </button>
            )}
          </header>
          <div className="company-layout">
            <div className="company-records">
              <section>
                <header className="section-heading">
                  <h2>Deals</h2>
                  <button type="button" onClick={newDeal}>
                    + New deal
                  </button>
                </header>
                <CompanyDeals companyId={id} open={openDeal} />
              </section>
              <Contacts team={team} companyId={id} create={newContact} edit={editContact} />
            </div>
            <aside>
              <CompanyContracts companyId={id} />
            </aside>
          </div>
        </>
      )}
    </>
  );
}
