#!/usr/bin/env python3
"""Compare two built (minified, flat) CSS bundles for semantic equivalence.
1) rule multiset equality: (context, selector, declarations) — module hashes
   normalized away so before/after hashes don't matter.
2) cascade-order check: for every pair of rules sharing a 'subject' (same
   normalized class set in the last compound) AND overlapping property names,
   their relative order must be preserved.
Usage (refactor gate):
  git stash / checkout base; pnpm build; cp dist/assets/index-*.css /tmp/before.css
  checkout head; pnpm build
  python3 scripts/css-equiv.py /tmp/before.css dist/assets/index-*.css
Multiset compares deduped (Vite re-emits @value-imported modules per importer);
sequence flags need manual adjudication: cross-specificity moves are safe,
same-specificity swaps with shared properties are not.
"""
import re, sys
from collections import defaultdict

HASH = re.compile(r"_([a-zA-Z][a-zA-Z0-9-]*?)_[a-z0-9]+_\d+")

def normalize(text):
    # replace hashed module classes with stable _name_ tokens
    return HASH.sub(lambda m: f"_{m.group(1)}_", text)

def parse(path):
    css = open(path).read()
    css = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
    rules = []  # (context, selector, decls_string)
    i, n = 0, len(css)
    ctx = []
    def flushrule(sel, body, context):
        sel = normalize(sel.strip())
        # split multi-selectors so grouping differences don't matter
        for s in [x.strip() for x in sel.split(",") if x.strip()]:
            decls = sorted(normalize(d.strip()) for d in body.split(";") if d.strip())
            rules.append((context, s, tuple(decls)))
    buf = ""
    while i < n:
        c = css[i]
        if c == "@" and re.match(r"@(media|supports|container)", css[i:]):
            j = css.index("{", i)
            ctx.append(normalize(css[i:j].strip()))
            i = j + 1
            buf = ""
            continue
        if c == "@" and re.match(r"@(keyframes|font-face|property|value)", css[i:]):
            # skip whole block (keyframes bodies compared coarsely by presence)
            j = css.index("{", i)
            depth = 1; k = j + 1
            while depth and k < n:
                if css[k] == "{": depth += 1
                elif css[k] == "}": depth -= 1
                k += 1
            rules.append((tuple(ctx), normalize(css[i:j].strip()), (normalize(css[j:k]),)))
            i = k; buf = ""
            continue
        if c == "{":
            sel = buf; buf = ""
            j = i + 1; depth = 1
            while depth and j < n:
                if css[j] == "{": depth += 1
                elif css[j] == "}": depth -= 1
                j += 1
            body = css[i+1:j-1]
            if "{" in body:
                # shouldn't happen in lowered output except @rules handled above
                pass
            flushrule(sel, body, tuple(ctx))
            i = j
            continue
        if c == "}":
            if ctx: ctx.pop()
            i += 1; buf = ""
            continue
        buf += c; i += 1
    return rules

def subject(sel):
    last = re.split(r"[\s>+~]+", sel)[-1]
    return tuple(sorted(re.findall(r"_[a-zA-Z0-9]+_|\.[a-zA-Z][\w-]*", last)))

def props(decls):
    return {d.split(":")[0].strip() for d in decls if ":" in d}

a = parse(sys.argv[1]); b = parse(sys.argv[2])
from collections import Counter
ca, cb = Counter(set(a)), Counter(set(b))  # dedupe: @value re-emission duplicates identical rules
missing = ca - cb; added = cb - ca
ok = True
if missing:
    ok = False
    print(f"❌ {sum(missing.values())} rule(s) in BEFORE missing from AFTER:")
    for r, k in list(missing.items())[:10]: print("   ", r[0], r[1], "→", "; ".join(r[2])[:100])
if added:
    ok = False
    print(f"❌ {sum(added.values())} rule(s) NEW in AFTER:")
    for r, k in list(added.items())[:10]: print("   ", r[0], r[1], "→", "; ".join(r[2])[:100])

# cascade-order: for every subject containing a MODULE class, the sequence of
# rules (selector, in order) must be identical between the two bundles.
def seqs(rules):
    from collections import defaultdict
    s = defaultdict(list)
    for ctx, sel, decls in rules:
        subj = subject(sel)
        if any(t.startswith("_") for t in subj):
            s[(ctx, subj)].append(sel)
    return s
sa, sb = seqs(a), seqs(b)
swaps = 0
for key, seq in sa.items():
    if sb.get(key, seq) != seq:
        swaps += 1
        if swaps <= 8:
            print(f"⚠️  sequence changed for subject {key[1]}:")
            print(f"    before: {seq}")
            print(f"    after : {sb.get(key)}")
if swaps: ok = False
print("EQUIVALENT ✓" if ok else f"NOT EQUIVALENT ({sum(missing.values())} missing, {sum(added.values())} added, {swaps} order swaps)")
sys.exit(0 if ok else 1)
