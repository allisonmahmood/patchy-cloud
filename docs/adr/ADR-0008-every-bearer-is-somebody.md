# Every bearer is somebody: the machine token

Patchy issues one credential: a user-owned machine token, one per machine and shared by the agents on it. Clerk holds the browser session; a machine token acts as its user on the API, never as an agent, company, bootstrap identity or operator. It expires 90 days after minting or after 30 idle days, whichever comes first.

A device login uses a URL carrying a short code. The person opens that URL in their signed-in browser, checks that the displayed code matches their terminal, names the machine, and confirms or denies. They never type a code into a page: asking someone who did not start a login to relay a code is the phishing path this protocol deliberately avoids. The bare URL explains how to open the terminal's link instead of offering code entry.

Confirmation records authorization, not a credential. The terminal's poll locks the confirmed login, rechecks that its user is active, mints the token, revokes the previous key only if it belongs to that same user, and deletes the login in one transaction. Plaintext exists only in memory and in the one successful response; only hashes are stored. Concurrent polls have one winner. An abandoned confirmation mints nothing and leaves the old key working. A lost successful response cannot be replayed: the user must start another login rather than recover plaintext from storage.

Only the user revokes their machine tokens: one or all on **Your machines**, a same-user replacement at login, or the bearer's own API logout. Deactivation revokes all of the user's tokens; reactivation never restores them. Dead token rows remain for version provenance and re-login name inheritance. Browser sign-out, also offered on create-or-join and the deactivated page, instead revokes the Clerk session and clears its cookies; it does not log machines out.

No self-service mint, bootstrap credential, operator credential, company-owned token or non-human token kind exists. CI credentials for machines nobody signs into remain future work, rather than weakening the rule that every bearer has a human owner.

Decided in [Auth spec §6, §8 and §9](https://github.com/allisonmahmood/patchy-cloud/issues/135), implemented by [#141](https://github.com/allisonmahmood/patchy-cloud/issues/141).
