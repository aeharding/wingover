# Wingover — Sync UX: Subscription and Log In

_v1 — 2026-07-15. The UX contract for sync's user-facing surfaces. Companion to
[STEERING.md](STEERING.md) (values, data model) and
[ARCHITECTURE.md](ARCHITECTURE.md) (runtime). High-level direction only; no
implementation detail lives here. If a sync UI change contradicts this doc,
change the doc first or don't make the change._

## The rule: two rails, never mixed

Sync has exactly two user-facing concerns, and they are orthogonal:

- **Subscription** — payments. Subscribe, restore, resubscribe, manage, cancel.
  A commercial relationship with Apple (later: with our web checkout).
- **Log In** — connection. Which CouchDB this device syncs to, whether it's
  connected, and how to connect or disconnect. Self-host setup is a login.

The client's whole model is one question — _does this device hold a CouchDB
credential, and is it entitled?_ — and the two rails answer its two halves.
**Paying and connecting are independent.** Every combination is a real,
supported person:

|                    | **Logged in**                                          | **Not logged in**                          |
| ------------------ | ------------------------------------------------------ | ------------------------------------------ |
| **Subscribed**     | Mainline hosted subscriber — or the **supporter**, self-hosting on principle while paying | Paying, but turned sync off on this device; or a fresh device before restore |
| **Not subscribed** | Self-hoster (free, forever) — and the **lapsed** subscriber: login persists, entitlement gone → read-only | Fresh install                              |

The supporter and lapsed quadrants are the proof of the model. A subscription
with a self-host login is _support_, and the UI must not treat it as a
misconfiguration. A lapse kills entitlement, never the login — matching the
sync engine, which drops to pull-only and keeps the credential.

The rails share one sheet but never blur: payment verbs (Subscribe, Restore,
Manage, Resubscribe) and connection verbs (Sign in, Turn off sync, the
self-host form, Delete account) appear only in the states that earn them, and
no state conflates the two.

## Settings: one row

```
┌───────────────────────────────┐
│ Sync             Local Only  ›│      ← red when nothing backs the flights up
└───────────────────────────────┘
```

One row, one question: are the flights backed up? The note is the sync state
(`On` / `Paused` / `Not subscribed` / `Problem`), and a red `Local Only` when
sync is off — off is never a neutral dash. Payment facts
(Active/Expired, price) live inside the sheet. The two rails stay real in the
architecture and on the server; they stopped being Settings geography after
both two-rows and a transforming label shipped and got reverted — pilots
think in one question, and the org chart of the billing system is not their
problem.

## The Sync sheet

One modal, every view derived from state, nothing to operate that the state
doesn't earn:

- **Nothing yet** — the pitch. iOS: **Subscribe** is primary (no login exists
  or is needed — the transaction is the identity), **Sign in with Apple**
  beneath it for an account born elsewhere (the web/Stripe future), Restore
  Purchases and **Self-hosted config** as quiet links. Web: Sign in with
  Apple is primary — it is the account door, and step one of web checkout
  once that exists — over the Self-hosted config link. Paywall fine print
  (price, period, terms, privacy) lives here.
- **Connected** — status headline (On, last synced) + Turn off sync +
  Manage Subscription (StoreKit's native sheet — the only surface that shows
  sandbox subs) + "Use on your computer" (the SIWA link catch-up) + Delete
  account.
- **Lapsed** — reads "Not subscribed" ("read-only" was database vocabulary
  that meant nothing to a pilot): new flights stay on this device, everything
  already synced stays safe — the courtesy is the point, not a mode to learn.
  Resubscribe sits on the same screen. Under the hood it is still pull-only,
  so a new phone can fetch the logbook.
- **Signed in, unsubscribed** — "Not subscribed" + Subscribe (the web says
  "subscribe on your iPhone" until checkout exists) + Sign out.
- **Subscribed but off** — Off + "Turn on sync". Rare by construction: the
  standing opt-in reconnects at launch, so only an explicit Turn off lands
  here.

Self-hosted config pushes the CouchDB form IN PLACE — a nav push inside the
one sheet with a back chevron, never a second modal — and must always be
discoverable from the pitch: hiding the free path is the moment honest FOSS
monetization stops being honest.

## Junctions — the only four places the rails touch

Each is deliberate; anything else touching across rails is drift.

1. **Purchase auto-connects the purchasing device.** "You paid, now go log in"
   on the same phone would be absurd. This is the one moment Subscription
   performs a login, and it performs it silently.
2. **The post-purchase page.** A page pushes the moment a purchase connects
   the device: the thank-you ("your flights now back up automatically") and
   ONE optional step, explained simply — link your Apple Account to sign in
   at wingover.app on any computer. Link, or Skip/Done pops back to the
   sheet. **Skip always visible** (account creation stays optional —
   guideline 5.1.1); skippers reach the same page later via the quiet "Use
   on your computer" row. **Supporter guard:** a purchase made while synced
   to the pilot's own server never touches that login, and no page pushes.
