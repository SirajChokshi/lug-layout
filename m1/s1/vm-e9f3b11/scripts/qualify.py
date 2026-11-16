import json,re,sys,hashlib
t=json.load(open('/tmp/omr/tree.json'))
paths={e['path'].lower():e['path'] for e in t['tree'] if e['type']=='blob'}
PREFIX=re.compile(r'^(s[\\/])?\d+(?:-\d+)? - (.+)$')
def norm(r): return r.lower().replace('\\','/')
def at_pin(r): return any(('ldraw/'+d+norm(r)) in paths for d in ('parts/','p/'))
def official_name(n):
  m=PREFIX.match(n); return norm((m.group(1) or '')+m.group(2)) if m else norm(n)
def analyze(s):
  src=open(f'/tmp/omr/{s}.mpd',encoding='utf-8',errors='replace').read()
  secs=[];cur=None
  for line in src.splitlines():
    tk=line.split()
    if len(tk)>=3 and tk[0]=='0' and tk[1].upper()=='FILE':
      cur={'name':norm(' '.join(tk[2:])),'org':'','lic':'','title':None,'refs':[]}; secs.append(cur); continue
    if cur is None: continue
    if cur['title'] is None and tk and tk[0]=='0' and len(tk)>1: cur['title']=' '.join(tk[1:])
    if len(tk)>=2 and tk[0]=='0' and tk[1]=='!LDRAW_ORG': cur['org']=' '.join(tk[2:])
    if len(tk)>=2 and tk[0]=='0' and tk[1]=='!LICENSE': cur['lic']=' '.join(tk[2:])
    if tk and tk[0]=='1' and len(tk)>=15: cur['refs'].append(norm(' '.join(tk[14:])))
  by={x['name']:x for x in secs}
  is_part=lambda x: x['org']!='' and not x['org'].split()[0]=='Model'
  used_parts=set(); superseded={}; problems=[]
  seen=set()
  def walk(name):
    if name in seen: return
    seen.add(name)
    for r in by[name]['refs']:
      if r in by and not is_part(by[r]): walk(r)
      elif r in by:
        o=official_name(r)
        if at_pin(o): superseded[r]=o; used_parts.add(o)
        else: problems.append('inline part not official at pin: '+r)
      else:
        if at_pin(r): used_parts.add(r)
        else: problems.append('unresolved: '+r)
  walk(secs[0]['name'])
  for x in secs:
    if 'CCAL' not in x['lic'] and 'CC BY' not in x['lic']: problems.append('non-CA section: '+x['name']+' ('+x['lic']+')')
  return {'set':s,'sections':len(secs),'parts':sorted(used_parts),'superseded':superseded,'problems':sorted(set(problems)),
          'sha256':hashlib.sha256(open(f'/tmp/omr/{s}.mpd','rb').read()).hexdigest(),'author':None,'secs':secs}
if __name__=='__main__':
  for s in sys.argv[1:]:
    a=analyze(s); print(s, 'parts',len(a['parts']),'superseded',len(a['superseded']),'problems',len(a['problems']), a['problems'][:4])
