import { useEffect, useRef, useState } from "patchy/preact";
import type { Upload } from "patchy/config";
import { isHandlerError, patchy } from "../patchy/_generated/client.js";
import {
  adminApprovalCents,
  categories,
  checkReceipt,
  projectSuggestions,
  receiptRequiredCents,
  refusals,
  type Category
} from "../helpers/spend.js";
import { amountInput, fileSize, messageOf, parseAmount } from "./format.js";
import { Banner, Icon } from "./ui.js";

/** A receipt adopted by an earlier attempt whose request wasn't saved; retrying reuses it. */
interface Kept {
  readonly id: string;
  readonly file: File;
}

/** The "New request" dialog. Submits through the submit action, which applies every rule again. */
export function NewRequest({
  projects,
  onClose,
  onCreated
}: {
  projects: readonly string[];
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [project, setProject] = useState("");
  const [category, setCategory] = useState<Category | null>(null);
  const [amount, setAmount] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [kept, setKept] = useState<Kept | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const titleInput = useRef<HTMLInputElement>(null);

  const cents = parseAmount(amount);
  const receiptNeeded = Number.isFinite(cents) && cents >= receiptRequiredCents;
  const adminNeeded = Number.isFinite(cents) && cents >= adminApprovalCents;
  const attached = kept?.file ?? file;
  const suggestions = [...new Set([...projectSuggestions, ...projects])].sort((a, b) =>
    a === "Studio" ? -1 : b === "Studio" ? 1 : a.localeCompare(b)
  );

  useEffect(() => {
    titleInput.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, saving]);

  function choose(chosen: File | undefined) {
    if (chosen === undefined) return;
    const problem = checkReceipt(chosen.type, chosen.size);
    setError(problem === null ? "" : refusals[problem]);
    if (problem === null) {
      setFile(chosen);
      setKept(null);
    }
  }

  function removeFile() {
    setFile(null);
    setKept(null);
    if (picker.current) picker.current.value = "";
  }

  async function submit() {
    if (saving) return;
    if (category === null) {
      setError("Choose a category.");
      return;
    }
    setSaving(true);
    setError("");
    const fields = { title, project, category, amountCents: Number.isFinite(cents) ? cents : 0 };
    let upload: Upload | undefined;
    try {
      if (kept !== null) {
        const { id } = await patchy.server.requests.submit({ ...fields, keptReceipt: kept.id });
        onCreated(id);
        return;
      }
      if (file !== null) upload = await patchy.files.stage(file, { contentType: file.type });
      const { id } = await patchy.server.requests.submit({
        ...fields,
        ...(upload !== undefined && file !== null ? { receipt: upload, fileName: file.name } : {})
      });
      onCreated(id);
    } catch (cause) {
      if (isHandlerError(cause, "not_saved") && upload !== undefined && file !== null) {
        // The receipt is stored even though the request isn't; the next try reuses it.
        const details = cause.details;
        const keptId =
          typeof details === "object" && details !== null && "keptReceipt" in details
            ? details.keptReceipt
            : null;
        if (typeof keptId === "string") setKept({ id: keptId, file });
        setError(
          `${refusals.not_saved} Press Submit to try again. You won't need to attach it again.`
        );
      } else {
        // A refused submission never adopted the staged file, so let it go.
        if (upload !== undefined) void patchy.files.discard(upload).catch(() => undefined);
        setError(messageOf(cause));
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      class="overlay overlay-center"
      onClick={(event) => event.target === event.currentTarget && !saving && onClose()}
    >
      <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="new-request-title">
        <header class="dialog-head">
          <div>
            <h2 id="new-request-title" class="dialog-title">
              New spend request
            </h2>
            <p class="muted">It goes to the team for approval. You'll see every step here.</p>
          </div>
          <button
            type="button"
            class="icon-button"
            onClick={onClose}
            disabled={saving}
            aria-label="Close"
          >
            <Icon name="close" size={18} />
          </button>
        </header>

        <div class="form">
          <label class="field">
            <span class="field-label">What's it for?</span>
            <input
              ref={titleInput}
              class="input"
              placeholder="e.g. Retoucher for the spring lookbook"
              value={title}
              maxLength={120}
              disabled={saving}
              onInput={(event) => setTitle(event.currentTarget.value)}
            />
          </label>

          <div class="field-row">
            <label class="field">
              <span class="field-label">Client or project</span>
              <input
                class="input"
                list="project-options"
                placeholder="Client name, or Studio"
                value={project}
                maxLength={80}
                disabled={saving}
                onInput={(event) => setProject(event.currentTarget.value)}
              />
              <datalist id="project-options">
                {suggestions.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            </label>
            <label class="field field-amount">
              <span class="field-label">Amount (USD)</span>
              <span class="amount-input">
                <span class="amount-prefix">$</span>
                <input
                  class="input"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={amount}
                  disabled={saving}
                  onInput={(event) => setAmount(event.currentTarget.value)}
                  onBlur={() =>
                    Number.isFinite(cents) && cents > 0 && setAmount(amountInput(cents))
                  }
                />
              </span>
            </label>
          </div>

          <div class="field">
            <span class="field-label">Category</span>
            <div class="chips" role="radiogroup" aria-label="Category">
              {categories.map((option) => (
                <button
                  type="button"
                  key={option}
                  role="radio"
                  aria-checked={category === option}
                  class={`chip cat-${option.toLowerCase()}${category === option ? " is-on" : ""}`}
                  disabled={saving}
                  onClick={() => setCategory(option)}
                >
                  <span class="chip-dot" />
                  {option}
                </button>
              ))}
            </div>
          </div>

          <div class="field">
            <span class="field-label">
              Receipt or quote
              <span class={`field-rule${receiptNeeded && attached === null ? " is-due" : ""}`}>
                {receiptNeeded ? "Required for $500 or more" : "Optional under $500"}
              </span>
            </span>
            <input
              ref={picker}
              type="file"
              class="visually-hidden"
              accept="application/pdf,image/png,image/jpeg,image/webp,.pdf,.png,.jpg,.jpeg,.webp"
              onChange={(event) => choose(event.currentTarget.files?.[0])}
            />
            {attached === null ? (
              <button
                type="button"
                class={`dropzone${dragging ? " is-dragging" : ""}${receiptNeeded ? " is-due" : ""}`}
                disabled={saving}
                onClick={() => picker.current?.click()}
                onDragOver={(event) => {
                  event.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(event) => {
                  event.preventDefault();
                  setDragging(false);
                  choose(event.dataTransfer?.files[0]);
                }}
              >
                <Icon name="upload" size={18} />
                <span>
                  <strong>Attach a receipt or quote</strong>
                  <span class="muted"> · PDF, PNG, JPG or WEBP up to 10 MB</span>
                </span>
              </button>
            ) : (
              <div class="file-chip">
                <span class="file-icon">
                  <Icon name="file" size={18} />
                </span>
                <span class="file-meta">
                  <span class="file-name">{attached.name}</span>
                  <span class="muted">
                    {fileSize(attached.size)}
                    {kept !== null && " · uploaded"}
                  </span>
                </span>
                <button
                  type="button"
                  class="icon-button"
                  onClick={removeFile}
                  disabled={saving}
                  aria-label="Remove file"
                >
                  <Icon name="close" size={16} />
                </button>
              </div>
            )}
          </div>

          {adminNeeded && (
            <Banner tone="note">Requests of $2,500 or more are approved by an admin.</Banner>
          )}
          {error && <Banner tone="danger">{error}</Banner>}
        </div>

        <footer class="dialog-foot">
          <button type="button" class="button ghost" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button
            type="button"
            class="button primary"
            onClick={() => void submit()}
            disabled={saving}
          >
            {saving ? "Submitting…" : "Submit request"}
          </button>
        </footer>
      </div>
    </div>
  );
}
