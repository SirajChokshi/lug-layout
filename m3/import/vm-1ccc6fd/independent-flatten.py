import sys, re, json
def sections(text):
    names, bodies = [], []
    for line in text.splitlines():
        t = line.split()
        if len(t) >= 3 and t[0] == '0' and t[1].upper() == 'FILE':
            names.append(' '.join(t[2:]).replace('\\', '/').lower()); bodies.append([]); continue
        if not bodies: names.append(''); bodies.append([])
        bodies[-1].append(line)
    return names, bodies
def is_part(body):
    for line in body:
        t = line.split()
        if len(t) >= 3 and t[0] == '0' and t[1] == '!LDRAW_ORG':
            return t[2].lower() != 'model'
    return False
def count(text):
    names, bodies = sections(text)
    idx = {n: i for i, n in enumerate(names)}
    total = 0
    def walk(i, depth):
        nonlocal total
        for line in bodies[i]:
            t = line.split()
            if len(t) < 15 or t[0] != '1': continue
            ref = ' '.join(t[14:]).replace('\\', '/').lower()
            j = idx.get(ref)
            if j is None or is_part(bodies[j]): total += 1
            else: walk(j, depth + 1)
    walk(0, 0)
    return total
for f in sys.argv[1:]:
    print(f.split('/')[-1], count(open(f, encoding='utf-8', errors='replace').read()))
