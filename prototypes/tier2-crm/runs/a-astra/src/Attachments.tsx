import { useFileUrl, useQuery, useState } from "patchy/preact";
import type { FileHandle } from "patchy/client";
import { patchy, isHandlerError } from "../patchy/_generated/client.js";
import { ErrorBox, Pager, errorMessage, useTask } from "./ui.js";
import type { Deal } from "./ui.js";

function Preview({ handle, name }: { handle: FileHandle; name: string }) {
  const { url, error } = useFileUrl(handle);
  const [expanded, setExpanded] = useState(false);
  if (error) return <ErrorBox error={error} />;
  if (!url) return <span className="muted">Loading preview…</span>;
  return (
    <>
      <button
        type="button"
        className="preview-toggle"
        aria-label={`View ${name}`}
        onClick={() => setExpanded(true)}
      >
        <img className="attachment-preview" src={url} alt={name} />
      </button>
      {expanded && (
        <div className="image-viewer" role="dialog" aria-label={name}>
          <button type="button" onClick={() => setExpanded(false)}>
            Close preview
          </button>
          <img src={url} alt={name} />
        </div>
      )}
    </>
  );
}
export function Attachments({ dealId, editable }: { dealId: Deal["id"]; editable: boolean }) {
  const [cursor, setCursor] = useState<string>();
  const { data, error } = useQuery(patchy.server.attachments.list, {
    dealId,
    ...(cursor ? { cursor } : {})
  });
  const task = useTask();
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState<{ token: string; name: string }>();
  const [uncertain, setUncertain] = useState(false);
  async function upload(file: File) {
    if (file.size > 20 * 1024 * 1024) {
      setMessage("The file was not staged. The maximum size is 20 MiB.");
      return;
    }
    const attempt = { token: crypto.randomUUID(), name: file.name };
    setPending(attempt);
    setUncertain(false);
    setMessage("Staging file. No attachment has been saved yet.");
    let staged;
    try {
      staged = await patchy.files.stage(file, {
        contentType: file.type || "application/octet-stream"
      });
    } catch (cause) {
      setPending(undefined);
      setMessage(
        `Staging failed. No attach request was sent and no attachment was saved. ${errorMessage(cause)}`
      );
      return;
    }
    setMessage("The upload is staged. Saving it to the deal…");
    try {
      const result = await patchy.server.attachments.attach({ dealId, ...attempt, file: staged });
      setMessage(result.message);
      setUncertain(result.state === "unknown");
    } catch (cause) {
      if (isHandlerError(cause)) {
        setPending(undefined);
        setMessage(
          `The file was staged, but the server rejected the attachment before saving it. ${errorMessage(cause)} Choose the file again after correcting the problem.`
        );
        return;
      }
      setMessage(
        `The attach request did not return success. ${errorMessage(cause)} Checking whether the file exists…`
      );
      try {
        const result = await patchy.server.attachments.status({ dealId, ...attempt });
        setMessage(result.message);
      } catch (statusError) {
        setUncertain(true);
        setMessage(`The upload outcome is unknown. Do not retry yet. ${errorMessage(statusError)}`);
      }
    }
  }
  return (
    <section className="attachments">
      <h3>Attachments</h3>
      <p className="muted">Visible to everyone who can see this deal. Up to 20 MiB per file.</p>
      <ErrorBox error={error} />
      <ErrorBox error={task.error} />
      {editable && (
        <label className="file-picker">
          Attach a file
          <input
            type="file"
            aria-label="Attach a file"
            disabled={task.busy || uncertain}
            onChange={(e) => {
              const file = e.currentTarget.files?.[0];
              e.currentTarget.value = "";
              if (file) void task.run(() => upload(file));
            }}
          />
        </label>
      )}
      {message && (
        <p role="status" className="notice">
          {message}
        </p>
      )}
      {pending && (
        <button
          type="button"
          className="secondary"
          disabled={task.busy}
          onClick={() =>
            void task.run(async () => {
              const result = await patchy.server.attachments.status({ dealId, ...pending });
              setMessage(result.message);
              setUncertain(false);
            })
          }
        >
          Check last upload status
        </button>
      )}
      {!error && data && (
        <>
          <div className="attachment-list">
            {data.files.map((file) => {
              const name = file.name.split("/").at(-1) ?? file.name;
              return (
                <article className="attachment" key={file.name}>
                  {/^image\/(png|jpeg|gif|webp)$/.test(file.contentType) && (
                    <Preview handle={file.handle} name={name} />
                  )}
                  <div>
                    <strong>{name}</strong>
                    <small>
                      {(file.size / 1024).toFixed(1)} KiB · {file.contentType}
                    </small>
                  </div>
                  <button
                    type="button"
                    className="secondary"
                    disabled={task.busy}
                    onClick={() => void task.run(() => patchy.files.download(file.handle, name))}
                  >
                    Download
                  </button>
                  {editable && (
                    <button
                      type="button"
                      className="danger-text"
                      disabled={task.busy}
                      onClick={() =>
                        void task.run(async () => {
                          const result = await patchy.server.attachments.remove({
                            dealId,
                            name: file.name
                          });
                          setMessage(result.message);
                          setUncertain(result.state === "unknown");
                        })
                      }
                    >
                      Remove
                    </button>
                  )}
                </article>
              );
            })}
          </div>
          {!data.files.length && <p className="muted">No attachments on this page.</p>}
          <Pager cursor={data.cursor} next={setCursor} reset={() => setCursor(undefined)} />
        </>
      )}
    </section>
  );
}
