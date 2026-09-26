import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const here=dirname(fileURLToPath(import.meta.url));

test('export is deterministic and hostile Issue text cannot terminate the JSON script',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'fgc-board-'));
  try{
    const snapshot={schemaVersion:2,repo:'Mang-X/forguncy-react-workspace',fetchedAt:'2026-09-26T00:00:00Z',records:[{number:1,title:'</script><img src=x onerror="window.pwned=1">',body:'<script>evil()</script>\u2028',state:'open',labels:[]}],native:{},incomplete:[]};
    const input=join(dir,'snapshot.json'),a=join(dir,'a.html'),b=join(dir,'b.html');await writeFile(input,JSON.stringify(snapshot));
    for(const out of [a,b]){const result=spawnSync(process.execPath,[join(here,'build.mjs'),input,out],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);}
    const html=await readFile(a,'utf8');assert.equal(html,await readFile(b,'utf8'));
    const payload=/<script id="snapshot" type="application\/json">([\s\S]*?)<\/script>/.exec(html)?.[1];
    assert.ok(payload);assert.ok(!payload.includes('<'));assert.deepEqual(JSON.parse(payload),snapshot);
    assert.equal((html.match(/<script\b/g)||[]).length,2);
    const executable=html.slice(html.indexOf('<script>(()=>{')+'<script>'.length,html.lastIndexOf('</script>'));
    const js=join(dir,'check.js');await writeFile(js,executable);
    const check=spawnSync(process.execPath,['--check',js],{encoding:'utf8'});assert.equal(check.status,0,check.stderr);
    assert.ok(html.includes('最终验收条件'));assert.ok(!html.match(/<script\s+src=/i));
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('another repository snapshot is refused rather than silently relabeled',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'fgc-board-'));
  try{const input=join(dir,'bad.json');await writeFile(input,JSON.stringify({repo:'other/repo',records:[],fetchedAt:'now'}));const result=spawnSync(process.execPath,[join(here,'build.mjs'),input,join(dir,'bad.html')],{encoding:'utf8'});assert.notEqual(result.status,0);}finally{await rm(dir,{recursive:true,force:true});}
});