3. **Read-only offers the remedy in place.** The lapse is discovered on the
   connection rail; the remedy is a purchase — and it sits on the same
   screen: the read-only state renders Resubscribe directly. A lapsed pilot
   never navigates to fix it, because that pilot is the one we most want
   back.
4. **The transaction outranks the sign-in — and is a STANDING opt-in.** A
   device whose StoreKit holds a subscription logs in through it — landing on
   the account the subscription feeds — and links the Apple ID as it goes,
   healing a skipped link step. It also connects ITSELF at launch when no
   login is held (fresh install, reinstall, a connect that failed halfway):
   holding the subscription is the consent, so sync just works, the same way
   the original purchase needed no login. The one thing that outranks it is
   an explicit "Turn off sync", which persists across launches — off means
   off until the pilot says otherwise. A bare sign-in (every browser; an
   unsubscribed iPhone) lands on, or mints, the sign-in-born account: "Not
   subscribed" is a resting state, never an error. A sub pointing at a never-entitled placeholder yields to a real
   account at link time; a sub linked to a different real account is a true
   conflict. (A pilot who revokes Sign in with Apple in their Apple settings
   just severs the link — Apple's server notifications land at
   /v1/apple/siwa-events — and a later sign-in mints a fresh placeholder;
   their flights stay on the purchase-born account, reachable through it.)

## Payment anchors and identity (decided 2026-07-15; builds in the Stripe milestone)

