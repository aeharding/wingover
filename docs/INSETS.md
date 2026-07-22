# Safe-area insets

How this app keeps content clear of the notch, Dynamic Island, home indicator,
and status bar — on the phone AND in the desktop shell, in every orientation.
Only bites where the OS reports real insets (iOS/iPadOS via Tauri); a desktop
browser reports 0 and every rule here is a no-op there.

## The one var: `--ion-safe-area-*`

Ionic defines these on `<html>` and they **inherit** everywhere:

```css
html { --ion-safe-area-top: var(--safe-area-inset-top, env(safe-area-inset-top)); … }
```

Two facts that drive everything:

1. **Ionic components already inset off it, unconditionally.** `ion-item`'s shadow
   CSS does `padding-left: calc(--padding-start + --ion-safe-area-left)` and
   `.item-inner padding-right: calc(--ion-safe-area-right + --inner-padding-end)`.
   Same for toolbar, header, footer, tab-bar, card, list-header, menu, modal,
   action-sheet, item-options. So an `ion-item` clears the notch **wherever it
   is** — correct at a true device edge, **phantom anywhere inboard**.
2. **`env()` cannot be overridden or made position-aware.** `--ion-safe-area-*`
   can. So the whole app reads `var(--ion-safe-area-*)` (never `env()` directly,
   outside the FlyPage which is deliberately Ionic-free and always full-screen),
   and MapCanvas bridges the resolved value to MapKit via a hidden probe +
   `style-observer`.

### Consuming

Chrome that sits between a device edge and its content **re-declares the var to
0** for its subtree — so a descendant insets only from edges still exposed at its
position. Utilities in `theme.css`: `.consume-top/right/bottom/left`,
`.consume-all`. Consume the **derived** `--ion-safe-area-*` (not the upstream
`--safe-area-inset-*`): only the derived var reaches Ionic's shadow padding.

### Positioning off an edge you also consume

An element can't both read `--ion-safe-area-x` for its own position AND set it to
0 for its children (same var, same element). When it must do both (the floating
seat card), position off the **raw** `var(--safe-area-inset-x, env(...))` —
decoupled from the consumed derived var — and consume `--ion-safe-area-*: 0` for
the contents.

## Chrome ownership (measured, not guessed)

**Desktop shell** (`DesktopShell`, ≥992px, no `ion-tabs`):

- The **rail** owns the LEFT edge for the whole shell → `.desktop-main` consumes
  left; the rail itself pads its content off left/top/bottom and its width grows
  by the left inset.
- Only the **maps** (seat, plan, all-flights — each fills to the device right
  edge) and the **scrub** reach the device RIGHT/BOTTOM edges; they keep those.
- **Inboard Ionic content** — the logbook pane's `FlightList`, the floating seat
  card, the centered 640px settings column — must consume RIGHT (their items
  would otherwise pad off a notch they've stepped away from).
- Panes/cards with no header of their own pad their own top/bottom.
- **Full screen** (`body.flight-map-full` hides the rail) re-exposes the LEFT
  edge to the whole seat, so `body.flight-map-full .flight-seat` restores it for
  the map AND its sibling scrub together — restoring only the map would leave the
  dock's leftmost readout under the notch.

**Mobile tab shell** (`IonTabs`, `<992px`):

- The translucent **tab bar** sits below the content and owns the BOTTOM. Map
  pages there consume bottom: `ion-tabs .plan-map`, `ion-tabs .all-flights-map`.
  (Lists handle it via Ionic; only our custom map overlays double-count.)
- A page's **header** owns the TOP: all-flights (opaque 55px header, map at y=55)
  consumes top; plan has NO header (map at y=0) so its top is a real device edge.
- Everything else is AT the device edges, so insets pass through (correct).

**Overlays** portal to `<body>`, outside every consume context:

- **Popover** floats; Ionic keeps it on-screen. The rail-sync menu is pinned to
  the chip's bottom with `bottom: calc(10px + var(--ion-safe-area-bottom))` so it
  clears the home indicator (the rail padding lifted the chip up).
- **Action sheet / bottom-sheet modal** DO sit on the device edge → inset (Ionic
  handles it; leave them).

## Verified matrix (`e2e/inset-probe.mjs`, injected T=11 R=22 B=33 L=44)

`22` on a right edge = correct · `44` on a right = a left leak · `0` = consumed.

### Desktop

| Surface                      | T           | R            | B                           | L      |
| ---------------------------- | ----------- | ------------ | --------------------------- | ------ |
| rail (pad; width=76+L)       | 10+11       | 0 int        | 33                          | 44     |
| pane header / list           | 9.6+11      | (0)          | 33                          | 0      |
| pane row `ion-item`          | —           | 0 (consumed) | —                           | 0      |
| seat map probe               | 11          | 22           | 33 (0 when scrub open)      | 0      |
| seat overlay                 | —           | —            | 41.6+33 (+0 scrub open)     | 14.4+0 |
| seat card position / items   | 14.4+11 / 0 | 14.4+22 / 0  | —                           | — / 0  |
| scrub dock                   | 1.1rem      | +22          | 0.5rem+33                   | +0     |
| settings item (centered col) | —           | 0 (consumed) | —                           | 0      |
| plan map probe / overlay     | 11          | 22           | 33                          | 0      |
| plan pane (top/bottom)       | 11          | 0 int        | 33                          | 0      |
| all-flights probe            | 0 (header)  | 22           | 33 (device)                 | 0      |
| popover bottom               | —           | —            | tethered to chip, clears HI | —      |

### Mobile

| Surface                          | T           | R       | B                 | L         |
| -------------------------------- | ----------- | ------- | ----------------- | --------- |
| headers / list items (all pages) | 11          | 22      | —                 | 16+44     |
| detail inline preview            | 0           | 0       | 0                 | 0 (boxed) |
| detail fullscreen probe/overlay  | 11          | 22      | 33 (0 scrub open) | 44        |
| plan probe                       | 11 (device) | 22      | 0 (tab bar)       | 44        |
| plan overlay                     | —           | 14.4+22 | 14.4+0            | —         |
| all-flights probe                | 0 (header)  | 22      | 0 (tab bar)       | 44        |
| all-flights legend               | —           | —       | 3.2rem+0          | 14.4+44   |

## Re-verifying

`e2e/inset-probe.mjs` is a standalone Playwright harness (not a spec; Playwright
won't run it). With the dev server up:

```
node e2e/inset-probe.mjs all        # every scenario
node e2e/inset-probe.mjs d-logbook  # one
```

It injects distinct per-edge `--safe-area-inset-*` values and prints each
surface's resolved padding/position + the shadow `.item-inner`/`.item-native`
padding for `ion-item`s. env() is 0 in headless Chromium, so injecting the
**upstream** var (which Ionic's `--ion-safe-area-*` derives from) is how the
device is simulated.
