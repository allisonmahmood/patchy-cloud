import { useState } from "patchy/preact";
import { useQuery } from "patchy/preact";
import {
  patchy,
  money,
  describe,
  useTeam,
  useRunner,
  useOwnerName,
  Ownership,
  onEnter,
  type Company,
  type Deal
} from "./lib.js";
import { DealForm, Thumb } from "./Deal.js";
import { ContactForm, ContactRow } from "./Contacts.js";

/** All companies, with a create form. */
export function Companies({
  companies,
  openCompany
}: {
  companies: readonly Company[];
  openCompany: (id: Company["id"]) => void;
}) {
  const [filter, setFilter] = useState("");
  const [adding, setAdding] = useState(false);
  const shown = companies.filter((company) =>
    company.name.toLowerCase().includes(filter.trim().toLowerCase())
  );
  return (
    <div>
      <div class="toolbar">
        <h2>Companies</h2>
        <input
          type="search"
          placeholder="Filter…"
          value={filter}
          onInput={(event) => setFilter(event.currentTarget.value)}
        />
        <button type="button" class="primary" onClick={() => setAdding(!adding)}>
          {adding ? "Cancel" : "New company"}
        </button>
      </div>
      {adding && (
        <CompanyForm
          done={(id) => {
            setAdding(false);
            if (id) openCompany(id);
          }}
        />
      )}
      <table class="grid">
        <thead>
          <tr>
            <th>Name</th>
            <th>Website</th>
            <th>Owner</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((company) => (
            <CompanyRow key={company.id} company={company} open={() => openCompany(company.id)} />
          ))}
        </tbody>
      </table>
      {shown.length === 0 && <p class="muted">No companies yet.</p>}
    </div>
  );
}

function CompanyRow({ company, open }: { company: Company; open: () => void }) {
  const owner = useOwnerName(company.ownerId);
  return (
    <tr>
      <td>
        <button type="button" class="link" onClick={open}>
          {company.name}
        </button>
      </td>
      <td class="muted">{company.website ?? ""}</td>
      <td>{owner}</td>
    </tr>
  );
}

