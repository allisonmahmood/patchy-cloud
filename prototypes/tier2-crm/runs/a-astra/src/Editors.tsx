import { useQuery, useRef, useState } from "patchy/preact";
import { patchy } from "../patchy/_generated/client.js";
import { Attachments } from "./Attachments.js";
import { CompanyPicker, ErrorBox, Modal, OwnerSelect, money, stageNames, useTask } from "./ui.js";
import type { Company, Contact, Deal, Team, Stage } from "./ui.js";

interface EditorProps {
  team: Team;
  close: () => void;
  saved: (message: string) => void;
}

export function CompanyEditor({ row, team, close, saved }: EditorProps & { row?: Company }) {
  const [name, setName] = useState(row?.name ?? "");
  const [ownerId, setOwnerId] = useState(row?.ownerId ?? team.viewerId);
  const [confirm, setConfirm] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const task = useTask();
  function save() {
    if (!form.current?.reportValidity()) return;
    void task.run(async () => {
      await patchy.server.companies.save({ ...(row ? { id: row.id, ownerId } : {}), name });
      saved(row ? "Company updated." : "Company created.");
    });
  }
  return (
    <Modal title={row ? "Edit company" : "New company"} close={close}>
      <form
        ref={form}
        onSubmit={(e) => e.preventDefault()}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            save();
          }
        }}
      >
        <label>
          Company name
          <input
            autoFocus
            required
            maxLength={300}
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
          />
        </label>
        {row && <OwnerSelect value={ownerId} onChange={setOwnerId} team={team} />}
        <ErrorBox error={task.error} />
        <div className="form-actions">
          <button type="button" disabled={task.busy} onClick={save}>
            {task.busy ? "Saving…" : "Save company"}
          </button>
          {row && (
            <button
              type="button"
              className="danger-text"
              disabled={task.busy}
              onClick={() => {
                if (!confirm) setConfirm(true);
                else
                  void task.run(async () => {
                    await patchy.server.companies.remove({ id: row.id });
                    saved("Company deleted.");
                  });
              }}
            >
              {confirm ? "Confirm delete company" : "Delete company"}
            </button>
          )}
        </div>
        {confirm && (
          <p className="muted">
            Deletion is permanent. Companies with contacts or deals cannot be deleted.
          </p>
        )}
      </form>
    </Modal>
  );
}

