import json,re,sys
sys.path.insert(0,'/tmp/omr')
from qualify import PREFIX
def norm(r): return r.strip().lower().replace('\\','/')
def official(n):
  m=PREFIX.match(n); return norm((m.group(1) or '')+m.group(2)) if m else n
def flatten(path):
  secs={};order=[];cur=None
  for line in open(path,encoding='utf-8',errors='replace').read().splitlines():
    tk=line.split()
    if len(tk)>=3 and tk[0]=='0' and tk[1].upper()=='FILE':
      cur=norm(' '.join(tk[2:])); secs.setdefault(cur,{'org':'','refs':[]}); order.append(cur); continue
    if cur is None: cur='';secs[cur]={'org':'','refs':[]};order.append(cur)
    if len(tk)>=2 and tk[0]=='0' and tk[1]=='!LDRAW_ORG': secs[cur]['org']=' '.join(tk[2:])
    if tk and tk[0]=='1' and len(tk)>=15: secs[cur]['refs'].append((int(tk[1],0), norm(' '.join(tk[14:]))))
  ispart=lambda s: secs[s]['org']!='' and secs[s]['org'].split()[0].lower()!='model'
  out=[]
  def walk(s,color,depth):
    for c,r in secs[s]['refs']:
      cc=color if c==16 else c
      if r in secs and not ispart(r): walk(r,cc,depth+1)
      elif r in secs: out.append((official(r),cc))
      else: out.append((r,cc))
  walk(order[0],16,0)
  return out
for s in sys.argv[1:]:
  out=flatten(f'/tmp/omr/{s}.mpd')
  m=json.load(open(f'/agent/repos/lug-layout/tools/asset-pipeline/dist/bundle/standard/model-{s}.json'))
  man=json.load(open('/agent/repos/lug-layout/tools/asset-pipeline/dist/bundle/standard/manifest.json'))
  ids=[p['id'].removeprefix('ldraw:') for p in man['parts']]
  baked=[(ids[p],c) for p,c in zip(m['instances']['part'],m['instances']['color'])]
  mine=sorted((r.removesuffix('.dat').replace('/','-'),c) for r,c in out)
  print(s, len(out), len(set(r for r,_ in out)), len(set(out)), 'baked',len(baked), 'multiset equal' if sorted(baked)==mine else 'DIFFERENT')
