import json, glob, collections, sys
sys.argv = ["flatten.py"]
exec(open("/tmp/pw/flatten.py").read().split("total = collections.Counter()")[0])
B = "/agent/repos/lug-layout/tools/asset-pipeline/dist/bundle/standard/"
m = json.load(open(B + "manifest.json"))
cw = json.load(open(B + m["crosswalk"]["file"]))
parts, colors = cw["parts"], cw["colors"]
def expand(part, color, depth=0):
    e = parts.get(part)
    comps = (e or {}).get("components") or []
    if not comps or depth >= 8:
        return [(part, color)]
    out = []
    for c in comps:
        out += expand(c["part"], color if c["color"] == 16 else c["color"], depth + 1)
    return out
sets = ["7936-1","10264-1","10185-1","10190-1","10218-1","2150-1","4554-1","4555-1","10128-1","10133-1"]
result = {}
for s in sets:
    c = count(s)
    resolved = collections.Counter()
    for (p, col), q in c.items():
        for rp in expand(p, col):
            resolved[rp] += q
    un = {}
    for system in ("rebrickable", "bricklink"):
        bad = {k: q for k, q in resolved.items()
               if not (parts.get(k[0]) or {}).get(system) or (colors.get(str(k[1])) or {}).get(system) is None}
        un[system] = (len(bad), sum(bad.values()), sorted(f"{p.replace('ldraw:','')}/{col}" for p, col in bad)[:12])
    result[s] = {"instances": sum(c.values()), "resolvedParts": sum(resolved.values()), "lines": len(resolved), "unmapped": un}
    print(s, sum(c.values()), "->", sum(resolved.values()), "parts", len(resolved), "lines | RB unmapped lines/parts", un["rebrickable"][:2], "| BL", un["bricklink"][:2], un["bricklink"][2][:8])
json.dump(result, open("/tmp/pw/status-offline.json", "w"), indent=1)
