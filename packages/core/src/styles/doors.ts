/**
 * Doors: one centred card on the grid-and-gradient canvas, for sign-in, joining, device login,
 * consent and Patchy's notices. Modal elevation, a dialog title, one primary.
 */
export const doors = `
    .auth-card {
      display: block;
      width: min(var(--w-door), calc(100% - 32px));
      margin: var(--space-8) auto;
      padding: var(--space-6);
      border: 2px solid var(--ink); border-radius: var(--r-modal);
      background: var(--surface); box-shadow: var(--modal);
      overflow-wrap: anywhere;
    }
    .auth-card > .brand { margin-bottom: var(--space-5); }
    .auth-card > .page-heading { margin-bottom: var(--space-3); }
    .auth-card > p:last-child { margin-bottom: 0; }
    .auth-card .actions { margin-top: var(--space-5); }
    @media (max-width: 479px) { .auth-card { margin-block: var(--space-6); padding: var(--space-5); } }
`;