**An account begins with either a purchase or a sign-in — and outlives both.**
Subscribe-first on iOS births one from the transaction, no login involved. A
bare sign-in births one too, with no subscription at all: logged in,
unsubscribed, prompted to subscribe is a legitimate resting state (it is the
PWA's landing flow). Once born, the account is permanent: a cancelled
subscription leaves it lapsed and read-only (STEERING: paying buys writes,
not reads); only the pilot's explicit DELETE ends it. One guard keeps the
free path abuse-proof: **no database is provisioned before the account's
first entitlement** — an unsubscribed account is a name, not storage.

**The rails are deliberately asymmetric.** Only iOS permits a subscription
before an account exists (subscribe-first, no login — the transaction births
the account). Stripe always requires a signed-in, unsubscribed account first:
web checkout is an ATTACH to that account, never a birth.

**At most one renewing subscription per account — from any rail, over time.**
A lapsed account is re-entitled by attaching a new subscription to it, from
either rail: Apple after Stripe, Stripe after Apple. A cancelled sub may
still be running out its paid period while its replacement attaches. What
never exists: two renewing subs feeding one account. No merging, no
multi-source entitlement. This invariant is checked **at every attach**, on
the server, at the moment entitlement would be granted — Stripe checkout
completion is refused for an account that already holds a renewing sub, the
same way the iOS login gate refuses (below). The gate is an attach-time
invariant, not a login feature.

**Login attaches.** On iOS, logging in while holding a floating Apple
subscription (one not attached to the target account) attaches it to that
account immediately — that IS the reattach/migration flow, run through the
ordinary door. Which is exactly why the gate exists:

**The gate: no login that would make two.** A device holding a floating,
still-renewing Apple sub may not log into an account that already has a
renewing sub. The iOS login call carries both proofs (transaction + identity
token) and the server refuses atomically: _"Cancel your Apple subscription
first."_ The check is renewal status, not expiry — cancel lifts the gate the
moment auto-renew is off — and StoreKit's refund sheet is offered right
there, the expected exit for a minutes-old accidental purchase: revocation
lifts the gate instantly, money back. Once either sub stops renewing, login
proceeds and the attach rules above take over.

Same-rail duplicates cannot arise: Apple won't sell one Apple ID the same
subscription twice, and appTransactionId derivation lands every device on
that Apple ID's one account. Everything here is strictly cross-rail; none of
it builds before web checkout exists.

Self-host is exempt throughout — "Use my own server" is not a paid-account
login, and gating the free path would break the FOSS promise. (Open check:
whether /s/ share links pin to an account's database; relevant to account
deletion, the one way an account ends.)

## Onboarding, by person

| Who, where | What happens |
| --- | --- |
| New pilot, iOS | Records flights with zero sync UI. After the **first flight saves**, a one-time nudge — "This flight lives only on this phone" — opens the Subscription pitch. Sync is **never** part of first-run onboarding. |
| New pilot subscribes | Apple's sheet → paid → device auto-connects → interstitial offers the Apple Account link → done. Zero credentials seen. |
| Subscriber, reinstall/migrated phone | Keychain survives → auto-connects. The best login flow is none; preserve it at all costs. |
| Subscriber, clean new device | Log In → Use my subscription (or Sign in with Apple, once linked). Never shown a price. |
| Lapsed subscriber | Row: `Sync — Not subscribed`. The sheet explains (new flights stay local, synced history is safe) and offers Resubscribe. Never locked out (STEERING: paying buys writes, not reads). |
| Self-hoster, any platform | Log In → Use my own server. Their rows finally tell the truth: `Subscription — · Sync — On`. The `—` is a standing, non-naggy invitation to support. |
| Supporter (subscribes while self-hosting) | Subscription activates; login untouched (junction 2 guard). |
| Subscriber wanting desktop | The post-purchase page (or "Use on your computer") links the Apple ID; Sign in with Apple at wingover.app. |
| Subscriber wanting desktop, later | PWA → Sign in with Apple. The login flow is born on the PWA; iOS only borrows its door. |
| Web subscriber _(later)_ gets an iPhone | iOS Log In → Sign in with Apple → same status screen. Their subscription is managed on the web; the iOS app never mentions web pricing. |

## Logout, exactly one verb

**Turn off sync** = forget this device's credential. Nothing is deleted, on
the device or the server, and **billing is unchanged** — the fine print says
both, and Manage Subscription sits adjacent so the pilot who came to cancel
finds the real door. When identity ships, logins mint the CouchDB credential
and step aside; there is no session to expire, so logout never becomes a
second, different verb. **Delete account** _(later)_ is the separate, explicit,
destructive act — required in-app once linking exists (guideline 5.1.1(v)).

## Copy rules

- No em dashes in user-facing copy. Periods, commas, semicolons, colons or
  parentheses instead.
- The word "PWA" never appears. Say "on your computer."
- The iOS app never states or implies web pricing (anti-steering; rules vary
  by storefront and year — silence is the one answer safe everywhere).
- "Read-only" never appears in copy — it's database vocabulary. A lapse reads
  "Not subscribed", amber, never red: the pilot's flights are all still
  there.
- Credentials are shown only behind an explicit reveal (Connect another
  device), never resting on screen.

## App Store constraints this design already satisfies

| Guideline | How |
| --- | --- |
| 3.1.1 — IAP for unlocking; restore must exist | Subscribe is IAP; "Use my subscription" + Restore Purchases are the restore |
| 3.1.3(b) — multiplatform services | Web-subscribed pilots may sign in on iOS because IAP is also offered |
| 4.8 — login services | SIWA is the only social login; trivially satisfied |
| 5.1.1 — no forced account creation | Purchase works with zero identity; linking is skippable |
| 5.1.1(v) — account deletion | In-app, on the Sync sheet, same milestone as linking |
| Paywall metadata | Price, period, terms, privacy on the pitch |
| Family Sharing | **Off, deliberately** — identity is the transaction; sharing it is undesigned. Enforced only by an App Store Connect toggle; the store code tolerates a shared originalTransactionId defensively |
| The login gate | **Our invention; no guideline blesses it.** Refusing a login until a sub stops renewing could read to a reviewer as holding access hostage. Accepted risk: the refusal must offer the refund and manage doors in the same breath, never bare — and the copy gets review-eyes before it ships (Stripe milestone) |

## Phasing

1. **Pre-TestFlight:** split the surfaces; two Settings rows; "Use my
   subscription" door; Resubscribe on read-only; Manage Subscription;
   paywall fine print.
2. ~~First hosted users: Connect another device~~ — retired unbuilt: Sign in
   with Apple shipped first and made the credential-reveal interim moot.
3. **Identity milestone (SIWA): SHIPPED** (2026-07-15) — the door on both
   platforms, the post-purchase page, the iOS self-heal, account deletion,
   portal setup, server deploy. Web checkout is the remaining piece of the
   PWA subscribe flow.
4. **Web checkout (Stripe)** — the attach machinery, all of it, found by
   adversarial review and deferred here on purpose:
   - Per-rail entitlement schema and **renewal-status ingestion** (Apple's
     `signedRenewalInfo`, Stripe's `cancel_at_period_end`). The gate has no
     data source without this; nothing today records auto-renew on either
     rail.
   - **Attach as a first-class operation**: anchor pointers and webhook
     routing move atomically with the attach, or refunds land on orphaned
     accounts.
   - A true both-proofs `/v1/session` branch (today's transaction and
     identity branches are mutually exclusive early returns).
   - The gate's UI home and terminal copy: a pilot who declines both doors
     is never locked out — they stay on the account their subscription
     feeds — and the refusal must say so. Server-state lag after a refund
     gets a "try again in a minute," not silence.

## Non-goals

- **One connection at a time.** No hosted + self-host mirror replication.
- **No token on the data path.** Identity exists solely to mint CouchDB
  credentials on new devices; after that the app speaks basic auth to a stock
  CouchDB and nothing else (STEERING). If a design requires a live session to
  sync, it is wrong.
- **The Sync sheet is not an account system.** No profiles, no avatars, no
  settings that live "in the account." Possessions sync; preferences are
  per-device.
