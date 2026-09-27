import { useState } from "patchy/preact";
import { useQuery, useFileUrl } from "patchy/preact";
import type { FileHandle } from "patchy/client";
import { isHandlerError, isPatchyError } from "../patchy/_generated/client.js";
import {
  patchy,
  money,
  describe,
  useTeam,
  useRunner,
  Ownership,
  onEnter,
  STAGES,
  type Company,
  type Deal,
  type Stage
} from "./lib.js";

/** Create a deal (no `deal`) or edit one the viewer owns. */
export function DealForm({
  companies,
  deal,
  companyId,
  done
}: {
  companies: readonly Company[];
  deal?: Deal;
  companyId?: Company["id"];
  done: () => void;
}) {
  const [title, setTitle] = useState(deal?.title ?? "");
  const [company, setCompany] = useState<string>(deal?.company ?? companyId ?? "");
  const [value, setValue] = useState(deal ? String(deal.valueCents / 100) : "");
  const [stage, setStage] = useState<Stage>((deal?.stage as Stage | undefined) ?? "Lead");
  const [secret, setSecret] = useState(deal?.private ?? false);
  const { busy, error, setError, run } = useRunner();
  const save = async () => {
    const dollars = Number(value.replaceAll(",", "").replace(/^\$/, ""));
    if (value.trim() === "" || !Number.isFinite(dollars) || dollars < 0)
      return setError("Enter the value in dollars.");
    const picked = companies.find((row) => row.id === company);
    if (!picked) return setError("Pick a company.");
    const input = {
      title,
      company: picked.id,
      valueCents: Math.round(dollars * 100),
      stage,
      private: secret
    };
    const saved = await run(() =>
      deal
        ? patchy.server.deals.update({ id: deal.id, ...input })
        : patchy.server.deals.create(input)
    );
    if (saved) done();
  };
  return (
    <div class="form" onKeyDown={onEnter(() => void save())}>
      <label>
        Title
        <input
          name="title"
          value={title}
          onInput={(event) => setTitle(event.currentTarget.value)}
        />
      </label>
      <label>
        Company
        <select
          name="company"
          value={company}
          onChange={(event) => setCompany(event.currentTarget.value)}
        >
          <option value="">Choose…</option>
          {companies.map((row) => (
            <option key={row.id} value={row.id}>
              {row.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Value ($)
        <input
          name="value"
          inputMode="decimal"
          value={value}
          onInput={(event) => setValue(event.currentTarget.value)}
        />
      </label>
      <label>
        Stage
        <select
          name="stage"
          value={stage}
          onChange={(event) => setStage(event.currentTarget.value as Stage)}
        >
          {STAGES.map((option) => (
            <option key={option}>{option}</option>
          ))}
        </select>
      </label>
      <label class="check">
        <input
          type="checkbox"
          name="private"
          checked={secret}
          onChange={(event) => setSecret(event.currentTarget.checked)}
        />{" "}
        Private (only you can see it)
      </label>
      <div class="row">
        <button type="button" class="primary" disabled={busy} onClick={() => void save()}>
          {deal ? "Save" : "Create deal"}
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

/** Side panel for one deal: details, owner controls and attachments. */
export function DealPanel({
  id,
  companies,
  close
}: {
  id: Deal["id"];
  companies: readonly Company[];
  close: () => void;
}) {
  const { data: deal, error } = useQuery(patchy.server.deals.get, { id });
  const { me } = useTeam();
  const [editing, setEditing] = useState(false);
  const remover = useRunner();
  const [removal, setRemoval] = useState("");
  if (error)
    return (
      <aside class="panel">
        <button type="button" class="close" onClick={close}>
          ×
        </button>
        <p class="error">{describe(error)}</p>
      </aside>
    );
  if (deal === undefined)
    return (
      <aside class="panel">
        <p class="muted">Loading…</p>
      </aside>
    );
  if (deal === null)
    return (
      <aside class="panel">
        <button type="button" class="close" onClick={close}>
          ×
        </button>
        <p>This deal no longer exists or is not visible to you.</p>
      </aside>
    );
  const mine = deal.ownerId === me;
  const company = companies.find((row) => row.id === deal.company);
  const remove = async () => {
    const result = await remover.run(() => patchy.server.deals.remove({ id: deal.id }));
    if (!result) return;
    if (result.dealRemoved) return close();
    setRemoval(
      result.filesLeft > 0
        ? `${result.filesRemoved} attachment(s) deleted, ${result.filesLeft} could not be; the deal was kept. Try again.`
        : `All ${result.filesRemoved} attachment(s) were deleted, but the deal itself was not. Try again.`
    );
  };
  return (
    <aside class="panel" id="deal-panel">
      <button type="button" class="close" onClick={close} aria-label="Close">
        ×
      </button>
      <h2>
        {deal.title} {deal.private && <span class="badge">Private</span>}
      </h2>
      {editing ? (
        <DealForm companies={companies} deal={deal} done={() => setEditing(false)} />
      ) : (
        <dl class="facts">
          <dt>Company</dt>
          <dd>{company?.name ?? "—"}</dd>
          <dt>Value</dt>
          <dd>{money(deal.valueCents)}</dd>
          <dt>Stage</dt>
          <dd>{deal.stage}</dd>
        </dl>
      )}
      <Ownership
        ownerId={deal.ownerId}
        transfer={(toUserId) => patchy.server.deals.transfer({ id: deal.id, toUserId })}
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
            onClick={() => {
              if (confirm(`Delete “${deal.title}” and its attachments?`)) void remove();
            }}
          >
            Delete
          </button>
        </div>
      )}
      {remover.error && (
        <p class="error" role="alert">
          {remover.error}
        </p>
      )}
      {removal && (
        <p class="warning" role="alert">
          {removal}
        </p>
      )}
      <Attachments deal={deal} mine={mine} />
    </aside>
  );
}

type Attempt = {
  readonly file: string;
  readonly tone: "ok" | "warning" | "error" | "busy";
  readonly text: string;
};

/** Attachments: anyone who can see the deal views and downloads; the owner attaches and removes. */
function Attachments({ deal, mine }: { deal: Deal; mine: boolean }) {
  const { data, error } = useQuery(patchy.server.files.forDeal, { dealId: deal.id });
  const [attempts, setAttempts] = useState<readonly Attempt[]>([]);
  const actions = useRunner();
  const report = (attempt: Attempt) =>
    setAttempts((list) => [...list.filter((row) => row.file !== attempt.file), attempt]);

  /** Two steps the person must be told about separately: staging the bytes, then the attach action (store + record). */
  const attachOne = async (file: File) => {
    report({ file: file.name, tone: "busy", text: "Uploading…" });
    let upload;
    try {
      upload = await patchy.files.stage(file, {
        contentType: file.type || "application/octet-stream"
      });
    } catch (cause) {
      return report({
        file: file.name,
        tone: "error",
        text: `Upload failed; nothing was saved. (${describe(cause)})`
      });
    }
    try {
      const result = await patchy.server.files.attach({
        dealId: deal.id,
        name: file.name,
        file: upload
      });
      report(
        result.recorded
          ? { file: file.name, tone: "ok", text: `Attached as “${result.name}”.` }
          : {
              file: file.name,
              tone: "warning",
              text: `The file is stored but was not recorded on the deal; it is listed below as “not recorded”. Use Retry there, or Remove it.`
            }
      );
    } catch (cause) {
      if (isPatchyError(cause, "unknown_outcome"))
        return report({
          file: file.name,
          tone: "warning",
          text: "No reply from Patchy: the file may or may not be stored. The list below is live; check it before trying again."
        });
      if (isHandlerError(cause))
        return report({
          file: file.name,
          tone: "error",
          text: `Not attached; nothing was stored. ${describe(cause)}`
        });
      report({
        file: file.name,
        tone: "error",
        text: `Storing the file failed; nothing was attached. (${describe(cause)})`
      });
    }
  };

  const detach = async (name: string) => {
    const result = await actions.run(() => patchy.server.files.detach({ dealId: deal.id, name }));
    if (result && !result.unrecorded)
      actions.setError(`“${name}” was deleted, but its record remains. Remove again to clear it.`);
  };

  return (
    <section class="attachments">
      <h3>Attachments</h3>
      {error && (
        <p class="error" role="alert">
          {describe(error)}
        </p>
      )}
      {data === undefined ? (
        <p class="muted">Loading…</p>
      ) : data.length === 0 ? (
        <p class="muted">No attachments.</p>
      ) : (
        <ul class="files">
          {data.map((file) => (
            <li key={file.name}>
              {file.contentType.startsWith("image/") && (
                <Thumb handle={file.handle} alt={file.name} />
              )}
              <div class="grow">
                <div>{file.name}</div>
                <div class="muted small">
                  {(file.size / 1024).toFixed(1)} KB · {file.contentType}
                  {!file.recorded && <span class="warning-text"> · not recorded</span>}
                </div>
              </div>
              <button
                type="button"
                onClick={() =>
                  void actions.run(() => patchy.files.download(file.handle, file.name))
                }
              >
                Download
              </button>
              {mine && !file.recorded && (
                <button
                  type="button"
                  onClick={() =>
                    void actions.run(() =>
                      patchy.server.files.record({ dealId: deal.id, name: file.name })
                    )
                  }
                >
                  Retry
                </button>
              )}
              {mine && (
                <button type="button" class="danger" onClick={() => void detach(file.name)}>
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {mine && (
        <label class="upload">
          Attach files
          <input
            type="file"
            multiple
            onChange={(event) => {
              const files = [...(event.currentTarget.files ?? [])];
              event.currentTarget.value = "";
              void (async () => {
                for (const file of files) await attachOne(file);
              })();
            }}
          />
        </label>
      )}
      {attempts.length > 0 && (
        <ul class="attempts">
          {attempts.map((attempt) => (
            <li key={attempt.file} class={attempt.tone}>
              <strong>{attempt.file}</strong>: {attempt.text}
            </li>
          ))}
        </ul>
      )}
      {actions.error && (
        <p class="error" role="alert">
          {actions.error}
        </p>
      )}
    </section>
  );
}

export function Thumb({ handle, alt }: { handle: FileHandle; alt: string }) {
  const { url, error } = useFileUrl(handle);
  if (error)
    return (
      <span class="thumb muted small">
        {error.code === "not_found" ? "Replaced" : "Unavailable"}
      </span>
    );
  return url ? <img class="thumb" src={url} alt={alt} /> : <span class="thumb" />;
}
