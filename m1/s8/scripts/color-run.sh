set -e
S=$1; BASE=$2; LOOK=$3
U="api=webgl2&camera=top&measure=1&warmup=2&frames=2$LOOK"
cd /tmp/drv
DISPLAY=:1 node shoot.mjs $S $(for m in 10264-1 10185-1 10190-1 10218-1 2150-1 4554-1 4555-1; do echo "$m=$BASE/?model=$m&$U"; done) | cut -c1-40
node -e '
const S=process.argv[1];const plan=[];
const by={71:["10264-1","10185-1","10190-1","10218-1"],72:["10264-1","10185-1","10190-1","10218-1"],15:["10218-1","4555-1"],0:["10185-1"],14:["10264-1","2150-1","4554-1","4555-1"]};
for(const [c,ms] of Object.entries(by))for(const m of ms)plan.push({color:+c,model:m,png:`${S}/${m}.png`});
require("fs").writeFileSync(`${S}/plan.json`,JSON.stringify(plan));' $S
node color-accuracy.mjs /agent/repos/lug-layout/tools/asset-pipeline/dist/bundle/standard $S/plan.json $S/report.json
