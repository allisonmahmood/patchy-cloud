import { useEffect, useState } from "patchy/preact";
import { useQuery } from "patchy/preact";
import { patchy } from "../patchy/_generated/client.js";
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

type Page = Awaited<ReturnType<typeof patchy.server.contacts.list>>;
type Contact = Page["rows"][number]["contact"];

/** Contacts newest first, a page at a time; the first page is live. */
export function Contacts() {
  const { me, go } = useApp();
  const first = useQuery(patchy.server.contacts.list, {});
  const [more, setMore] = useState<Page["rows"]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const [editing, setEditing] = useState<Contact | "new" | null>(null);
  const task = useTask();
  useEffect(() => {
    setMore([]);
    setCursor(first.data?.cursor);
  }, [first.data]);
  const loadMore = () =>
    void task.run(async () => {
      if (!cursor) return;
      const page = await patchy.server.contacts.list({ cursor });
      setMore((rows) => [...rows, ...page.rows]);
      setCursor(page.cursor);
    });
  const rows = [...(first.data?.rows ?? []), ...more];
  return (
    <section>
      <div class="toolbar">
        <h1>Contacts</h1>
        <button type="button" onClick={() => go({ name: "import" })}>
          Import CSV
        </button>
        <button type="button" class="primary" onClick={() => setEditing("new")}>
          New contact
        </button>
      </div>
      {first.error && <Alert>{describe(first.error)}</Alert>}
      <table class="grid">
        <thead>
          <tr>
            <th>Name</th>
            <th>Company</th>
            <th>Title</th>
            <th>Email</th>
            <th>Phone</th>
            <th>Owner</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map(({ contact: c, companyName }) => (
            <tr key={c.id}>
              <td>
                {c.firstName} {c.lastName}
              </td>
              <td>
                <button
                  type="button"
                  class="link"
                  onClick={() => go({ name: "company", id: c.companyId })}
                >
                  {companyName}
                </button>
              </td>
              <td>{c.title}</td>
              <td>{c.email}</td>
              <td class="muted">{c.phone}</td>
              <td>{c.ownerId === me.user.id ? "You" : c.ownerName}</td>
              <td>
                {c.ownerId === me.user.id ? (
                  <button type="button" class="link" onClick={() => setEditing(c)}>
                    Edit
                  </button>
                ) : (
                  <button type="button" class="link" onClick={() => setEditing(c)}>
                    View
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {first.data?.rows.length === 0 && <p class="muted">No contacts yet.</p>}
      {cursor && (
        <button type="button" disabled={task.busy} onClick={loadMore}>
          Load more
        </button>
      )}
      <Alert>{task.error}</Alert>
      {editing && (
        <ContactForm
          contact={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}

/** Creates a contact, or shows one: its owner can edit, hand over or delete it; others only read. */
export function ContactForm({
  contact,
  companyId,
  onClose
}: {
  contact?: Contact;
  companyId?: CompanyId;
  onClose: () => void;
}) {
  const { me } = useApp();
  const companies = useQuery(patchy.server.companies.list, {});
  const readOnly = contact !== undefined && contact.ownerId !== me.user.id;
  const [form, setForm] = useState({
    firstName: contact?.firstName ?? "",
    lastName: contact?.lastName ?? "",
    email: contact?.email ?? "",
    companyId: (contact?.companyId ?? companyId ?? "") as string,
    title: contact?.title ?? "",
    phone: contact?.phone ?? ""
  });
  const task = useTask();
  const field = (name: keyof typeof form, label: string, type = "text", required = false) => (
    <label>
      {label}
      <input
        name={name}
        type={type}
        required={required}
        readOnly={readOnly}
        value={form[name]}
        onInput={(e) => setForm({ ...form, [name]: e.currentTarget.value })}
      />
    </label>
  );
  const save = () =>
    void task.run(async () => {
      const company = companies.data?.find((c) => c.id === form.companyId);
      if (!company) throw new Error("Choose a company.");
      const fields = {
        ...form,
        companyId: company.id,
        title: form.title || null,
        phone: form.phone || null
      };
      if (contact) await patchy.server.contacts.update({ id: contact.id, ...fields });
      else await patchy.server.contacts.create(fields);
      onClose();
    });
  return (
    <Modal
      title={contact ? `${contact.firstName} ${contact.lastName}` : "New contact"}
      onClose={onClose}
    >
      <Form onSubmit={() => !readOnly && save()}>
        {field("firstName", "First name", "text", true)}
        {field("lastName", "Last name")}
        {field("email", "Email", "email", true)}
        <label>
          Company
          <select
            name="company"
            required
            disabled={readOnly}
            value={form.companyId}
            onChange={(e) => setForm({ ...form, companyId: e.currentTarget.value })}
          >
            <option value="">Choose…</option>
            {companies.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        {field("title", "Title")}
        {field("phone", "Phone", "tel")}
        {contact && (
          <Owner
            ownerId={contact.ownerId}
            ownerName={contact.ownerName}
            onHandoff={async (userId) => {
              await patchy.server.contacts.handoff({ id: contact.id, userId });
              onClose();
            }}
          />
        )}
        <Alert>{task.error}</Alert>
        {!readOnly && (
          <div class="actions">
            {contact && (
              <DeleteButton
                busy={task.busy}
                onConfirm={() =>
                  void task.run(async () => {
                    await patchy.server.contacts.remove({ id: contact.id });
                    onClose();
                  })
                }
              />
            )}
            <button type="button" class="primary" disabled={task.busy} onClick={save}>
              {contact ? "Save" : "Create contact"}
            </button>
          </div>
        )}
      </Form>
    </Modal>
  );
}

type Report = Awaited<ReturnType<typeof patchy.server.contacts.importCsv>>;

/** Uploads a CSV's text to the importer and shows what it added, rejected and skipped. */
export function Import() {
  const [report, setReport] = useState<Report | null>(null);
  const [fileName, setFileName] = useState("");
  const task = useTask();
  const run = (file: File) =>
    void task.run(async () => {
      setReport(null);
      setFileName(file.name);
      setReport(await patchy.server.contacts.importCsv({ csv: await file.text() }));
    });
  const rejected = report?.problems.filter((p) => p.outcome === "rejected") ?? [];
  const skipped = report?.problems.filter((p) => p.outcome === "skipped") ?? [];
  return (
    <section>
      <h1>Import contacts</h1>
      <p class="muted">
        A CSV with a header row: first_name, last_name, email, company, and optionally title and
        phone. Rows with an invalid email or no company are rejected; rows whose email already
        exists are skipped. Missing companies are created. You own everything you import.
      </p>
      <label class="button primary">
        {task.busy ? "Importing…" : "Choose CSV file"}
        <input
          type="file"
          accept=".csv,text/csv"
          hidden
          disabled={task.busy}
          onChange={(e) => {
            const f = e.currentTarget.files?.[0];
            if (f) run(f);
            e.currentTarget.value = "";
          }}
        />
      </label>
      <Alert>{task.error}</Alert>
      {report && (
        <div class="report" id="import-report">
          <h2>Imported {fileName}</h2>
          <p>
            <strong id="import-added">{report.added}</strong> contacts added · {rejected.length}{" "}
            rejected · {skipped.length} skipped as duplicates
            {report.companiesCreated.length > 0 &&
              ` · ${report.companiesCreated.length} companies created (${report.companiesCreated.join(", ")})`}
          </p>
          {report.problems.length > 0 && (
            <table class="grid">
              <thead>
                <tr>
                  <th>Line</th>
                  <th>Email</th>
                  <th>Outcome</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {report.problems.map((p) => (
                  <tr key={p.line} class={p.outcome}>
                    <td class="num">{p.line}</td>
                    <td>{p.email || <span class="muted">(empty)</span>}</td>
                    <td>{p.outcome === "rejected" ? "Rejected" : "Skipped"}</td>
                    <td>{p.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </section>
  );
}
