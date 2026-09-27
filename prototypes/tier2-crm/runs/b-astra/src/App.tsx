import { useEffect, useState, useRef, useQuery } from "patchy/preact";
import type { ComponentChildren } from "preact";
import type { Row } from "patchy/config";
import type config from "../patchy.config.js";
import { patchy } from "../patchy/_generated/client.js";
import { Attachments } from "./Attachments.js";
import { ImportContacts } from "./ImportContacts.js";
import { CompanyContracts, FinanceReport } from "./Integrations.js";
import {
  CompanyPicker,
  ErrorNotice,
  Modal,
  Pager,
  dollars,
  stageNames,
  useOperation
} from "./ui.js";
import type { Stage } from "./ui.js";
import type { PipelineColumnData } from "../server/deals.js";
import "./styles.css";

type Company = Row<typeof config, "companies">;
type Contact = Row<typeof config, "contacts">;
type Deal = Row<typeof config, "deals">;
type Tab = "Pipeline" | "Contacts" | "Companies" | "Finance" | "Import";
type Editor =
  | { kind: "company"; row?: Company }
  | { kind: "contact"; row?: Contact; companyId?: Company["id"]; companyName?: string }
  | { kind: "deal"; row?: Deal; companyId?: Company["id"]; companyName?: string };
const tabs: Tab[] = ["Pipeline", "Contacts", "Companies", "Finance", "Import"];
const tabIcons = ["▥", "◎", "▦", "↗", "↓"];

