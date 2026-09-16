import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const here=path.dirname(fileURLToPath(import.meta.url));
const out=path.resolve(here,'../../dist/issue-board');
let snapshot=null;
try{snapshot=JSON.parse(await readFile(path.join(here,'snapshot.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
const [template,css,model,app]=await Promise.all(['index.html','style.css','model.mjs','app.mjs'].map(p=>readFile(path.join(here,p),'utf8')));
const js=`(()=>{\n'use strict';\n${model.replace(/^export /gm,'')}\n${app.replace(/^import .* from '\.\/model\.mjs';\n/,'')}\n})();`.replace(/<\/script/gi,'<\\/script');
const data=JSON.stringify(snapshot).replace(/</g,'\\u003c');
const html=template.replace('<link rel="stylesheet" href="./style.css">',()=>`<style>${css}</style>`).replace('<script id="snapshot" type="application/json">null</script>',()=>`<script id="snapshot" type="application/json">${data}</script>`).replace('<script type="module" src="./app.mjs"></script>',()=>`<script>${js}</script>`);
await mkdir(out,{recursive:true});await writeFile(path.join(out,'index.html'),html);
console.log(`Built ${path.join(out,'index.html')} (${Buffer.byteLength(html)} bytes), snapshot ${snapshot?.fetchedAt||'none; live fetch required'}`);