export function ContactEditor({
  row,
  companyId: initialCompany,
  team,
  close,
  saved
}: EditorProps & {
  row?: Contact;
  companyId?: Company["id"];
}) {
  const [firstName, setFirstName] = useState(row?.firstName ?? "");
  const [lastName, setLastName] = useState(row?.lastName ?? "");
  const [email, setEmail] = useState(row?.email ?? "");
  const [companyId, setCompanyId] = useState<Company["id"] | "">(
    row?.companyId ?? initialCompany ?? ""
  );
  const [title, setTitle] = useState(row?.title ?? "");
  const [phone, setPhone] = useState(row?.phone ?? "");
  const [ownerId, setOwnerId] = useState(row?.ownerId ?? team.viewerId);
  const [confirm, setConfirm] = useState(false);
  const task = useTask();
  const form = useRef<HTMLFormElement>(null);
  function save() {
    if (!form.current?.reportValidity() || !companyId) return;
    void task.run(async () => {
      await patchy.server.contacts.save({
        ...(row ? { id: row.id, ownerId } : {}),
        firstName,
        lastName,
        email,
        companyId,
        title,
        phone
      });
      saved(row ? "Contact updated." : "Contact created.");
    });
  }
  return (
    <Modal title={row ? "Edit contact" : "New contact"} close={close}>
      <form
        ref={form}
        onSubmit={(e) => e.preventDefault()}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            save();
          }
        }}
      >
        <div className="form-grid">
          <label>
            First name
            <input
              autoFocus
              maxLength={300}
              value={firstName}
              onChange={(e) => setFirstName(e.currentTarget.value)}
            />
          </label>
          <label>
            Last name
            <input
              maxLength={300}
              value={lastName}
              onChange={(e) => setLastName(e.currentTarget.value)}
            />
          </label>
        </div>
        <label>
          Email
          <input
            required
            type="email"
            value={email}
            onChange={(e) => setEmail(e.currentTarget.value)}
          />
        </label>
        <CompanyPicker value={companyId} onChange={setCompanyId} />
        <div className="form-grid">
          <label>
            Job title
            <input
              maxLength={300}
              value={title}
              onChange={(e) => setTitle(e.currentTarget.value)}
            />
          </label>
          <label>
            Phone
            <input
              maxLength={300}
              value={phone}
              onChange={(e) => setPhone(e.currentTarget.value)}
            />
          </label>
        </div>
        {row && <OwnerSelect value={ownerId} onChange={setOwnerId} team={team} />}
        <ErrorBox error={task.error} />
        <div className="form-actions">
          <button type="button" disabled={task.busy} onClick={save}>
            {task.busy ? "Saving…" : "Save contact"}
          </button>
          {row && (
            <button
              type="button"
              className="danger-text"
              disabled={task.busy}
              onClick={() => {
                if (!confirm) setConfirm(true);
                else
                  void task.run(async () => {
                    await patchy.server.contacts.remove({ id: row.id });
                    saved("Contact deleted.");
                  });
              }}
            >
              {confirm ? "Confirm delete contact" : "Delete contact"}
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}

export function DealEditor({
  row,
  companyId: initialCompany,
  team,
  close,
  saved
}: EditorProps & {
  row?: Deal;
  companyId?: Company["id"];
}) {
  const [title, setTitle] = useState(row?.title ?? "");
  const [companyId, setCompanyId] = useState<Company["id"] | "">(
    row?.companyId ?? initialCompany ?? ""
  );
  const [value, setValue] = useState(row ? (row.valueCents / 100).toFixed(2) : "");
  const [stage, setStage] = useState<Stage>((row?.stage as Stage) ?? "Lead");
  const [privateDeal, setPrivate] = useState(row?.private ?? false);
  const [ownerId, setOwnerId] = useState(row?.ownerId ?? team.viewerId);
  const task = useTask();
  const form = useRef<HTMLFormElement>(null);
  function save() {
    if (!form.current?.reportValidity() || !companyId) return;
    void task.run(async () => {
      await patchy.server.deals.save({
        ...(row ? { id: row.id, ownerId } : {}),
        title,
        companyId,
        valueCents: Math.round(Number(value) * 100),
        stage,
        private: privateDeal
      });
      saved(row ? "Deal updated." : "Deal created.");
    });
  }
  return (
    <Modal title={row ? "Edit deal" : "New deal"} close={close}>
      <form
        ref={form}
        onSubmit={(e) => e.preventDefault()}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            save();
          }
        }}
      >
        <label>
          Deal name
          <input
            autoFocus
            required
            maxLength={300}
            value={title}
            onChange={(e) => setTitle(e.currentTarget.value)}
          />
        </label>
        <CompanyPicker value={companyId} onChange={setCompanyId} />
        <div className="form-grid">
          <label>
            Value · USD
            <input
              required
              type="number"
              min="0"
              max="20000000"
              step="0.01"
              value={value}
              onChange={(e) => setValue(e.currentTarget.value)}
            />
          </label>
          <label>
            Stage
            <select value={stage} onChange={(e) => setStage(e.currentTarget.value as Stage)}>
              {stageNames.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
          </label>
        </div>
        <label className="check-label">
          <input
            type="checkbox"
            checked={privateDeal}
            onChange={(e) => setPrivate(e.currentTarget.checked)}
          />
          Private deal
        </label>
        <p className="muted">
          Private deals and their attachments are visible only to their owner.
        </p>
        {row && (
          <p className="muted">
            Privacy changes do not revoke previously issued file handles or downloaded bytes. Remove
            sensitive attachments before transferring ownership or making a shared deal private.
          </p>
        )}
        {row && <OwnerSelect value={ownerId} onChange={setOwnerId} team={team} />}
        <ErrorBox error={task.error} />
        <div className="form-actions">
          <button type="button" disabled={task.busy} onClick={save}>
            {task.busy ? "Saving…" : "Save deal"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function DealDetail({
  id,
  team,
  close,
  edit,
  saved
}: EditorProps & { id: Deal["id"]; edit: (deal: Deal) => void }) {
  const { data: deal, error } = useQuery(patchy.server.deals.get, { id });
  const [confirm, setConfirm] = useState(false);
  const task = useTask();
  return (
    <Modal title={deal && !error ? deal.title : "Deal details"} close={close}>
      <ErrorBox error={error} />
      {!error && deal && (
        <>
          <div className="deal-summary">
            <strong>{money(deal.valueCents)}</strong>
            <span className="badge">{deal.stage}</span>
            {deal.private && <span className="badge private">Private</span>}
          </div>
          {deal.ownerId === team.viewerId && (
            <div className="form-actions">
              <button type="button" onClick={() => edit(deal)}>
                Edit deal
              </button>
              <button
                type="button"
                className="danger-text"
                disabled={task.busy}
                onClick={() => {
                  if (!confirm) setConfirm(true);
                  else
                    void task.run(async () => {
                      await patchy.server.deals.remove({ id });
                      saved("Deal deleted.");
                    });
                }}
              >
                {confirm ? "Confirm delete deal" : "Delete deal"}
              </button>
            </div>
          )}
          {confirm && (
            <p className="muted">
              Delete this deal permanently? Remove attachments first if you also want to erase their
              stored bytes.
            </p>
          )}
          <ErrorBox error={task.error} />
          <Attachments dealId={id} editable={deal.ownerId === team.viewerId} />
        </>
      )}
    </Modal>
  );
}
