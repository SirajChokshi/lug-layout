import os,re,sys,json,urllib.request,math
sys.path.insert(0,'/tmp/omr')
from qualify import analyze
PIN='https://raw.githubusercontent.com/kulits/ldraw-parts/c70360d1c588be894997b2168c61909bc8058c4d/ldraw/'
CACHE='/tmp/geo/pin'; LOCAL='/agent/repos/lug-layout/.cache/ldraw/'
def norm(r): return r.strip().lower().replace('\\','/')
def pin_file(path):
  for base in (LOCAL,):
    p=base+path
    if os.path.exists(p): return open(p,encoding='utf-8',errors='replace').read()
  c=os.path.join(CACHE,path.replace('/','__'))
  if os.path.exists(c): return open(c).read() if os.path.getsize(c) else None
  os.makedirs(CACHE,exist_ok=True)
  try: t=urllib.request.urlopen(PIN+path).read().decode('utf-8','replace')
  except Exception: t=''
  open(c,'w').write(t); return t or None
def sections(path):
  secs={};cur=None
  for line in open(path,encoding='utf-8',errors='replace').read().splitlines():
    tk=line.split()
    if len(tk)>=3 and tk[0]=='0' and tk[1].upper()=='FILE': cur=norm(' '.join(tk[2:])); secs[cur]=[]; continue
    if cur is not None: secs[cur].append(line)
  return secs
def mul(a,b):
  return [sum(a[i*4+k]*b[k*4+j] for k in range(4)) for i in range(4) for j in range(4)]
def mat(tk):
  x,y,z,a,b,c,d,e,f,g,h,i=map(float,tk)
  return [a,b,c,x,d,e,f,y,g,h,i,z,0,0,0,1]
def ap(m,p): return tuple(m[r*4]*p[0]+m[r*4+1]*p[1]+m[r*4+2]*p[2]+m[r*4+3] for r in range(3))
I=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]
def flatten(lines, m, mpd, depth=0, pts=None):
  if pts is None: pts=[]
  for line in lines:
    tk=line.split()
    if not tk: continue
    if tk[0]=='1' and len(tk)>=15:
      ref=norm(' '.join(tk[14:]))
      child=mpd.get(ref)
      if child is None:
        for cand in ('parts/'+ref,'p/'+ref):
          t=pin_file(cand)
          if t: child=t.splitlines(); break
      if child is None: raise Exception('unresolved '+ref)
      flatten(child, mul(m,mat(tk[2:14])), mpd, depth+1, pts)
    elif tk[0] in ('3','4'):
      n=int(tk[0]); vals=list(map(float,tk[2:2+3*n]))
      for k in range(n): pts.append(ap(m,vals[k*3:k*3+3]))
  return pts
def bbox(p): return [min(q[i] for q in p) for i in range(3)],[max(q[i] for q in p) for i in range(3)]
def hausdorff(a,b):
  def one(x,y):
    worst=0
    for p in x:
      best=min((p[0]-q[0])**2+(p[1]-q[1])**2+(p[2]-q[2])**2 for q in y); worst=max(worst,best)
    return math.sqrt(worst)
  return max(one(a,b),one(b,a))
rows=[]
for s in sys.argv[1:]:
  a=analyze(s); mpd=sections(f'/tmp/omr/{s}.mpd')
  for inl,off in sorted(a['superseded'].items()):
    pi=sorted(set(flatten(mpd[inl],I,mpd)))
    po=sorted(set(flatten(pin_file('parts/'+off).splitlines(),I,{})))
    (imn,imx),(omn,omx)=bbox(pi),bbox(po)
    t=tuple(round(((imn[k]+imx[k])-(omn[k]+omx[k]))/2,4) for k in range(3))
    d0=hausdorff(pi,po)
    shifted=[(p[0]+t[0],p[1]+t[1],p[2]+t[2]) for p in po]
    dt=hausdorff(pi,shifted) if any(abs(x)>1e-9 for x in t) else d0
    rows.append(dict(set=s,inline=inl,official=off,vi=len(pi),vo=len(po),identity=round(d0,4),translation=t,after=round(dt,4),
                     ibox=[[round(v,3) for v in imn],[round(v,3) for v in imx]],obox=[[round(v,3) for v in omn],[round(v,3) for v in omx]]))
    r=rows[-1]; print(f"{s} {inl} -> {off}: verts {r['vi']}/{r['vo']} hausdorff identity {r['identity']} ; bbox-centre shift {t} -> {r['after']}")
json.dump(rows,open('/tmp/geo/compare.json','w'),indent=1)
