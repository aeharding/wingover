/**
 * The splash backdrop: the app icon's artwork distilled to its motifs and
 * reused VERBATIM — the exact canopy, fanned flight-path curves, sun,
 * clouds and star, in the icon's own 1024 coordinate space — rendered
 * near-transparent over the scene gradient (.fly-splash carries it; dusk
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
      className="fly-splash"
      viewBox="0 0 1024 1024"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      <circle className="idle-star" cx="322" cy="150" r="14" />
      <circle className="idle-star" cx="470" cy="86" r="9" />
      <rect
        className="idle-cloud"
        x="470"
        y="690"
        width="180"
        height="26"
        rx="13"
      />
      <rect
        className="idle-cloud"
        x="560"
        y="742"
        width="110"
        height="22"
        rx="11"
      />
      <circle className="idle-sun" cx="348" cy="812" r="135" />
      <g transform="translate(25 -20)">
        <g className="idle-lines" fill="none">
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
          className="idle-canopy"
          transform="translate(10 -20)"
          d="M 60 935 A 1415 1415 0 0 1 1005 90 A 40198 40198 0 0 1 60 935 Z"
        />
      </g>
    </svg>
  );
}
