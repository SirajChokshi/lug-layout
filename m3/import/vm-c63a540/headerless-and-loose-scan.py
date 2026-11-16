import sys
def sections(text):
    names, bodies = [], []
    for line in text.splitlines():
        t = line.split()
        if len(t) >= 3 and t[0] == '0' and t[1].upper() == 'FILE':
            names.append(' '.join(t[2:]).replace('\\','/').lower()); bodies.append([]); continue
        if not bodies: names.append(''); bodies.append([])
        bodies[-1].append(line)
    return names, bodies
def org(body):
    for l in body:
        t=l.split()
        if len(t)>=3 and t[0]=='0' and t[1]=='!LDRAW_ORG': return t[2].lower()
    return None
def geo(body): return sum(1 for l in body if l.split()[:1] in (['3'],['4']))
for f in sys.argv[1:]:
    names,bodies=sections(open(f,encoding='utf-8',errors='replace').read())
    idx={n:i for i,n in enumerate(names)}
    def ispart(i):
        o=org(bodies[i])
        if o is not None: return o.replace('unofficial_','')!='model'
        return names[i].endswith('.dat') or geo(bodies[i])>0
    reached=set(); hits=[]
    def walk(i,d):
        reached.add(i)
        if geo(bodies[i]): hits.append(('loose',names[i],geo(bodies[i])))
        for l in bodies[i]:
            t=l.split()
            if len(t)<15 or t[0]!='1': continue
            r=' '.join(t[14:]).replace('\\','/').lower()
            j=idx.get(r)
            if j is None: continue
            if ispart(j):
                if org(bodies[j]) is None: hits.append(('headerless-part',names[j],geo(bodies[j])))
            else: walk(j,d+1)
    walk(0,0)
    print(f.split('/')[-1], sorted(set(hits)))
