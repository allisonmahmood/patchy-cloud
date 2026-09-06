# ADR-0008 — Every bearer is somebody: the machine token

Patchy issues one credential: a user-owned machine token held by a machine and shared by the agents on it. Clerk holds the browser session; a machine token acts as its user on the API and never opens a company patch's login door. It expires 90 days after minting or after 30 idle days, whichever comes first.

A device login uses a URL carrying a short code. The person opens that URL in their signed-in browser, checks that the displayed code matches their terminal, names the machine, and confirms or denies. They never type a code into a page: asking someone who did not start a login to relay a code is the phishing path this protocol deliberately avoids. The bare URL explains how to open the terminal's link instead of offering code entry.

Confirmation records authorization, not a credential. The terminal's poll locks the confirmed login, rechecks that its user is active, mints the token, revokes the previous key only if it belongs to that same user, and deletes the login in one transaction. Plaintext exists only in memory and in the one successful response; only hashes are stored. Concurrent polls have one winner. An abandoned confirmation mints nothing and leaves the old key working. A lost successful response cannot be replayed: the user must start another login rather than recover plaintext from storage.

Users control their own machine tokens: revoke one or all on **Your machines**, replace an owned key at login, or revoke the bearer itself through API logout. An admin's deactivation of a user revokes all that user's tokens in the same transaction; reactivation never restores them. Dead token rows remain for version provenance and re-login name inheritance. Browser sign-out instead revokes the Clerk session and clears its cookies; it does not log machines out, and remains available before create-or-join and after deactivation.

Every bearer has a human owner. Credentials for unattended CI are a future product decision, not another token kind in this model.

Decided in [Auth spec §6, §8 and §9](https://github.com/allisonmahmood/patchy-cloud/issues/135), implemented by [#141](https://github.com/allisonmahmood/patchy-cloud/issues/141).
