import { useState } from "patchy/preact";
import { useFileUrl, useQuery } from "patchy/preact";
import { patchy } from "../patchy/_generated/client.js";
import { formatDollars } from "../shared/rules.js";
import { ContactForm } from "./Contacts.js";
import { DealForm } from "./Deals.js";
import {
  Alert,
  DeleteButton,
  Form,
  Modal,
  Owner,
  describe,
  useApp,
  useTask,
  type CompanyId
} from "./ui.js";

export function Companies() {
  const { me, go } = useApp();
  const { data, error } = useQuery(patchy.server.companies.list, {});
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState("");
  const shown = data?.filter((c) => c.nameKey.includes(filter.trim().toLowerCase()));
  return (
    <section>
      <div class="toolbar">
        <h1>Companies</h1>
        <input
          type="search"
          placeholder="Filter by name"
          aria-label="Filter companies"
          value={filter}
          onInput={(e) => setFilter(e.currentTarget.value)}
        />
        <button type="button" class="primary" onClick={() => setCreating(true)}>
          New company
        </button>
      </div>
      {error && <Alert>{describe(error)}</Alert>}
      <table class="grid">
        <thead>
          <tr>
            <th>Name</th>
            <th>Owner</th>
            <th>Added</th>
          </tr>
        </thead>
        <tbody>
          {shown?.map((c) => (
            <tr key={c.id}>
              <td>
                <button
                  type="button"
                  class="link"
                  onClick={() => go({ name: "company", id: c.id })}
                >
                  {c.name}
                </button>
              </td>
              <td>{c.ownerId === me.user.id ? "You" : c.ownerName}</td>
              <td class="muted">{c.createdAt.slice(0, 10)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {data?.length === 0 && <p class="muted">No companies yet. Create one or import contacts.</p>}
      {creating && <CompanyForm onClose={() => setCreating(false)} />}
    </section>
  );
}

function CompanyForm({
  company,
  onClose
}: {
  company?: { id: CompanyId; name: string };
  onClose: () => void;
}) {
  const { go } = useApp();
  const [name, setName] = useState(company?.name ?? "");
  const task = useTask();
  const save = () =>
    void task.run(async () => {
      if (company) await patchy.server.companies.rename({ id: company.id, name });
      else go({ name: "company", id: (await patchy.server.companies.create({ name })).id });
      onClose();
    });
  return (
    <Modal title={company ? "Rename company" : "New company"} onClose={onClose}>
      <Form onSubmit={save}>
        <label>
          Name
          <input
            name="name"
            required
            value={name}
            onInput={(e) => setName(e.currentTarget.value)}
          />
        </label>
        <Alert>{task.error}</Alert>
        <div class="actions">
          <button type="button" class="primary" disabled={task.busy} onClick={save}>
            Save
          </button>
        </div>
      </Form>
    </Modal>
  );
}

export function CompanyPage({ id }: { id: CompanyId }) {
  const { me, go } = useApp();
  const { data, error } = useQuery(patchy.server.companies.get, { id });
  const [dialog, setDialog] = useState<"rename" | "contact" | "deal" | null>(null);
  const task = useTask();
  if (error) return <Alert>{describe(error)}</Alert>;
  if (data === undefined) return <p class="muted">Loading…</p>;
  const { company, contacts, deals } = data;
  const mine = company.ownerId === me.user.id;
  return (
    <section>
      <div class="toolbar">
        <h1>{company.name}</h1>
        {mine && (
          <button type="button" onClick={() => setDialog("rename")}>
            Rename
          </button>
        )}
        {mine && (
          <DeleteButton
            busy={task.busy}
            onConfirm={() =>
              void task.run(async () => {
                await patchy.server.companies.remove({ id });
                go({ name: "companies" });
              })
            }
          />
        )}
      </div>
      <Owner
        ownerId={company.ownerId}
        ownerName={company.ownerName}
        onHandoff={(userId) => patchy.server.companies.handoff({ id, userId })}
      />
      <Alert>{task.error}</Alert>
      <div class="split">
        <div>
          <div class="toolbar">
            <h2>Deals</h2>
            <button type="button" onClick={() => setDialog("deal")}>
              New deal
            </button>
          </div>
          {deals.length === 0 ? (
            <p class="muted">No deals you can see.</p>
          ) : (
            <table class="grid">
              <thead>
                <tr>
                  <th>Deal</th>
                  <th>Stage</th>
                  <th class="num">Value</th>
                  <th>Owner</th>
                </tr>
              </thead>
              <tbody>
                {deals.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <button
                        type="button"
                        class="link"
                        onClick={() => go({ name: "deal", id: d.id })}
                      >
                        {d.private && <span class="badge">Private</span>} {d.title}
                      </button>
                    </td>
                    <td>{d.stage}</td>
                    <td class="num">{formatDollars(d.valueCents)}</td>
                    <td>{d.ownerId === me.user.id ? "You" : d.ownerName}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div class="toolbar">
            <h2>Contacts</h2>
            <button type="button" onClick={() => setDialog("contact")}>
              New contact
            </button>
          </div>
          {contacts.length === 0 ? (
            <p class="muted">No contacts.</p>
          ) : (
            <table class="grid">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Title</th>
                  <th>Email</th>
                  <th>Owner</th>
                </tr>
              </thead>
              <tbody>
                {contacts.map((c) => (
                  <tr key={c.id}>
                    <td>
                      {c.firstName} {c.lastName}
                    </td>
                    <td>{c.title}</td>
                    <td>{c.email}</td>
                    <td>{c.ownerId === me.user.id ? "You" : c.ownerName}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <Contract companyId={id} />
      </div>
      {dialog === "rename" && <CompanyForm company={company} onClose={() => setDialog(null)} />}
      {dialog === "deal" && <DealForm companyId={id} onClose={() => setDialog(null)} />}
      {dialog === "contact" && <ContactForm companyId={id} onClose={() => setDialog(null)} />}
    </section>
  );
}

/** The company's signed contract from the contracts tool, live: a thumbnail when there is one and the PDF. */
function Contract({ companyId }: { companyId: CompanyId }) {
  const { data, error } = useQuery(patchy.server.contracts.forCompany, { companyId });
  const task = useTask();
  return (
    <aside class="contract">
      <h2>Contract</h2>
      {error ? (
        <Alert>Contracts are unavailable: {describe(error)}</Alert>
      ) : data === undefined ? (
        <p class="muted">Loading…</p>
      ) : data.pdf === null ? (
        <p class="muted">No contract on file (looked for {data.slug}.pdf).</p>
      ) : (
        <>
          {data.thumbnail ? (
            <Thumbnail handle={data.thumbnail.handle} />
          ) : (
            <p class="muted">No thumbnail.</p>
          )}
          <button
            type="button"
            onClick={() =>
              void task.run(() => patchy.files.download(data.pdf!.handle, data.pdf!.name))
            }
          >
            Download {data.pdf.name}
          </button>
          <Alert>{task.error}</Alert>
        </>
      )}
    </aside>
  );
}

function Thumbnail({ handle }: { handle: Parameters<typeof useFileUrl>[0] }) {
  const { url, error } = useFileUrl(handle);
  if (error)
    return (
      <p class="muted">
        {error.code === "not_found" ? "Thumbnail replaced; refreshing…" : "Thumbnail unavailable."}
      </p>
    );
  return url ? (
    <img class="contract-thumb" src={url} alt="First page of the contract" />
  ) : (
    <div class="contract-thumb" />
  );
}
