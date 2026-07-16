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

Neither surface may absorb the other's verbs. The Subscription dialog never
shows a credential form, a status readout, or a logout. The Log In page never
shows a price.

## Settings: exactly two rows

```
Logged out:                          Logged in:
┌───────────────────────────────┐    ┌───────────────────────────────┐
│ Subscription              —  ›│    │ Subscription         Active  ›│
│ Log In                       ›│    │ Sync                     On  ›│
└───────────────────────────────┘    └───────────────────────────────┘
```

- **Subscription** — note reads `—` / `Active` / `Expired`. Opens the
  Subscription dialog. Present on **all platforms**. On the PWA the pitch
  itself leads with identity: **Sign in with Apple sits directly on the
  landing page** (with the self-host link beneath). Sign in holding a valid
  subscription and the sheet lands on the status view — done, the common
  case, one tap. Signed in without one, the pilot is prompted to subscribe
  (web checkout when it exists; until then the prompt points at the iOS app).
  A web purchase never happens before an account exists to attach it to.
- **Log In** — the row **transforms**, like iOS Settings' Apple ID row: it
  reads "Log In" while disconnected, and once connected becomes **Sync** with
  the status as its note (`On` / `Read-only` / `Paused` / `Problem`). Both
  states open the same page.

No third row, ever. Sync earns two lines of Settings and no more (STEERING:
the app is whole without it).

## The Subscription dialog (payments only)

Pitch (hero photo, the three reasons), Apple's localized price on the
Subscribe button, Restore Purchases, Manage Subscription (Apple's sheet —
cancellation lives with Apple and we say so), and the required fine print
(price, period, terms of use, privacy policy).

One quiet cross-link is allowed: "Self-host config", and it pushes the
own-server form IN PLACE — a nav push inside this sheet with a back chevron to
the pitch, never a close-and-reopen of another modal. The form remains the
Log In rail's page; this is a shortcut to it, not a second copy. Self-host
must always be discoverable from the pitch — hiding the free path is the
moment honest FOSS monetization stops being honest.

## The Log In page (connection only)

**Logged out — the doors, in order:**

1. **Sign in with Apple** — hosted subscribers, any platform; on iOS an
   unlinked sign-in self-heals through StoreKit (junction 4).
2. **Use my subscription** _(iOS only)_ — entitlement probe via StoreKit; one
   tap, no credentials. This is how "turned sync off, wants back in" and
   "new phone" reconnect without touching the payments surface. It also
   satisfies App Review's restore expectation.
3. **Use my own server** — the CouchDB form. Works today, everywhere, free.

**Logged in:** status headline and detail, **Turn off sync**, and — depending
on state — **Link Apple Account** (connected via subscription but not yet
linked), **Connect another device** (interim; see below), **Delete account**
_(later, once identity exists)_, and the read-only cross-link (below).

## Junctions — the only four places the rails touch

Each is deliberate; anything else touching across rails is drift.

1. **Purchase auto-connects the purchasing device.** "You paid, now go log in"
   on the same phone would be absurd. This is the one moment Subscription
   performs a login, and it performs it silently.
2. **The post-purchase interstitial.** Immediately after purchase: _"Want your
   flights on your computer? Link your Apple Account — one tap."_ Native SIWA,
   Face ID, **Skip always visible** (account creation must stay optional —
   guideline 5.1.1). Skippers can link any time from the Log In page.
   **Supporter guard:** if the pilot is already logged in to their own server,
   the interstitial must not clobber that — "You're synced to your own server —
   keep it (default), or switch to hosted?"
3. **Read-only cross-links to Subscription.** The lapse is discovered on the
   Log In rail; the remedy lives on the other rail. The read-only status
   screen carries exactly one deep link: "Your subscription ended —
   Resubscribe." Without it the separation strands the person we most want
   back.
4. **The transaction outranks the sign-in.** A device whose StoreKit holds a
   subscription logs in through it — landing on the account the subscription
   feeds — and links the Apple ID as it goes, healing a skipped link step. A
   bare sign-in (every browser; an unsubscribed iPhone) lands on, or mints,
   the sign-in-born account: "Not subscribed" is a resting state, never an
   error. A sub pointing at a never-entitled placeholder yields to a real
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