function CompanyForm({ company, done }: { company?: Company; done: (id?: Company["id"]) => void }) {
  const [name, setName] = useState(company?.name ?? "");
  const [website, setWebsite] = useState(company?.website ?? "");
  const { busy, error, run } = useRunner();
  const save = async () => {
    const saved = await run(() =>
      company
        ? patchy.server.companies.update({ id: company.id, name, website })
        : patchy.server.companies.create({ name, website })
    );
    if (saved) done(saved.id);
  };
  return (
    <div class="form" onKeyDown={onEnter(() => void save())}>
      <label>
        Name
        <input name="name" value={name} onInput={(event) => setName(event.currentTarget.value)} />
      </label>
      <label>
        Website
        <input
          name="website"
          value={website}
          onInput={(event) => setWebsite(event.currentTarget.value)}
        />
      </label>
      <div class="row">
        <button type="button" class="primary" disabled={busy} onClick={() => void save()}>
          {company ? "Save" : "Create company"}
        </button>
        <button type="button" onClick={() => done()}>
          Cancel
        </button>
      </div>
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** One company's page: details, contract, contacts and the deals the viewer can see. */
export function CompanyPage({
  id,
  companies,
  back,
  openDeal
}: {
  id: Company["id"];
  companies: readonly Company[];
  back: () => void;
  openDeal: (id: Deal["id"]) => void;
}) {
  const { data, error } = useQuery(patchy.server.companies.get, { id });
  const { me } = useTeam();
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState<"" | "deal" | "contact">("");
  const remover = useRunner();
  if (error)
    return (
      <p class="error" role="alert">
        {describe(error)}
      </p>
    );
  if (data === undefined) return <p class="muted">Loading…</p>;
  if (data === null)
    return (
      <div>
        <button type="button" class="link" onClick={back}>
          ← Companies
        </button>
        <p>This company no longer exists.</p>
      </div>
    );
  const { company, contacts, deals } = data;
  const mine = company.ownerId === me;
  return (
    <div class="company">
      <button type="button" class="link" onClick={back}>
        ← Companies
      </button>
      <div class="toolbar">
        <h2>{company.name}</h2>
        {company.website && <span class="muted">{company.website}</span>}
      </div>
      <Ownership
        ownerId={company.ownerId}
        transfer={(toUserId) => patchy.server.companies.transfer({ id: company.id, toUserId })}
      />
      {mine && !editing && (
        <div class="row">
          <button type="button" onClick={() => setEditing(true)}>
            Edit
          </button>
          <button
            type="button"
            class="danger"
            disabled={remover.busy}
            onClick={() =>
              void remover
                .run(() => patchy.server.companies.remove({ id: company.id }))
                .then((done) => done === null && back())
            }
          >
            Delete
          </button>
        </div>
      )}
      {editing && <CompanyForm company={company} done={() => setEditing(false)} />}
      {remover.error && (
        <p class="error" role="alert">
          {remover.error}
        </p>
      )}

      <div class="split">
        <section>
          <div class="toolbar">
            <h3>Deals</h3>
            <button type="button" onClick={() => setAdding(adding === "deal" ? "" : "deal")}>
              {adding === "deal" ? "Cancel" : "New deal"}
            </button>
          </div>
          {adding === "deal" && (
            <DealForm companies={companies} companyId={company.id} done={() => setAdding("")} />
          )}
          {deals.length === 0 ? (
            <p class="muted">No deals.</p>
          ) : (
            <table class="grid">
              <thead>
                <tr>
                  <th>Deal</th>
                  <th>Stage</th>
                  <th>Value</th>
                </tr>
              </thead>
              <tbody>
                {deals.map((deal) => (
                  <tr key={deal.id}>
                    <td>
                      <button type="button" class="link" onClick={() => openDeal(deal.id)}>
                        {deal.title}
                      </button>
                      {deal.private && <span class="badge">Private</span>}
                    </td>
                    <td>{deal.stage}</td>
                    <td>{money(deal.valueCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div class="toolbar">
            <h3>Contacts</h3>
            <button type="button" onClick={() => setAdding(adding === "contact" ? "" : "contact")}>
              {adding === "contact" ? "Cancel" : "New contact"}
            </button>
          </div>
          {adding === "contact" && (
            <ContactForm companies={companies} companyId={company.id} done={() => setAdding("")} />
          )}
          {contacts.length === 0 ? (
            <p class="muted">No contacts.</p>
          ) : (
            <table class="grid">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Title</th>
                  <th>Owner</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {contacts.map((contact) => (
                  <ContactRow
                    key={contact.id}
                    contact={contact}
                    companies={companies}
                    hideCompany
                  />
                ))}
              </tbody>
            </table>
          )}
        </section>
        <Contract name={company.name} />
      </div>
    </div>
  );
}

/** The company's contract from the contracts tool's shared store; live while the page is open. */
function Contract({ name }: { name: string }) {
  const { data, error } = useQuery(patchy.server.contracts.forCompany, { name });
  const download = useRunner();
  return (
    <section class="contract" id="contract">
      <h3>Contract</h3>
      {error ? (
        <p class="error" role="alert">
          Contracts are unavailable: {describe(error)}
        </p>
      ) : data === undefined ? (
        <p class="muted">Loading…</p>
      ) : !data.pdf && !data.thumbnail ? (
        <p class="muted">No contract on file.</p>
      ) : (
        <div>
          {data.thumbnail ? (
            <Thumb handle={data.thumbnail.handle} alt={`${name} contract, first page`} />
          ) : (
            <p class="muted small">No thumbnail.</p>
          )}
          {data.pdf && (
            <div>
              <button
                type="button"
                disabled={download.busy}
                onClick={() =>
                  void download.run(() => patchy.files.download(data.pdf!.handle, data.pdf!.name))
                }
              >
                Download PDF
              </button>
              <div class="muted small">
                {data.pdf.name} · updated {new Date(data.pdf.updatedAt).toLocaleDateString()}
              </div>
            </div>
          )}
          {download.error && (
            <p class="error" role="alert">
              {download.error}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
