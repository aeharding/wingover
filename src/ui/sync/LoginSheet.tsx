import {
  IonButton,
  IonContent,
  IonHeader,
  IonIcon,
  IonNav,
  IonNavLink,
  IonSpinner,
  IonTitle,
  IonToolbar,
  useIonAlert,
} from "@ionic/react";
import { logoApple } from "ionicons/icons";
import { useState, useSyncExternalStore } from "react";

import { isTauri } from "../../engine/platform";
import * as sync from "../../sync";
import { openExternal } from "../externalLinks";
import { describe } from "./describe";
import { SelfHostPage } from "./SelfHostPage";

/**
 * Connection only (SYNC-UX.md): the doors in (Use my subscription, Use my own
 * server; Sign in with Apple later), the status once through one, and the way
 * out (Turn off sync). Never a price — the one Resubscribe affordance is a
 * sheet switch to Subscription, not a purchase.
 */
export function LoginSheet({
  onClose,
  onSubscription,
}: {
  onClose: () => void;
  onSubscription: () => void;
}) {
  return (
    // IonNav, not the app router: the own-server form gets a real push
    // animation without a route existing for a screen you reach from a modal.
    <IonNav
      root={() => (
        <LoginHome onClose={onClose} onSubscription={onSubscription} />
      )}
    />
  );
}