function Form({
  children,
  save,
  busy,
  error,
  label = "Save changes"
}: {
  children: ComponentChildren;
  save: () => void;
  busy: boolean;
  error: unknown;
  label?: string;
}) {
  const ref = useRef<HTMLFormElement>(null);
  const submit = () => {
    if (ref.current?.reportValidity()) save();
  };
  return (
    <form
      ref={ref}
      className="record-form"
      onSubmit={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (e.key === "Enter" && e.target instanceof HTMLInputElement) {
          e.preventDefault();
          submit();
        }
      }}
    >
      <fieldset disabled={busy}>{children}</fieldset>
      <ErrorNotice error={error} />
      <footer className="form-footer">
        <button type="button" disabled={busy} onClick={submit}>
          {busy ? "Saving…" : label}
        </button>
        <small className="muted">Changes are shared with your team.</small>
      </footer>
    </form>
  );
}
function CompanyForm({ row, close }: { row?: Company; close: () => void }) {
  const [name, setName] = useState(row?.name ?? "");
  const [website, setWebsite] = useState(row?.website ?? "");
  const [notes, setNotes] = useState(row?.notes ?? "");
  const op = useOperation();
  const save = () =>
    void op.run(
      () =>
        row
          ? patchy.server.records.updateCompany({ id: row.id, name, website, notes })
          : patchy.server.records.createCompany({ name, website, notes }),
      close
    );
  return (
    <Form
      save={save}
      busy={op.busy}
      error={op.error}
      label={row ? "Save company" : "Create company"}
    >
      <label>
        Company name
        <input
          name="name"
          required
          maxLength={500}
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          autoFocus
        />
      </label>
      <label>
        Website
        <input
          name="website"
          placeholder="example.com"
          value={website}
          onChange={(e) => setWebsite(e.currentTarget.value)}
        />
      </label>
      <label>
        Notes
        <textarea value={notes} onChange={(e) => setNotes(e.currentTarget.value)} rows={4} />
      </label>
      <p className="muted">Companies are visible to everyone. Only their owner can edit them.</p>
    </Form>
  );
}
function ContactForm({
  editor,
  close
}: {
  editor: Extract<Editor, { kind: "contact" }>;
  close: () => void;
}) {
  const row = editor.row;
  const [firstName, setFirst] = useState(row?.firstName ?? "");
  const [lastName, setLast] = useState(row?.lastName ?? "");
  const [email, setEmail] = useState(row?.email ?? "");
  const [title, setTitle] = useState(row?.title ?? "");
  const [phone, setPhone] = useState(row?.phone ?? "");
  const [companyId, setCompany] = useState<Company["id"] | "">(
    row?.companyId ?? editor.companyId ?? ""
  );
  const op = useOperation();
  const save = () =>
    void op.run(() => {
      if (!companyId) throw new Error("Select a company.");
      const args = { firstName, lastName, email, title, phone, companyId };
      return row
        ? patchy.server.records.updateContact({ id: row.id, ...args })
        : patchy.server.records.createContact(args);
    }, close);
  return (
    <Form
      save={save}
      busy={op.busy}
      error={op.error}
      label={row ? "Save contact" : "Create contact"}
    >
      <div className="form-grid">
        <label>
          First name
          <input value={firstName} onChange={(e) => setFirst(e.currentTarget.value)} autoFocus />
        </label>
        <label>
          Last name
          <input value={lastName} onChange={(e) => setLast(e.currentTarget.value)} />
        </label>
      </div>
      <label>
        Email
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.currentTarget.value)}
        />
      </label>
      <CompanyPicker value={companyId} initialName={editor.companyName} onChange={setCompany} />
      <div className="form-grid">
        <label>
          Job title
          <input value={title} onChange={(e) => setTitle(e.currentTarget.value)} />
        </label>
        <label>
          Phone
          <input type="tel" value={phone} onChange={(e) => setPhone(e.currentTarget.value)} />
        </label>
      </div>
    </Form>
  );
}
function DealForm({
  editor,
  close
}: {
  editor: Extract<Editor, { kind: "deal" }>;
  close: () => void;
}) {
  const row = editor.row;
  const [title, setTitle] = useState(row?.title ?? "");
  const [companyId, setCompany] = useState<Company["id"] | "">(
    row?.companyId ?? editor.companyId ?? ""
  );
  const [value, setValue] = useState(String((row?.valueCents ?? 0) / 100));
  const [stage, setStage] = useState(row?.stage ?? "Lead");
  const [privateDeal, setPrivate] = useState(row?.private ?? false);
  const [notes, setNotes] = useState(row?.notes ?? "");
  const op = useOperation();
  const save = () =>
    void op.run(() => {
      if (!companyId) throw new Error("Select a company.");
      const args = {
        title,
        companyId,
        valueCents: Math.round(Number(value) * 100),
        stage: stage as Stage,
        private: privateDeal,
        notes
      };
      return row
        ? patchy.server.deals.update({ id: row.id, ...args })
        : patchy.server.deals.create(args);
    }, close);
  return (
    <Form save={save} busy={op.busy} error={op.error} label={row ? "Save deal" : "Create deal"}>
      <label>
        Deal title
        <input
          required
          maxLength={500}
          value={title}
          onChange={(e) => setTitle(e.currentTarget.value)}
          autoFocus
        />
      </label>
      <CompanyPicker value={companyId} initialName={editor.companyName} onChange={setCompany} />
      <div className="form-grid">
        <label>
          Value in USD
          <input
            type="number"
            min="0"
            step="0.01"
            required
            value={value}
            onChange={(e) => setValue(e.currentTarget.value)}
          />
        </label>
        <label>
          Stage
          <select value={stage} onChange={(e) => setStage(e.currentTarget.value)}>
            {stageNames.map((name) => (
              <option key={name}>{name}</option>
            ))}
          </select>
        </label>
      </div>
      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={privateDeal}
          onChange={(e) => setPrivate(e.currentTarget.checked)}
        />
        Private deal, visible only to its owner
      </label>
      {row && privateDeal && !row.private && (
        <p className="notice">
          Remove existing attachments before making this deal private, then reattach them afterward.
          Patchy does not revoke previously issued download handles when a record's access changes.
          Downloaded copies cannot be recalled.
        </p>
      )}
      <label>
        Notes
        <textarea rows={3} value={notes} onChange={(e) => setNotes(e.currentTarget.value)} />
      </label>
    </Form>
  );
}
function OwnerName({ id }: { id: string }) {
  const { data } = useQuery(patchy.server.records.team, {});
  return (
    <span>
      {data?.members.find((member) => member.userId === id)?.name ?? "Team member"}
      {data?.viewerId === id ? " (you)" : ""}
    </span>
  );
}
function Handoff({
  kind,
  id,
  ownerId,
  onDone
}: (
  | { kind: "company"; id: Company["id"] }
  | { kind: "contact"; id: Contact["id"] }
  | { kind: "deal"; id: Deal["id"] }
) & { ownerId: string; onDone?: () => void }) {
  const { data, error } = useQuery(patchy.server.records.team, {});
  const [target, setTarget] = useState("");
  const op = useOperation();
  if (data?.viewerId !== ownerId)
    return (
      <p className="muted">
        Owned by <OwnerName id={ownerId} />. Only the owner can edit, transfer or delete this
        record.
      </p>
    );
  const people = data.members.filter((person) => person.userId !== ownerId);
  const transfer = () =>
    void op.run(
      () =>
        kind === "company"
          ? patchy.server.records.reassignCompany({ id, ownerId: target })
          : kind === "contact"
            ? patchy.server.records.reassignContact({ id, ownerId: target })
            : patchy.server.deals.reassign({ id, ownerId: target }),
      onDone
    );
  return (
    <section className="handoff">
      <h3>Ownership</h3>
      <p className="muted">
        Owned by you. A transfer gives the teammate edit and delete access
        {kind === "deal" ? ", including any private deal and its files" : ""}.
      </p>
      {kind === "deal" && (
        <p className="notice">
          To revoke the previous owner's attachment download handles, remove the files before
          transferring this deal. The new owner can reattach them. Changing ownership alone does not
          revoke handles or downloaded copies.
        </p>
      )}
      {people.length ? (
        <div className="toolbar">
          <select
            aria-label="New owner"
            value={target}
            onChange={(e) => setTarget(e.currentTarget.value)}
          >
            <option value="">Choose a teammate</option>
            {people.map((person) => (
              <option key={person.userId} value={person.userId}>
                {person.name} · {person.email}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="secondary"
            disabled={!target || op.busy}
            onClick={transfer}
          >
            Transfer ownership
          </button>
        </div>
      ) : (
        <p className="muted">Ask your teammate to open the CRM once to appear here.</p>
      )}
      <ErrorNotice error={op.error ?? error} />
    </section>
  );
}
function DeleteButton({ remove, label }: { remove: () => Promise<unknown>; label: string }) {
  const [confirm, setConfirm] = useState(false);
  const op = useOperation();
  return (
    <div className="delete-control">
      <ErrorNotice error={op.error} />
      {confirm ? (
        <>
          <span>Delete {label}? This cannot be undone.</span>
          <button
            type="button"
            className="danger"
            disabled={op.busy}
            onClick={() => void op.run(remove)}
          >
            Confirm delete
          </button>
          <button type="button" className="secondary" onClick={() => setConfirm(false)}>
            Cancel
          </button>
        </>
      ) : (
        <button type="button" className="danger-text" onClick={() => setConfirm(true)}>
          Delete {label}
        </button>
      )}
    </div>
  );
}

type PipelinePage = { publicCursor?: string | null; privateCursor?: string | null };

function PipelineColumn({
  stage,
  data,
  viewerId,
  openDeal,
  page,
  next,
  previous
}: {
  stage: Stage;
  data: PipelineColumnData | undefined;
  viewerId: string;
  openDeal: (id: Deal["id"]) => void;
  page: number;
  next?: () => void;
  previous?: () => void;
}) {
  const op = useOperation();
  return (
    <section className={`pipeline-column stage-${stage.toLowerCase()}`}>
      <header className="column-heading">
        <div>
          <span className="stage-dot" />
          <h2>{stage}</h2>
          <span className="count">{data?.rows.length ?? "·"}</span>
        </div>
        <strong>
          {data ? dollars(data.rows.reduce((sum, { deal }) => sum + deal.valueCents, 0)) : ""}
        </strong>
      </header>
      <ErrorNotice error={op.error} />
      {data?.rows.map(({ deal, companyName }) => (
        <article key={deal.id} className="deal-card">
          <button type="button" className="card-link" onClick={() => openDeal(deal.id)}>
            {deal.title}
          </button>
          <p>{companyName}</p>
          <strong className="deal-value">{dollars(deal.valueCents)}</strong>
          <div className="deal-meta">
            <span className="avatar">{deal.ownerId === viewerId ? "Y" : "T"}</span>
            <small>
              <OwnerName id={deal.ownerId} />
            </small>
            {deal.private && <span className="badge private">Private</span>}
          </div>
          {deal.ownerId === viewerId && (
            <label className="stage-control">
              Move to
              <select
                aria-label={`Stage for ${deal.title}`}
                value={deal.stage}
                disabled={op.busy}
                onChange={(e) => {
                  const stage = e.currentTarget.value as Stage;
                  void op.run(() => patchy.server.deals.move({ id: deal.id, stage }));
                }}
              >
                {stageNames.map((name) => (
                  <option key={name}>{name}</option>
                ))}
              </select>
            </label>
          )}
        </article>
      ))}
      {data?.rows.length === 0 && (
        <div className="column-empty">No {stage.toLowerCase()} deals</div>
      )}
      {!data && <p className="muted">Loading deals…</p>}
      {(previous || next) && <Pager page={page} previous={previous} next={next} />}
    </section>
  );
}

function Pipeline({
  viewerId,
  newDeal,
  openDeal
}: {
  viewerId: string;
  newDeal: () => void;
  openDeal: (id: Deal["id"]) => void;
}) {
  const [closed, setClosed] = useState(false);
  const [history, setHistory] = useState<Record<Stage, PipelinePage[]>>({
    Lead: [{}],
    Qualified: [{}],
    Proposal: [{}],
    Won: [{}],
    Lost: [{}]
  });
  const displayed = closed
    ? (["Won", "Lost"] as const)
    : (["Lead", "Qualified", "Proposal"] as const);
  const { data, error, status } = useQuery(patchy.server.deals.pipeline, {
    pages: displayed.map((stage) => ({ stage, ...history[stage].at(-1) }))
  });
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">SALES WORKSPACE</p>
          <h1>Deal pipeline</h1>
          <p className="muted">Keep the next conversation moving.</p>
        </div>
        <button type="button" onClick={newDeal}>
          + New deal
        </button>
      </div>
      <div className="board-toolbar">
        <div className="segmented">
          <button
            type="button"
            className={!closed ? "selected" : ""}
            onClick={() => setClosed(false)}
          >
            Open pipeline
          </button>
          <button
            type="button"
            className={closed ? "selected" : ""}
            onClick={() => setClosed(true)}
          >
            Won & lost
          </button>
        </div>
        <span className="live-label">
          <span />
          {status === "resyncing"
            ? "Reconnecting…"
            : status === "up-to-date"
              ? "Live updates · USD"
              : "Connecting…"}
        </span>
      </div>
      <ErrorNotice error={error} />
      {!error && (
        <div className={`pipeline ${closed ? "closed-pipeline" : ""}`}>
          {displayed.map((stage) => {
            const column = data?.find((column) => column.stage === stage);
            const pages = history[stage];
            return (
              <PipelineColumn
                key={stage}
                stage={stage}
                data={column}
                viewerId={viewerId}
                openDeal={openDeal}
                page={pages.length}
                previous={
                  pages.length > 1
                    ? () => setHistory({ ...history, [stage]: pages.slice(0, -1) })
                    : undefined
                }
                next={
                  column && (column.publicCursor || column.privateCursor)
                    ? () =>
                        setHistory({
                          ...history,
                          [stage]: [
                            ...pages,
                            {
                              publicCursor: column.publicCursor,
                              privateCursor: column.privateCursor
                            }
                          ]
                        })
                    : undefined
                }
              />
            );
          })}
        </div>
      )}
      <p className="footnote">
        Private deals appear only for their owner. Column totals cover the displayed page.
      </p>
    </>
  );
}
function Companies({
  select,
  create
}: {
  select: (id: Company["id"]) => void;
  create: () => void;
}) {
  const [search, setSearch] = useState("");
  const [history, setHistory] = useState<(string | undefined)[]>([undefined]);
  const { data, error } = useQuery(patchy.server.records.companies, {
    search,
    ...(history.at(-1) ? { cursor: history.at(-1) } : {})
  });
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">CUSTOMER DIRECTORY</p>
          <h1>Companies</h1>
          <p className="muted">Relationships, contracts and the people behind them.</p>
        </div>
        <button type="button" onClick={create}>
          + New company
        </button>
      </div>
      <div className="toolbar search-toolbar">
        <input
          aria-label="Search companies"
          placeholder="Search company name…"
          value={search}
          onChange={(e) => {
            setSearch(e.currentTarget.value);
            setHistory([undefined]);
          }}
        />
        <span className="muted">Visible to everyone on the team</span>
      </div>
      <ErrorNotice error={error} />
      {!error && data && (
        <div className="company-grid">
          {data.rows.map((company) => (
            <button
              type="button"
              key={company.id}
              className="company-card"
              onClick={() => select(company.id)}
            >
              <span className="company-monogram">{company.name.slice(0, 2).toUpperCase()}</span>
              <h2>{company.name}</h2>
              <p>{company.website || "Customer company"}</p>
              <small>
                Owner · <OwnerName id={company.ownerId} />
              </small>
              <span className="company-arrow">↗</span>
            </button>
          ))}
        </div>
      )}
      {data?.rows.length === 0 && (
        <div className="empty-state">
          <h2>No companies yet</h2>
          <p>Add your first company, or import contacts to create their companies.</p>
        </div>
      )}
      {!data && !error && <p>Loading companies…</p>}
      {data && (
        <Pager
          page={history.length}
          previous={history.length > 1 ? () => setHistory(history.slice(0, -1)) : undefined}
          next={data.cursor ? () => setHistory([...history, data.cursor!]) : undefined}
        />
      )}
    </>
  );
}
function Contacts({
  viewerId,
  edit,
  companyId,
  companyName,
  openContact
}: {
  viewerId: string;
  edit: (editor: Editor) => void;
  companyId?: Company["id"];
  companyName?: string;
  openContact: (row: Contact) => void;
}) {
  const [search, setSearch] = useState("");
  const [history, setHistory] = useState<(string | undefined)[]>([undefined]);
  const { data, error } = useQuery(patchy.server.records.contacts, {
    search,
    ...(companyId ? { companyId } : {}),
    ...(history.at(-1) ? { cursor: history.at(-1) } : {})
  });
  return (
    <section className={companyId ? "panel" : ""}>
      <div className={companyId ? "section-heading" : "page-heading"}>
        <div>
          {!companyId && <p className="eyebrow">PEOPLE & RELATIONSHIPS</p>}
          {companyId ? (
            <h2>Contacts</h2>
          ) : (
            <>
              <h1>Contacts</h1>
              <p className="muted">Everyone you need to keep in touch with.</p>
            </>
          )}
        </div>
        <button
          type="button"
          className={companyId ? "secondary" : ""}
          onClick={() => edit({ kind: "contact", companyId, companyName })}
        >
          + New contact
        </button>
      </div>
      {!companyId && (
        <div className="toolbar search-toolbar">
          <input
            aria-label="Search contacts by email"
            placeholder="Search by email prefix…"
            value={search}
            onChange={(e) => {
              setSearch(e.currentTarget.value);
              setHistory([undefined]);
            }}
          />
          <span className="muted">50 contacts per page</span>
        </div>
      )}
      <ErrorNotice error={error} />
      {!error && data && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Email / phone</th>
                {!companyId && <th>Company</th>}
                <th>Owner</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.rows.map(({ contact, companyName: name }) => (
                <tr key={contact.id}>
                  <td>
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => openContact(contact)}
                    >
                      {`${contact.firstName} ${contact.lastName}`.trim() || contact.email}
                    </button>
                    <small className="cell-secondary">{contact.title}</small>
                  </td>
                  <td>
                    {contact.email}
                    <small className="cell-secondary">{contact.phone}</small>
                  </td>
                  {!companyId && <td>{name}</td>}
                  <td>
                    <OwnerName id={contact.ownerId} />
                  </td>
                  <td>
                    {contact.ownerId === viewerId && (
                      <button
                        type="button"
                        className="secondary small"
                        onClick={() => edit({ kind: "contact", row: contact, companyName: name })}
                      >
                        Edit
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.rows.length === 0 && (
            <div className="empty-state">
              <h3>No contacts found</h3>
              <p>Create a contact or import a CSV.</p>
            </div>
          )}
        </div>
      )}
      {!data && !error && <p>Loading contacts…</p>}
      {data && (
        <Pager
          page={history.length}
          previous={history.length > 1 ? () => setHistory(history.slice(0, -1)) : undefined}
          next={data.cursor ? () => setHistory([...history, data.cursor!]) : undefined}
        />
      )}
    </section>
  );
}
function CompanyDeals({
  companyId,
  openDeal
}: {
  companyId: Company["id"];
  openDeal: (id: Deal["id"]) => void;
}) {
  const [history, setHistory] = useState<(string | undefined)[]>([undefined]);
  const { data, error } = useQuery(patchy.server.deals.forCompany, {
    companyId,
    ...(history.at(-1) ? { cursor: history.at(-1) } : {})
  });
  return (
    <section className="panel">
      <h2>Deals</h2>
      <ErrorNotice error={error} />
      {!error &&
        data?.rows.map((deal) => (
          <button
            type="button"
            className="deal-row"
            key={deal.id}
            onClick={() => openDeal(deal.id)}
          >
            <span>
              {deal.title}
              {deal.private && <span className="badge private">Private</span>}
            </span>
            <span className="badge">{deal.stage}</span>
            <strong>{dollars(deal.valueCents)}</strong>
          </button>
        ))}
      {!error && data?.rows.length === 0 && <p className="muted">No visible deals on this page.</p>}
      {data && (history.length > 1 || data.cursor) && (
        <Pager
          page={history.length}
          previous={history.length > 1 ? () => setHistory(history.slice(0, -1)) : undefined}
          next={data.cursor ? () => setHistory([...history, data.cursor!]) : undefined}
        />
      )}
    </section>
  );
}
function CompanyDetail({
  id,
  viewerId,
  back,
  edit,
  openDeal,
  openContact
}: {
  id: Company["id"];
  viewerId: string;
  back: () => void;
  edit: (editor: Editor) => void;
  openDeal: (id: Deal["id"]) => void;
  openContact: (row: Contact) => void;
}) {
  const { data: company, error } = useQuery(patchy.server.records.company, { id });
  if (error) return <ErrorNotice error={error} />;
  if (company === undefined) return <p>Loading company…</p>;
  if (!company)
    return (
      <div className="empty-state">
        <h2>Company unavailable</h2>
        <button type="button" onClick={back}>
          Back to companies
        </button>
      </div>
    );
  const owned = company.ownerId === viewerId;
  return (
    <>
      <button type="button" className="back-button" onClick={back}>
        ← All companies
      </button>
      <div className="page-heading">
        <div>
          <p className="eyebrow">COMPANY PROFILE</p>
          <h1>{company.name}</h1>
          <p className="muted">
            {company.website || "Customer company"} · Owner: <OwnerName id={company.ownerId} />
          </p>
        </div>
        <div className="toolbar">
          {owned && (
            <button
              type="button"
              className="secondary"
              onClick={() => edit({ kind: "company", row: company })}
            >
              Edit company
            </button>
          )}
          <button
            type="button"
            onClick={() => edit({ kind: "deal", companyId: id, companyName: company.name })}
          >
            + New deal
          </button>
        </div>
      </div>
      {company.notes && (
        <section className="panel">
          <h2>Notes</h2>
          <p className="preserve-lines">{company.notes}</p>
        </section>
      )}
      <div className="detail-grid">
        <CompanyDeals companyId={id} openDeal={openDeal} />
        <section className="panel">
          <CompanyContracts companyId={id} />
        </section>
      </div>
      <Contacts
        viewerId={viewerId}
        edit={edit}
        companyId={id}
        companyName={company.name}
        openContact={openContact}
      />
      <section className="panel">
        <Handoff kind="company" id={id} ownerId={company.ownerId} />
        {owned && (
          <DeleteButton
            label="company"
            remove={async () => {
              await patchy.server.records.deleteCompany({ id });
              back();
            }}
          />
        )}
      </section>
    </>
  );
}
function DealDetail({
  id,
  viewerId,
  close,
  edit
}: {
  id: Deal["id"];
  viewerId: string;
  close: () => void;
  edit: (editor: Editor) => void;
}) {
  const { data, error } = useQuery(patchy.server.deals.detail, { id });
  const files = useQuery(patchy.server.attachments.list, { dealId: id });
  if (error)
    return (
      <Modal title="Deal unavailable" onClose={close}>
        <ErrorNotice error={error} />
      </Modal>
    );
  if (!data)
    return (
      <Modal title="Deal" onClose={close}>
        <p>Loading deal…</p>
      </Modal>
    );
  const { deal, companyName } = data;
  const owned = deal.ownerId === viewerId;
  return (
    <Modal title={deal.title} onClose={close}>
      <div className="deal-detail-heading">
        <span>{companyName}</span>
        <span className="badge">{deal.stage}</span>
        {deal.private && <span className="badge private">Private</span>}
        <strong>{dollars(deal.valueCents)}</strong>
      </div>
      {deal.notes && <p className="preserve-lines">{deal.notes}</p>}
      {owned && (
        <button
          type="button"
          className="secondary"
          onClick={() => {
            close();
            edit({ kind: "deal", row: deal, companyName });
          }}
        >
          Edit deal
        </button>
      )}
      <Attachments dealId={id} canEdit={owned} />
      <Handoff kind="deal" id={id} ownerId={deal.ownerId} onDone={close} />
      {owned &&
        (files.data && !files.error && files.data.files.length === 0 ? (
          <DeleteButton
            label="deal"
            remove={async () => {
              await patchy.server.deals.remove({ id });
              close();
            }}
          />
        ) : (
          <p className="muted">Remove the deal's attachments before deleting it.</p>
        ))}
    </Modal>
  );
}
function ContactDetail({
  row,
  viewerId,
  close,
  edit
}: {
  row: Contact;
  viewerId: string;
  close: () => void;
  edit: (editor: Editor) => void;
}) {
  return (
    <Modal title={`${row.firstName} ${row.lastName}`.trim() || row.email} onClose={close}>
      <dl className="contact-details">
        <dt>Email</dt>
        <dd>{row.email}</dd>
        <dt>Phone</dt>
        <dd>{row.phone || "Not provided"}</dd>
        <dt>Job title</dt>
        <dd>{row.title || "Not provided"}</dd>
      </dl>
      {row.ownerId === viewerId && (
        <button
          type="button"
          className="secondary"
          onClick={() => {
            close();
            edit({ kind: "contact", row });
          }}
        >
          Edit contact
        </button>
      )}
      <Handoff kind="contact" id={row.id} ownerId={row.ownerId} onDone={close} />
      {row.ownerId === viewerId && (
        <DeleteButton
          label="contact"
          remove={async () => {
            await patchy.server.records.deleteContact({ id: row.id });
            close();
          }}
        />
      )}
    </Modal>
  );
}

export function App() {
  const [tab, setTab] = useState<Tab>("Pipeline");
  const [companyId, setCompany] = useState<Company["id"] | null>(null);
  const [dealId, setDeal] = useState<Deal["id"] | null>(null);
  const [contact, setContact] = useState<Contact | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [joinError, setJoinError] = useState<unknown>(null);
  const { data: team, error: teamError } = useQuery(patchy.server.records.team, {});
  useEffect(() => {
    void patchy.server.records.join({}).catch(setJoinError);
  }, []);
  const viewerId = team?.viewerId ?? "";
  const viewer = team?.members.find((person) => person.userId === viewerId);
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">c</span>
          <div>
            Commonroom<small>TEAM CRM</small>
          </div>
        </div>
        <p className="nav-label">WORKSPACE</p>
        <nav aria-label="Main navigation">
          {tabs.map((name, i) => (
            <button
              type="button"
              key={name}
              aria-current={tab === name ? "page" : undefined}
              className={tab === name ? "active" : ""}
              onClick={() => {
                setTab(name);
                setCompany(null);
              }}
            >
              <span aria-hidden="true">{tabIcons[i]}</span>
              {name}
            </button>
          ))}
        </nav>
        <div className="sidebar-note">
          <span className="note-line" />
          <p>
            A shared view of
            <br />
            your next opportunity.
          </p>
        </div>
        <div className="viewer">
          <span className="avatar">{viewer?.name.slice(0, 1) ?? "·"}</span>
          <div>
            <strong>{viewer?.name ?? "Connecting…"}</strong>
            <small>{viewer?.email ?? "Authenticated workspace"}</small>
          </div>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <span>
            Workspace <b>/</b> {tab}
            {companyId ? " / Company" : ""}
          </span>
          <span className="workspace-badge">TEAM ACCESS</span>
        </header>
        <main>
          <ErrorNotice error={joinError ?? teamError} />
          {tab === "Pipeline" && (
            <Pipeline
              viewerId={viewerId}
              newDeal={() => setEditor({ kind: "deal" })}
              openDeal={setDeal}
            />
          )}
          {tab === "Companies" &&
            (companyId ? (
              <CompanyDetail
                id={companyId}
                key={companyId}
                viewerId={viewerId}
                back={() => setCompany(null)}
                edit={setEditor}
                openDeal={setDeal}
                openContact={setContact}
              />
            ) : (
              <Companies select={setCompany} create={() => setEditor({ kind: "company" })} />
            ))}
          {tab === "Contacts" && (
            <Contacts viewerId={viewerId} edit={setEditor} openContact={setContact} />
          )}
          {tab === "Finance" && (
            <>
              <div className="page-heading">
                <div>
                  <p className="eyebrow">CONNECTED FINANCE</p>
                  <h1>Finance report</h1>
                  <p className="muted">Invoices, payments and outstanding balances by company.</p>
                </div>
              </div>
              <FinanceReport />
            </>
          )}
          {tab === "Import" && (
            <>
              <div className="page-heading">
                <div>
                  <p className="eyebrow">BUILD YOUR NETWORK</p>
                  <h1>Import contacts</h1>
                  <p className="muted">Bring your contacts and companies into one place.</p>
                </div>
              </div>
              <ImportContacts />
            </>
          )}
        </main>
        <footer className="app-footer">
          Commonroom <span>Private by choice. Shared by default.</span>
        </footer>
      </div>
      {editor && (
        <Modal
          title={`${editor.row ? "Edit" : "New"} ${editor.kind}`}
          onClose={() => setEditor(null)}
        >
          {editor.kind === "company" ? (
            <CompanyForm row={editor.row} close={() => setEditor(null)} />
          ) : editor.kind === "contact" ? (
            <ContactForm editor={editor} close={() => setEditor(null)} />
          ) : (
            <DealForm editor={editor} close={() => setEditor(null)} />
          )}
        </Modal>
      )}
      {dealId && (
        <DealDetail id={dealId} viewerId={viewerId} close={() => setDeal(null)} edit={setEditor} />
      )}
      {contact && (
        <ContactDetail
          row={contact}
          viewerId={viewerId}
          close={() => setContact(null)}
          edit={setEditor}
        />
      )}
    </div>
  );
}
