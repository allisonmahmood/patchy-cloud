import { useState } from "patchy/preact";
import { useQuery } from "patchy/preact";
import {
  patchy,
  describe,
  useTeam,
  useRunner,
  useOwnerName,
  Ownership,
  onEnter,
  type Company,
  type Contact
} from "./lib.js";

/** Every contact, filterable, with a create form. */
export function Contacts({ companies }: { companies: readonly Company[] }) {
  const { data, error } = useQuery(patchy.server.contacts.list, {});
  const [filter, setFilter] = useState("");
  const [adding, setAdding] = useState(false);
  const needle = filter.trim().toLowerCase();
  const companyName = (id: Company["id"]) =>
    companies.find((company) => company.id === id)?.name ?? "";
  const shown = (data ?? []).filter((contact) =>
    `${contact.firstName} ${contact.lastName} ${contact.email} ${companyName(contact.company)}`
      .toLowerCase()
      .includes(needle)
  );
  return (
    <div>
      <div class="toolbar">
        <h2>Contacts</h2>
        <span class="muted">{data ? `${shown.length} of ${data.length}` : ""}</span>
        <input
          type="search"
          placeholder="Filter…"
          value={filter}
          onInput={(event) => setFilter(event.currentTarget.value)}
        />
        <button type="button" class="primary" onClick={() => setAdding(!adding)}>
          {adding ? "Cancel" : "New contact"}
        </button>
      </div>
      {adding && <ContactForm companies={companies} done={() => setAdding(false)} />}
      {error && (
        <p class="error" role="alert">
          {describe(error)}
        </p>
      )}
      <table class="grid">
        <thead>
          <tr>
            <th>Name</th>
            <th>Email</th>
            <th>Company</th>
            <th>Title</th>
            <th>Owner</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {shown.map((contact) => (
            <ContactRow key={contact.id} contact={contact} companies={companies} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A contact row; the owner can edit, delete or hand it over. */
export function ContactRow({
  contact,
  companies,
  hideCompany = false
}: {
  contact: Contact;
  companies: readonly Company[];
  hideCompany?: boolean;
}) {
  const { me } = useTeam();
  const owner = useOwnerName(contact.ownerId);
  const [editing, setEditing] = useState(false);
  const remover = useRunner();
  const mine = contact.ownerId === me;
  const columns = hideCompany ? 5 : 6;
  if (editing)
    return (
      <tr>
        <td colSpan={columns}>
          <ContactForm companies={companies} contact={contact} done={() => setEditing(false)} />
        </td>
      </tr>
    );
  return (
    <tr>
      <td>
        {contact.firstName} {contact.lastName}
      </td>
      <td>{contact.email}</td>
      {!hideCompany && (
        <td>{companies.find((company) => company.id === contact.company)?.name ?? ""}</td>
      )}
      <td class="muted">{contact.title ?? ""}</td>
      <td>
        {mine ? (
          <Ownership
            compact
            ownerId={contact.ownerId}
            transfer={(toUserId) => patchy.server.contacts.transfer({ id: contact.id, toUserId })}
          />
        ) : (
          owner
        )}
      </td>
      <td class="actions">
        {mine && (
          <button type="button" class="small" onClick={() => setEditing(true)}>
            Edit
          </button>
        )}
        {mine && (
          <button
            type="button"
            class="small danger"
            disabled={remover.busy}
            onClick={() =>
              void remover.run(() => patchy.server.contacts.remove({ id: contact.id }))
            }
          >
            Delete
          </button>
        )}
        {remover.error && <span class="error">{remover.error}</span>}
      </td>
    </tr>
  );
}

export function ContactForm({
  companies,
  contact,
  companyId,
  done
}: {
  companies: readonly Company[];
  contact?: Contact;
  companyId?: Company["id"];
  done: () => void;
}) {
  const [draft, setDraft] = useState({
    firstName: contact?.firstName ?? "",
    lastName: contact?.lastName ?? "",
    email: contact?.email ?? "",
    title: contact?.title ?? "",
    phone: contact?.phone ?? "",
    company: contact?.company ?? companyId ?? ""
  });
  const { busy, error, setError, run } = useRunner();
  const field = (key: Exclude<keyof typeof draft, "company">, label: string) => (
    <label>
      {label}
      <input
        name={key}
        value={draft[key]}
        onInput={(event) => setDraft({ ...draft, [key]: event.currentTarget.value })}
      />
    </label>
  );
  const save = async () => {
    const company = companies.find((row) => row.id === draft.company);
    if (!company) return setError("Pick a company.");
    const input = { ...draft, company: company.id };
    const saved = await run(() =>
      contact
        ? patchy.server.contacts.update({ id: contact.id, ...input })
        : patchy.server.contacts.create(input)
    );
    if (saved) done();
  };
  return (
    <div class="form" onKeyDown={onEnter(() => void save())}>
      {field("firstName", "First name")}
      {field("lastName", "Last name")}
      {field("email", "Email")}
      <label>
        Company
        <select
          name="company"
          value={draft.company}
          onChange={(event) => setDraft({ ...draft, company: event.currentTarget.value })}
        >
          <option value="">Choose…</option>
          {companies.map((row) => (
            <option key={row.id} value={row.id}>
              {row.name}
            </option>
          ))}
        </select>
      </label>
      {field("title", "Title")}
      {field("phone", "Phone")}
      <div class="row">
        <button type="button" class="primary" disabled={busy} onClick={() => void save()}>
          {contact ? "Save" : "Create contact"}
        </button>
        <button type="button" onClick={done}>
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