function LoginHome({
  onClose,
  onSubscription,
}: {
  onClose: () => void;
  onSubscription: () => void;
}) {
  const status = useSyncExternalStore(sync.subscribe, sync.currentStatus);
  const account = useSyncExternalStore(sync.subscribe, sync.currentAccount);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // One-shot receipt for the link catch-up below; linked-ness isn't in the
  // credential, so this is session state, not account state.
  const [linked, setLinked] = useState(false);
  const [presentAlert] = useIonAlert();

  const on = status.state !== "off";
  const { label, detail, tone } = describe(status);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setProblem(null);
    try {
      await action();
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      // A closed Apple sheet/popup is a non-event, not a problem to display.
      if (!/cancelled/i.test(text)) setProblem(text);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <IonHeader>
        <IonToolbar>
          {/* Static, like the Settings row that opens it: a page that renames
              itself after connecting reads as having landed somewhere else. */}
          <IonTitle>Log In</IonTitle>
        </IonToolbar>
      </IonHeader>
      <IonContent>
        <div className="sync-login-body">
          {on ? (
            <>
              <div className={`sync-state ${tone}`}>
                <span className="sync-state-label" data-testid="sync-state">
                  {label}
                </span>
                <span className="sync-state-detail">{detail}</span>
              </div>

              {status.state === "error" && (
                <p className="sync-error-message">{status.message}</p>
              )}

              {/* Signed in, never subscribed: the account is a name awaiting
                  its first entitlement (SYNC-UX.md). The remedy lives on the
                  payments rail. */}
              {status.state === "unsubscribed" && (
                <IonButton
                  expand="block"
                  onClick={onSubscription}
                  data-testid="sync-subscribe-link"
                >
                  Subscribe to start syncing
                </IonButton>
              )}

              {/* The read-only cross-link (SYNC-UX.md junction 3): the lapse is
                  discovered on this rail, the remedy lives on the other one.
                  Not for a manual login — a self-hoster's own server refusing
                  writes is not a lapsed subscription, and saying so would send
                  them shopping for a problem money can't fix. */}
              {status.state === "syncing" &&
                status.readOnly &&
                account?.kind !== "manual" && (
                  <IonButton
                    expand="block"
                    onClick={onSubscription}
                    data-testid="sync-resubscribe-link"
                  >
                    Your subscription ended. Resubscribe
                  </IonButton>
                )}

              <IonButton
                expand="block"
                fill="outline"
                color="medium"
                disabled={busy}
                onClick={() => run(() => sync.disable())}
                data-testid="sync-off"
              >
                Turn off sync
              </IonButton>
              {account?.kind === "apple" && (
                <>
                  {/* Adjacent to Turn off, so the pilot who came here to cancel
                      finds the real door — billing lives on the other rail. */}
                  <IonButton
                    fill="clear"
                    size="small"
                    className="sync-quiet-action"
                    onClick={onSubscription}
                    data-testid="sync-manage-link"
                  >
                    Manage subscription
                  </IonButton>
                  {isTauri() && (
                    // The catch-up for pilots who skipped the post-purchase
                    // link step (SYNC-UX.md junction 2). Idempotent server-side,
                    // so offering it to the already-linked is harmless.
                    <IonButton
                      fill="clear"
                      size="small"
                      className="sync-quiet-action"
                      disabled={busy || linked}
                      onClick={() =>
                        run(async () => {
                          await sync.linkAppleAccount();
                          setLinked(true);
                        })
                      }
                      data-testid="sync-link-apple"
                    >
                      {linked
                        ? "Linked. Sign in on your computer"
                        : "Link Apple Account for web access"}
                    </IonButton>
                  )}
                  {/* Distinct from Turn off sync, and it must read that way:
                      this destroys the hosted database (guideline 5.1.1(v)).
                      With a live subscription the warning changes, because
                      deletion does NOT stop billing — and a still-renewing
                      sub quietly re-creates an empty account on the next
                      launch (the transaction re-derives the same identity). */}
                  <IonButton
                    fill="clear"
                    size="small"
                    color="danger"
                    className="sync-quiet-action"
                    disabled={busy}
                    data-testid="sync-delete-account"
                    onClick={() =>
                      presentAlert({
                        header: "Delete account?",
                        message: account.entitled
                          ? "Your subscription is still active, and deleting does not stop billing. Cancel with Apple first, or your next launch will quietly re-create an empty account. Deleting removes your hosted database and every flight on it, permanently. Flights on this device stay here."
                          : "Deletes your hosted database and every flight on it, permanently. Flights on this device stay here. Any subscription is managed by Apple; cancel it in the App Store.",
                        buttons: [
                          { text: "Cancel", role: "cancel" },
                          {
                            text: "Manage Subscription",
                            handler: () => {
                              openExternal(
                                "https://apps.apple.com/account/subscriptions",
                              );
                              // Keep the alert open: cancelling out there and
                              // deleting here are both still on the table.
                              return false;
                            },
                          },
                          {
                            text: "Delete",
                            role: "destructive",
                            handler: () => {
                              void run(() => sync.deleteAccount());
                            },
                          },
                        ],
                      })
                    }
                  >
                    Delete account…
                  </IonButton>
                </>
              )}
              <p className="sync-fine-print">
                Turning sync off forgets this device&apos;s connection. Nothing
                is deleted: every flight stays on this device and on the
                server. If you subscribe, billing is unchanged.
              </p>
            </>
          ) : (
            <>
              <p className="sync-login-lede">
                Connect this device to your flights.
              </p>

              {problem && <p className="sync-error-message">{problem}</p>}

              {/* One hosted door, deliberately (a separate "Use my
                  subscription" button confused more than it helped): sign-in
                  prefers the device's StoreKit transaction internally, so a
                  subscribed iPhone lands on its account either way, and an
                  unlinked one self-heals (SYNC-UX.md junction 4). */}
              <IonButton
                expand="block"
                className="sync-siwa-button"
                disabled={busy}
                onClick={() => run(() => sync.signIn())}
                data-testid="login-apple"
              >
                {busy ? (
                  <IonSpinner name="crescent" />
                ) : (
                  <>
                    <IonIcon slot="start" icon={logoApple} aria-hidden="true" />
                    Sign in with Apple
                  </>
                )}
              </IonButton>

              {/* Deliberately quiet — blue text, not a filled button. Self-host
                  is a promise we keep, not the typical pilot's flow; the loud
                  door here is (and will be) the hosted one. */}
              <IonNavLink
                routerDirection="forward"
                component={() => (
                  <SelfHostPage backText="Log In" onConnected={onClose} />
                )}
              >
                <IonButton
                  expand="block"
                  fill="clear"
                  className="sync-selfhost-toggle"
                  data-testid="login-own-server"
                >
                  Self-hosted config
                </IonButton>
              </IonNavLink>
              <p className="sync-fine-print">
                Any CouchDB works: yours for free, or ours with a subscription.
              </p>
            </>
          )}
        </div>
      </IonContent>
    </>
  );
}
