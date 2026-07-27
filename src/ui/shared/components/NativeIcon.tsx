import { cx } from "../cx";

import styles from "./NativeIcon.module.css";

/**
 * ion-icon without Ionic. ionicons ships every glyph as an SVG data URL,
 * and a CSS mask paints it in currentColor — but the glyphs style
 * themselves through classes (.ionicon-fill-none, .ionicon-stroke-width)
 * that live in ion-icon's shadow stylesheet, so a raw data URL in a mask
 * renders outline icons as filled blobs. Inline the same rules (a mask
 * only reads alpha, so everything paints black) and URL-encode the
 * result so quoting can never shred the url() token. Exists so the
 * flight surface (src/ui/flight, Ionic-free by lint) can draw icons, and
 * shared leaves it needs (ViewToggle) can too.
 */
const MASK_CACHE = new Map<string, string>();

function maskUrl(icon: string): string {
  let url = MASK_CACHE.get(icon);
  if (!url) {
    const svg = icon
      .replace("data:image/svg+xml;utf8,", "")
      .replace(
        ">",
        "><style>.ionicon{fill:#000;stroke:#000}.ionicon-fill-none{fill:none}.ionicon-stroke-width{stroke-width:32px}</style>",
      );
    url = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
    MASK_CACHE.set(icon, url);
  }
  return url;
}

export default function NativeIcon({
  icon,
  className,
}: {
  icon: string;
  className?: string;
}) {
  return (
    <span
      className={cx(styles.nativeIcon, className)}
      style={{ WebkitMaskImage: maskUrl(icon), maskImage: maskUrl(icon) }}
      aria-hidden="true"
    />
  );
}
