import { cx } from "../cx";

import styles from "./FlySplash.module.css";

/**
 * The splash backdrop: the app icon's artwork distilled to its motifs and
 * reused VERBATIM — the exact canopy, fanned flight-path curves, sun,
 * clouds and star, in the icon's own 1024 coordinate space — rendered
 * near-transparent over the scene gradient (.flySplash carries it; dusk
 * by default, day-side when the palette is light). Reusing the designer's
 * paths keeps the lines attached to the canopy exactly as the icon draws
 * them. Star/clouds are nudged toward the center so the portrait slice
 * doesn't crop them.
 *
 * Rendered by the HOSTS as the page's actual background, not by the
 * flight surface: the phone frame places it inside its fullscreen
 * IonContent (so it spans under the translucent tab bar), the desktop
 * shell behind the frameless surface. The surface's idle state is
 * transparent over it; armed and recording paint their own black and
 * cover it entirely.
 */
export default function FlySplash() {
  return (
    <svg
      slot="fixed"
      className={styles.splash}
      data-testid="fly-splash"
      viewBox="0 0 1024 1024"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      {/* The day sky radiates from the sun: a soft warm glow anchored at
          the sun's own viewBox coordinates, so it tracks the slice crop
          on every aspect ratio (a CSS radial on the element box would
          drift off the sun as the crop changes). Light scheme only —
          the module hides it at dusk. */}
      <defs>
        <radialGradient
          id="idle-sun-glow"
          cx="348"
          cy="812"
          r="740"
          gradientUnits="userSpaceOnUse"
        >
          {/* Stop colors live in the module like every other motif:
              daylight gold at noon strength, a low sunset ember at dusk. */}
          <stop className={styles.glowCore} offset="0" />
          <stop className={styles.glowMid} offset="0.28" />
          <stop className={styles.glowFringe} offset="0.55" />
          <stop className={styles.glowEnd} offset="1" />
        </radialGradient>
        {/* The sun BEHIND the wing: a heavy gaussian copy of the disc,
            masked to the canopy silhouette (the diffuse bloom light
            makes through fabric), while the sharp disc is masked to
            OUTSIDE it. Both masks draw the canopy WITH its fat 60-unit
            same-color stroke — the visible wing is path + stroke halo,
            and masking on the bare path put both boundaries 30 units
            inside the fabric's true edge (a parallel double-edge seam).
            translate(35 -40) is the canopy's cumulative group transform,
            flattened; explicit userSpace mask regions keep the blurred
            bloom from being cropped at the default 120% bbox window. */}
        <filter
          id="idle-sun-blur"
          x="-150%"
          y="-150%"
          width="400%"
          height="400%"
        >
          <feGaussianBlur stdDeviation="60" />
        </filter>
        <mask
          id="idle-canopy-window"
          maskUnits="userSpaceOnUse"
          x="0"
          y="0"
          width="1024"
          height="1024"
        >
          <path
            transform="translate(35 -40)"
            fill="#fff"
            stroke="#fff"
            strokeWidth="60"
            strokeLinejoin="round"
            strokeLinecap="round"
            d="M 60 935 A 1415 1415 0 0 1 1005 90 A 40198 40198 0 0 1 60 935 Z"
          />
        </mask>
        <mask
          id="idle-canopy-inverse"
          maskUnits="userSpaceOnUse"
          x="0"
          y="0"
          width="1024"
          height="1024"
        >
          <rect x="0" y="0" width="1024" height="1024" fill="#fff" />
          <path
            transform="translate(35 -40)"
            fill="#000"
            stroke="#000"
            strokeWidth="60"
            strokeLinejoin="round"
            strokeLinecap="round"
            d="M 60 935 A 1415 1415 0 0 1 1005 90 A 40198 40198 0 0 1 60 935 Z"
          />
        </mask>
      </defs>
      {/* The scene sits a touch low in the frame (per Alex). One wrapper
          so every userSpace mask/gradient moves with its subject. */}
      <g transform="translate(0 40)">
        <rect
          className={styles.glow}
          x="0"
          y="0"
          width="1024"
          height="1024"
          fill="url(#idle-sun-glow)"
        />
        {/* Nudged below the large-title band (per Alex). */}
        <circle className={styles.star} cx="322" cy="266" r="14" />
        <circle className={styles.star} cx="470" cy="204" r="9" />
        <rect
          className={styles.cloud}
          x="470"
          y="690"
          width="180"
          height="26"
          rx="13"
        />
        <rect
          className={styles.cloud}
          x="560"
          y="742"
          width="110"
          height="22"
          rx="11"
        />
        {/* The sharp disc exists only OUTSIDE the wing (the mask cuts the
          canopy's silhouette out of it); the bloom below fills it in. */}
        <circle
          className={styles.sun}
          cx="348"
          cy="812"
          r="135"
          mask="url(#idle-canopy-inverse)"
        />
        <g transform="translate(25 -20)">
          <g className={styles.lines} fill="none">
            <path d="M 103 927 Q 143 1014 213 1080" />
            <path d="M 185 856 Q 241 978 328 1080" />
            <path d="M 267 784 Q 335 941 435 1080" />
            <path d="M 348 713 Q 424 905 533 1080" />
            <path d="M 429 641 Q 510 868 624 1080" />
            <path d="M 510 569 Q 593 831 709 1080" />
            <path d="M 591 496 Q 823 734 1080 946" />
            <path d="M 671 424 Q 863 649 1080 849" />
            <path d="M 751 352 Q 902 557 1080 738" />
            <path d="M 832 279 Q 942 455 1080 609" />
            <path d="M 911 206 Q 981 343 1080 461" />
          </g>
          <path
            className={styles.canopy}
            transform="translate(10 -20)"
            d="M 60 935 A 1415 1415 0 0 1 1005 90 A 40198 40198 0 0 1 60 935 Z"
          />
        </g>
        {/* The bloom: the blurred sun, only within the canopy (stroke halo
          included), painted over its fabric — light diffusing through
          the wing. */}
        <g mask="url(#idle-canopy-window)">
          <circle
            className={cx(styles.sun, styles.sunVeiled)}
            cx="348"
            cy="812"
            r="135"
            filter="url(#idle-sun-blur)"
          />
        </g>
      </g>
    </svg>
  );
}
