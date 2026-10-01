import { formatMoney } from "../helpers/spend.js";
import type { Person, SpendRequest } from "./data.js";
import { age, asStatus, firstName } from "./format.js";
import { Avatar, Icon, StatusPill } from "./ui.js";

interface Props {
  readonly rows: readonly SpendRequest[];
  readonly people: ReadonlyMap<string, Person>;
  readonly selected: string | null;
  readonly onSelect: (id: string) => void;
}

/** The request list for the current tab; a row opens its detail drawer. */
export function RequestTable({ rows, people, selected, onSelect }: Props) {
  return (
    <div class="table" role="table" aria-label="Spend requests">
      <div class="table-head" role="row">
        <span role="columnheader">Request</span>
        <span role="columnheader">Category</span>
        <span role="columnheader">Requested by</span>
        <span role="columnheader" class="num">
          Amount
        </span>
        <span role="columnheader">Status</span>
        <span role="columnheader" class="num">
          Age
        </span>
      </div>
      {rows.map((row) => {
        const requester = people.get(row.requester);
        return (
          <button
            type="button"
            key={row.id}
            role="row"
            class={`table-row${row.id === selected ? " is-selected" : ""}`}
            onClick={() => onSelect(row.id)}
          >
            <span class="cell-request" role="cell">
              <span class="row-title">{row.title}</span>
              <span class="row-project">
                {row.project}
                {row.receipt !== null && (
                  <span class="row-receipt" title="Receipt attached">
                    <Icon name="clip" size={13} />
                  </span>
                )}
              </span>
            </span>
            <span role="cell">
              <span class="tag">{row.category}</span>
            </span>
            <span role="cell" class="cell-person">
              <Avatar person={requester} size="sm" />
              <span>{firstName(requester)}</span>
            </span>
            <span role="cell" class="num money">
              {formatMoney(row.amountCents)}
            </span>
            <span role="cell">
              <StatusPill status={asStatus(row.status)} />
            </span>
            <span role="cell" class="num muted">
              {age(row.submittedAt)}
            </span>
          </button>
        );
      })}
    </div>
  );
}
