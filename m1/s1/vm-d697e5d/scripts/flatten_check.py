import json,re,sys
sys.path.insert(0,'/tmp/omr')
from qualify import PREFIX
BUNDLE='/agent/repos/lug-layout/tools/asset-pipeline/dist/bundle/standard'
def norm(r): return r.strip().lower().replace('\\','/')
def official(n):
  m=PREFIX.match(n); return norm((m.group(1) or '')+m.group(2)) if m else n
def mul(a,b):
  out=[0.0]*12
  for r in range(3):
    for c in range(4):
      v=sum(a[r*4+k]*b[k*4+c] for k in range(3))
      if c==3: v+=a[r*4+3]
      out[r*4+c]=v
  return out
def ldraw(tk):
  x,y,z,a,b,c,d,e,f,g,h,i=map(float,tk); return [a,b,c,x,d,e,f,y,g,h,i,z]
Y=[1,0,0,0, 0,-1,0,0, 0,0,-1,0]
I=[1,0,0,0, 0,1,0,0, 0,0,1,0]
def flatten(path):
  secs={};order=[];cur=None
  for line in open(path,encoding='utf-8',errors='replace').read().splitlines():
    tk=line.split()
    if len(tk)>=3 and tk[0]=='0' and tk[1].upper()=='FILE':
      cur=norm(' '.join(tk[2:])); secs.setdefault(cur,{'org':'','refs':[]}); order.append(cur); continue
    if cur is None: cur='';secs[cur]={'org':'','refs':[]};order.append(cur)
    if len(tk)>=2 and tk[0]=='0' and tk[1]=='!LDRAW_ORG': secs[cur]['org']=' '.join(tk[2:])
    if tk and tk[0]=='1' and len(tk)>=15: secs[cur]['refs'].append((int(tk[1],0), ldraw(tk[2:14]), norm(' '.join(tk[14:]))))
  ispart=lambda s: secs[s]['org']!='' and secs[s]['org'].split()[0].lower()!='model'
  out=[]
  def walk(s,color,m):
    for c,lm,r in secs[s]['refs']:
      cc=color if c==16 else c; cm=mul(m,lm)
      if r in secs and not ispart(r): walk(r,cc,cm)
      else: out.append((official(r) if r in secs else r, cc, mul(mul(Y,cm),Y)))
  walk(order[0],16,I)
  return out
if __name__=='__main__':
  man=json.load(open(f'{BUNDLE}/manifest.json'))
  ids=[p['id'].removeprefix('ldraw:') for p in man['parts']]
  files={e['name']:e['file'] for e in man['models']}
  print("| Set | Instances (independent / baked) | Same part, colour and order | Max abs translation difference (LDU) | Max abs rotation-entry difference |")
  for s in sys.argv[1:]:
    mine=flatten(f'/tmp/omr/{s}.mpd')
    m=json.load(open(f'{BUNDLE}/{files[s]}'))
    P,C,M=m['instances']['part'],m['instances']['color'],m['instances']['matrix']
    same=len(mine)==len(P) and all(ids[P[i]]==r.removesuffix('.dat').replace('/','-') and C[i]==c for i,(r,c,_) in enumerate(mine))
    dt=dr=0.0
    for i,(_,_,mm) in enumerate(mine):
      for k in range(12):
        d=abs(mm[k]-M[i*12+k])
        if k in (3,7,11): dt=max(dt,d)
        else: dr=max(dr,d)
    print(f"| {s} | {len(mine):,} / {len(P):,} | {'yes' if same else 'NO'} | {dt:.2e} | {dr:.2e} |")
