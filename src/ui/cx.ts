type Falsey = undefined | null | "" | false;

// Voyager's class composer (aeharding/voyager src/helpers/css.ts, itself from
// https://github.com/jalalazimi/classwind): join class names, skipping falsey
// — so conditional and tone-map classes compose without template soup, and an
// empty tone ("" for neutral) never leaves a stray space.
export function cx(...args: (string | Falsey)[]) {
  let result = "";
  const len = args.length;

  for (let i = 0; i < len; i++) {
    const className = args[i];

    if (!className) continue;

    result = (result && result + " ") + className;
  }

  return result;
}
