import sys, os, collections, json
LDRAW = "/agent/repos/lug-layout/.cache/ldraw"
OMR = "/agent/repos/lug-layout/.cache/omr"

def norm(name):
    return name.strip().replace("\\", "/").lower()

def is_library_part(name):
    n = norm(name)
    return os.path.exists(os.path.join(LDRAW, "parts", n)) and not n.startswith("s/")

def sections(path):
    files, current, order = {}, None, []
    inline_parts = {}
    for raw in open(path, encoding="utf-8", errors="replace"):
        line = raw.rstrip("\n")
        parts = line.split()
        if len(parts) >= 3 and parts[0] == "0" and parts[1] == "FILE":
            current = norm(line.split(None, 2)[2])
            files[current] = []
            order.append(current)
            continue
        if current is not None:
            files[current].append(line)
            if len(parts) >= 3 and parts[0] == "0" and parts[1] == "!LDRAW_ORG" and ("Part" in parts[2] or "Shortcut" in parts[2]):
                inline_parts[current] = current.split(" - ")[-1]
    return files, order, inline_parts

def count(set_name):
    files, order, inline_parts = sections(os.path.join(OMR, f"{set_name}.mpd"))
    counts = collections.Counter()
    def walk(name, color):
        for line in files[name]:
            p = line.split()
            if len(p) < 15 or p[0] != "1":
                continue
            c = int(p[1])
            c = color if c == 16 else c
            ref = norm(" ".join(p[14:]))
            if ref in inline_parts:
                counts[(f"ldraw:{inline_parts[ref][:-4]}", c)] += 1
            elif is_library_part(ref):
                counts[(f"ldraw:{ref[:-4]}", c)] += 1
            elif ref in files:
                walk(ref, c)
            else:
                raise SystemExit(f"{set_name}: unresolved {ref}")
    walk(order[0], 16)
    return counts

total = collections.Counter()
for name in sys.argv[1:]:
    c = count(name)
    print(name, sum(c.values()), len(c))
    total.update(c)
json.dump({f"{p} {c}": q for (p, c), q in sorted(total.items())}, open("/tmp/pw/flatten-out.json", "w"), indent=0)
print("total", sum(total.values()), "lines", len(total))
