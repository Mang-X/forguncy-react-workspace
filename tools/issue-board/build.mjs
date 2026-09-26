// A dependency-free, reproducible single-file export. Specs live in #103.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildModel, REPO } from './model.mjs';
const here=dirname(fileURLToPath(import.meta.url));
const input=resolve(process.argv[2]||`${here}/snapshot.json`);
const output=resolve(process.argv[3]||'dist/issue-board/index.html');
const snapshot=JSON.parse(await readFile(input,'utf8'));
if(snapshot.repo!==REPO||!Array.isArray(snapshot.records)||!snapshot.fetchedAt)throw new Error('Invalid repository snapshot');
const model=buildModel(snapshot.records,snapshot.native,snapshot.incomplete);
const [template,core,ui]=await Promise.all(['template.html','model.mjs','app.js'].map(name=>readFile(`${here}/${name}`,'utf8')));
const executable=core.replace(/^export /gm,'')+'\n'+ui;
if(/<\/script/i.test(executable))throw new Error('Embedded script has an unsafe closing tag');
const data=JSON.stringify(snapshot).replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
const html=template+`<script id="snapshot" type="application/json">${data}</script>\n<script>(()=>{\n'use strict';\n${executable}\n})();</script>\n</body>\n</html>\n`;
await mkdir(dirname(output),{recursive:true});await writeFile(output,html);
console.log(JSON.stringify({output,issues:model.issues.length,edges:model.edges.length,cycles:model.cycles,warnings:model.warnings.length,fetchedAt:snapshot.fetchedAt}));
