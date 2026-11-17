import json, sys, tarfile
from collections import Counter

bundle, archive, sets, crosswalk_paths = sys.argv[1], sys.argv[2], sys.argv[3].split(","), sys.argv[4:]
manifest = json.load(open(f"{bundle}/manifest.json"))
counts = Counter()
for entry in manifest["models"]:
    name = entry.get("name")
    if name not in sets:
        continue
    model = json.load(open(f"{bundle}/{entry['file']}"))
    for part, color in zip(model["instances"]["part"], model["instances"]["color"]):
        counts[(model["parts"][part], color)] += 1
found = {e.get("name") for e in manifest["models"]} & set(sets)
assert found == set(sets), found

keywords = {}
with tarfile.open(archive) as tar:
    for member in tar:
        segments = member.name.split("/")
        if len(segments) < 2 or segments[-2] != "parts" or not member.isfile():
            continue
        ids = []
        for line in tar.extractfile(member).read().decode("utf8", "replace").splitlines()[:40]:
            if line.startswith("0 !KEYWORDS"):
                ids += [t.strip() for t in line[11:].split(",") if t.strip().lower().startswith(("rebrickable ", "bricklink "))]
        keywords["ldraw:" + segments[-1][:-4].lower()] = ids

def leaves(crosswalk, part, color, quantity, out, depth=0):
    entry = crosswalk["parts"].get(part, {})
    components = entry.get("components") or []
    if not components or depth >= 8:
        out[(part, color)] += quantity
        return
    for c in components:
        leaves(crosswalk, c["part"], color if c["color"] == 16 else c["color"], quantity, out, depth + 1)

def unmapped(crosswalk):
    out = Counter()
    for (part, color), q in counts.items():
        leaves(crosswalk, part, color, q, out)
    result = {}
    for (part, color), q in out.items():
        entry = crosswalk["parts"].get(part, {})
        rb_color = crosswalk["colors"].get(str(color), {}).get("rebrickable")
        if not entry.get("rebrickable") or rb_color is None:
            result[(part, color)] = q
    return result

crosswalks = {p.split("crosswalk-")[1].removesuffix(".json"): json.load(open(p)) for p in crosswalk_paths}
labels = list(crosswalks)
current = crosswalks[labels[-1]]
per = {label: unmapped(cw) for label, cw in crosswalks.items()}
summary = {label: {"lines": len(u), "parts": sum(u.values())} for label, u in per.items()}

def reason(part, color):
    entry = current["parts"].get(part)
    if current["colors"].get(str(color), {}).get("rebrickable") is None:
        return "colour has no Rebrickable id"
    if entry is None:
        return "no exact source"
    if entry.get("rejectedAssemblyIds"):
        return "N6 assembly id rejected"
    if entry.get("rebrickableAlternatives"):
        return "R1 several candidates, no keyword"
    return "no exact source"

rows = []
for (part, color), q in sorted(per[labels[-1]].items()):
    row = {"part": part, "color": color, "quantity": q, "reason": reason(part, color),
           "currentEntry": current["parts"].get(part), "keywords": keywords.get(part, [])}
    for label in labels[:-1]:
        e = crosswalks[label]["parts"].get(part)
        row[label] = None if e is None else {"rebrickable": e.get("rebrickable"), "via": e["via"].get("rebrickable"), "alternatives": e.get("rebrickableAlternatives")}
    rows.append(row)
print(json.dumps({"sets": sets, "summary": summary, "reasons": Counter(r["reason"] for r in rows), "reasonParts": Counter({k: sum(r["quantity"] for r in rows if r["reason"] == k) for k in {r["reason"] for r in rows}}), "rows": rows}, indent=1, default=str))
