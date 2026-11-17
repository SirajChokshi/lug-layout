# Performance evidence for the 4x4 MILS layout bench

`scripts/run-mac.sh <ref> <label> [extra-query]` checks out `<ref>` of lug-layout, builds the part bundle and the web app, serves `vite preview` on :4173 and runs `scripts/measure.mjs`: headless Chrome (`--headless=new`, real GPU), 1600×1000 CSS px at DPR 2, `?scene=layout&measure=1&warmup=10&frames=120`, WebGPU and WebGL2, aerial and street cameras, 3 page loads each. Results land in `results/<label>/`.
