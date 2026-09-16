import {writeFile} from 'node:fs/promises';
import {REPO} from './model.mjs';
const token=process.env.GH_TOKEN;
async function pages(url){const all=[];let count=0;while(url){if(!url.startsWith(`https://api.github.com/repos/${REPO}/`))throw Error('Unexpected API origin');if(++count>100)throw Error('Pagination limit exceeded');const r=await fetch(url,{headers:{Accept:'application/vnd.github+json',...(token?{Authorization:`Bearer ${token}`}:{})},signal:AbortSignal.timeout(25000)});if(!r.ok)throw Error(`GitHub ${r.status}`);const a=await r.json();if(!Array.isArray(a))throw Error('Invalid response');all.push(...a);url=(r.headers.get('link')||'').match(/<([^>]+)>;\s*rel="next"/)?.[1]||'';}return all;}
const raw=await pages(`https://api.github.com/repos/${REPO}/issues?state=all&per_page=100&sort=created&direction=asc`);
const records=raw.map(i=>({number:i.number,title:i.title,body:i.body,state:i.state,state_reason:i.state_reason,labels:i.labels.map(l=>({name:l.name})),assignees:i.assignees.map(a=>({login:a.login})),created_at:i.created_at,updated_at:i.updated_at,closed_at:i.closed_at,issue_dependencies_summary:i.issue_dependencies_summary,...(i.pull_request?{pull_request:{merged_at:i.pull_request.merged_at}}:{})}));
const native={},incomplete=[];
for(const i of records.filter(i=>!i.pull_request)){const n=i.issue_dependencies_summary?.total_blocked_by;if(n===0){native[i.number]=[];continue;}if(n===undefined){incomplete.push(i.number);continue;}try{native[i.number]=(await pages(`https://api.github.com/repos/${REPO}/issues/${i.number}/dependencies/blocked_by?per_page=100`)).map(d=>({number:d.number,html_url:d.html_url}));}catch{incomplete.push(i.number);}}
const snapshot={repo:REPO,fetchedAt:new Date().toISOString(),records,native,incomplete};
await writeFile(new URL('./snapshot.json',import.meta.url),JSON.stringify(snapshot,null,2));
console.log(`Read ${records.filter(i=>!i.pull_request).length} issues; ${incomplete.length} unresolved native-dependency reads.`);