## Interim device linking (until Sign in with Apple ships)

**Connect another device** on the iOS Log In page reveals the CouchDB
server/database/username/password with copy buttons; the pilot pastes them
into the PWA's own-server form. It is the self-host path wearing a different
hat — zero new sync code, honest about what it is, and removed the release
SIWA ships. Known limit: the linked device holds a `manual`-kind credential,
so a server-side password rotation strands it; the stale-credential error on
such a device should say "re-link from your iPhone," not fail generically.

## Onboarding, by person

| Who, where | What happens |
| --- | --- |
| New pilot, iOS | Records flights with zero sync UI. After the **first flight saves**, a one-time nudge — "This flight lives only on this phone" — opens the Subscription pitch. Sync is **never** part of first-run onboarding. |
| New pilot subscribes | Apple's sheet → paid → device auto-connects → interstitial offers the Apple Account link → done. Zero credentials seen. |
| Subscriber, reinstall/migrated phone | Keychain survives → auto-connects. The best login flow is none; preserve it at all costs. |
| Subscriber, clean new device | Log In → Use my subscription (or Sign in with Apple, once linked). Never shown a price. |
| Lapsed subscriber | Row: `Subscription — Expired · Sync — Read-only`. Status screen explains, offers Resubscribe. Never locked out (STEERING: paying buys writes, not reads). |
| Self-hoster, any platform | Log In → Use my own server. Their rows finally tell the truth: `Subscription — · Sync — On`. The `—` is a standing, non-naggy invitation to support. |
| Supporter (subscribes while self-hosting) | Subscription activates; login untouched (junction 2 guard). |
| Subscriber wanting desktop, today | iOS Log In → Connect another device → paste into PWA form. |
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

- The word "PWA" never appears. Say "on your computer."
- The iOS app never states or implies web pricing (anti-steering; rules vary
  by storefront and year — silence is the one answer safe everywhere).
- Read-only is never styled as an error. Amber, not red; the pilot's flights
  are all still there.
- Credentials are shown only behind an explicit reveal (Connect another
  device), never resting on screen.

## App Store constraints this design already satisfies

| Guideline | How |
| --- | --- |
| 3.1.1 — IAP for unlocking; restore must exist | Subscribe is IAP; "Use my subscription" + Restore Purchases are the restore |
| 3.1.3(b) — multiplatform services | Web-subscribed pilots may sign in on iOS because IAP is also offered |
| 4.8 — login services | SIWA is the only social login; trivially satisfied |
| 5.1.1 — no forced account creation | Purchase works with zero identity; linking is skippable |
| 5.1.1(v) — account deletion | In-app, on the Log In page, same milestone as linking |
| Paywall metadata | Price, period, terms, privacy on the Subscription dialog |
| Family Sharing | **Off, deliberately** — identity is the transaction; sharing it is undesigned. Enforced only by an App Store Connect toggle; the store code tolerates a shared originalTransactionId defensively |
| The login gate | **Our invention; no guideline blesses it.** Refusing a login until a sub stops renewing could read to a reviewer as holding access hostage. Accepted risk: the refusal must offer the refund and manage doors in the same breath, never bare — and the copy gets review-eyes before it ships (Stripe milestone) |

## Phasing

1. **Pre-TestFlight:** split the surfaces; two Settings rows; "Use my
   subscription" door; Resubscribe on read-only; Manage Subscription;
   paywall fine print.
2. **First hosted users:** Connect another device; PWA Subscription-row
   explainer copy.
3. **Identity milestone (SIWA):** the client side is built — the door on both
   platforms, the post-purchase interstitial, the iOS self-heal, account
   deletion. It lights up with the Apple portal setup (App ID capability,
   Services ID + verified domain, server `clientIds`) and a server deploy;
   web checkout is the remaining piece of the PWA subscribe flow. Then remove
   Connect another device.
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
- **The Log In page is not an account system.** No profiles, no avatars, no
  settings that live "in the account." Possessions sync; preferences are
  per-device.
