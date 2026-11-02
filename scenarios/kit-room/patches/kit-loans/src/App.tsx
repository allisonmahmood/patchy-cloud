import { useQuery, useState } from "patchy/preact";
import { patchy } from "../patchy/_generated/client.js";

export function App() {
  const loans = useQuery(patchy.server.loans.out, {});
  const people = useQuery(patchy.server.loans.people, {});
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  function run(change: () => Promise<unknown>) {
    setBusy(true);
    setNotice("");
    void change()
      .catch((cause: unknown) => setNotice(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false));
  }

  function lend(form: HTMLFormElement) {
    if (busy || !form.reportValidity()) return;
    const data = new FormData(form);
    const item = String(data.get("item") ?? "").trim();
    const borrower = String(data.get("borrower") ?? "");
    const due = String(data.get("due") ?? "");
    run(() =>
      patchy.server.loans
        .lend({ item, borrower, due: due === "" ? null : due })
        .then(() => form.reset())
    );
  }

  // The sandbox blocks native form submission; save through the broker instead.
  return (
    <main>
      <h1>Kit loans</h1>
      <form>
        <label>
          Item <input name="item" required disabled={busy} />
        </label>
        <label>
          Who has it
          <select name="borrower" required disabled={busy}>
            <option value="">Choose…</option>
            {(people.data ?? []).map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Due back <input name="due" type="date" disabled={busy} />
        </label>
        <button type="button" disabled={busy} onClick={(event) => lend(event.currentTarget.form!)}>
          Lend
        </button>
      </form>
      {notice !== "" && <p role="alert">{notice}</p>}
      {loans.status === "error" ? (
        <p role="alert">{loans.error?.message}</p>
      ) : loans.data === undefined ? (
        <p>Loading…</p>
      ) : loans.data.length === 0 ? (
        <section>
          <p>Nothing is out.</p>
          <button
            type="button"
            disabled={busy}
            onClick={() => run(() => patchy.server.sample.load({}))}
          >
            Load sample data
          </button>
        </section>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Item</th>
              <th>Who has it</th>
              <th>Due back</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {loans.data.map((loan) => (
              <tr key={loan.id}>
                <td>{loan.item}</td>
                <td>{loan.borrower}</td>
                <td>{loan.overdue ? `${loan.due} (overdue)` : loan.due}</td>
                <td>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => run(() => patchy.server.loans.back({ id: loan.id }))}
                  >
                    Back
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
