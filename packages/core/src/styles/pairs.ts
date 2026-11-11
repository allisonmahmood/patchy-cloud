/**
 * A pair: a control with what goes beside it, such as an email and Invite, a choice and its Save,
 * or a choice and why it is the only one. The part marked `grow` takes the room; on a phone the
 * two stack.
 */
export const pairs = `
    .pair { display: flex; align-items: flex-start; gap: var(--space-2) var(--space-3); }
    .pair > .grow { flex: 1; min-width: 0; }
    @media (max-width: 479px) { .pair { flex-direction: column; align-items: stretch; } }
`;
