export const REPO = 'Mang-X/forguncy-react-workspace';
export const STATUS = {ready:'可开始',blocked:'被阻塞',active:'进行中',done:'已完成',cancelled:'未采纳',review:'需核对',epic:'总览'};
export const labelsOf = i => (i.labels || []).map(l => typeof l === 'string' ? l : l.name);
export const isDone = i => i?.state === 'closed' && !['not_planned','duplicate'].includes(i.state_reason);
export const issueType = i => labelsOf(i).find(l=>l.startsWith('type:'))?.slice(5) || (/^Bootstrap:/i.test(i.title) ? 'infra' : 'issue');
export const priority = i => Number(labelsOf(i).find(l=>/^priority:p\d/.test(l))?.slice(-1) ?? 3);

// Only explicit relationship statements are parsed. Code, quotes, ordinary
// mentions, parent links and Epic checklists must never create blockers.
export function references(line, repo = REPO) {
  const out = [];
  const pattern = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)|([\w.-]+\/[\w.-]+)#(\d+)|(?<![\w/])#(\d+)\b/g;
  for (const m of line.matchAll(pattern)) {
    const other = m[1] || m[3];
    const n = Number(m[2] || m[4] || m[5]);
    const id = other && other.toLowerCase() !== repo.toLowerCase() ? `${other}#${n}` : n;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}
export function parseRelations(issue, repo = REPO) {
  const edges=[], warnings=[], parents=[];
  let section='', fence=false;
  const add = (refs, kind, direction, text) => {
    for (const id of refs) {
      const from = direction==='blocks' ? issue.number : id;
      const to = direction==='blocks' ? id : issue.number;
      edges.push({from,to,kind,evidence:[{issue:issue.number,text,source:'body'}]});
    }
  };
  for (const raw of (issue.body || '').split('\n')) {
    if (/^\s*(```|~~~)/.test(raw)) { fence=!fence; continue; }
    if (fence || /^\s*>/.test(raw)) continue;
    const heading = raw.match(/^#{1,6}\s+(.+)$/);
    if (heading) { section=heading[1].trim().toLowerCase(); continue; }
    const line=raw.trim().replace(/^[*-]\s+(?!\[[ xX]\])/, '');
    if (!line || /^[-*]\s*\[[ xX]\]/.test(raw.trim())) continue;
    const refs=references(line,repo);
    if (/^(?:parent|父任务|所属(?:任务|epic))\s*[:：]/i.test(line)) { parents.push(...refs); continue; }
    const plain = line.replace(/`[^`]*`/g, '');
    const depSection=/^(?:dependencies|dependency|依赖|依赖关系)$/.test(section);
    const explicit = (/^(?:depends?\s+on|blocked\s+by)\s*[:：]?/i.test(plain) || (depSection && /\bdepends?\s+on\b/i.test(plain))) || /^(?:依赖(?:于)?|前置(?:依赖|条件|任务)?)\s*[:：]/.test(line);
    const blocks = /^blocks?\s*[:：]/i.test(line) || /^(?:阻塞|阻塞下游)\s*[:：]/.test(line);
    const blockSection=/^(?:blocks?|阻塞|阻塞下游)$/.test(section);
    const condition=/\b(?:also|closure|test path|final|validation|integration|related|incorporate|should|when|optional)\b|验收|条件|最终|可选|测试路径/i.test(line);
    const bareDep = depSection && /^(?:#\d+|\[#\d+\]|https:\/\/github\.com\/|[\w.-]+\/[\w.-]+#\d+)/.test(line);
    if (explicit || bareDep || blocks || (blockSection && refs.length)) {
      const kind=condition?'conditional':'hard';
      if (refs.length) add(refs,kind,blocks||blockSection?'blocks':'depends',line);
      else if (!/\b(?:none|no implementation dependency)\b|[:：]\s*无/.test(line.toLowerCase()))
        warnings.push({issue:issue.number,text:line,kind:'unresolved',message:'依赖声明没有明确 Issue 编号，请核对源文。'});
    }
  }
  return {edges,warnings,parents};
}

export function buildModel(records, native = {}, incomplete = [], repo = REPO) {
  const issues=records.filter(i=>!i.pull_request).map(i=>({...i,number:Number(i.number)})).sort((a,b)=>a.number-b.number);
  const byId=new Map(issues.map(i=>[i.number,i]));
  const edgeMap=new Map(), warnings=[], parentMap=new Map();
  const add=e=>{
    const key=`${e.from}>${e.to}`;
    if(edgeMap.has(key)) { const old=edgeMap.get(key); old.evidence.push(...e.evidence); if(e.kind==='hard')old.kind='hard'; }
    else edgeMap.set(key,e);
  };
  for(const i of issues) {
    const parsed=parseRelations(i,repo); parsed.edges.forEach(add); warnings.push(...parsed.warnings); parentMap.set(i.number,parsed.parents);
    for(const n of native[i.number] || []) {
      const nativeRepo = (n.html_url || '').match(/github\.com\/([^/]+\/[^/]+)\/issues\//)?.[1] || repo;
      const from=nativeRepo.toLowerCase()===repo.toLowerCase()?Number(n.number):`${nativeRepo}#${n.number}`;
      add({from,to:i.number,kind:'hard',evidence:[{issue:i.number,source:'native',text:`GitHub blocked by ${nativeRepo}#${n.number}`}]});
    }
  }
  const edges=[...edgeMap.values()];
  const incoming=new Map(issues.map(i=>[i.number,edges.filter(e=>e.to===i.number)]));
  const outgoing=new Map(issues.map(i=>[i.number,edges.filter(e=>e.from===i.number)]));
  const hard=edges.filter(e=>e.kind==='hard');
  // Tarjan SCC: preserve a cycle, never silently delete an edge to draw a DAG.
  let idx=0; const stack=[], indices=new Map(),low=new Map(),onStack=new Set(),components=[];
  function visit(v) {
    indices.set(v,idx);low.set(v,idx++);stack.push(v);onStack.add(v);
    for(const e of hard.filter(e=>e.from===v && byId.has(e.to))) {
      if(!indices.has(e.to)){visit(e.to);low.set(v,Math.min(low.get(v),low.get(e.to)));}
      else if(onStack.has(e.to))low.set(v,Math.min(low.get(v),indices.get(e.to)));
    }
    if(low.get(v)===indices.get(v)){const group=[];let w;do{w=stack.pop();onStack.delete(w);group.push(w);}while(w!==v);components.push(group);}
  }
  issues.forEach(i=>{if(!indices.has(i.number))visit(i.number);});
  const cycles=components.filter(c=>c.length>1||hard.some(e=>e.from===c[0]&&e.to===c[0]));
  const cycleIds=new Set(cycles.flat());
  for(const c of cycles)warnings.push({kind:'cycle',issue:c[0],ids:c,text:c.map(n=>'#'+n).join(' → '),message:'存在硬依赖循环，请在源 Issue 核对；看板不自动改写。'});
  const componentOf=new Map();components.forEach((c,k)=>c.forEach(n=>componentOf.set(n,k)));
  const levels=new Map();
  function level(k){if(levels.has(k))return levels.get(k);let value=0;for(const e of hard){if(componentOf.get(e.to)===k&&componentOf.has(e.from)&&componentOf.get(e.from)!==k)value=Math.max(value,level(componentOf.get(e.from))+1);}levels.set(k,value);return value;}
  components.forEach((_,k)=>level(k));
  const prs=records.filter(i=>i.pull_request);
  const relatedPRs=new Map(issues.map(i=>[i.number,[]]));
  for(const pr of prs){
    let fence=false;
    for(const line of (pr.body||'').split('\n')){
      if(/^\s*(```|~~~)/.test(line)){fence=!fence;continue;}if(fence)continue;
      if(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|refs?)\b/i.test(line)) {
        const closing=/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b/i.test(line);
        for(const n of references(line,repo)){const a=relatedPRs.get(n);if(a&&!a.some(x=>x.number===pr.number))a.push({...pr,closing});}
      }
    }
  }
  for(const i of issues){
    const list=incoming.get(i.number), blockers=list.filter(e=>e.kind==='hard'&&!isDone(byId.get(e.from)));
    const unknown=list.some(e=>e.kind==='hard'&&!byId.has(e.from));
    if(unknown) warnings.push({kind:'missing',issue:i.number,text:blockers.filter(e=>!byId.has(e.from)).map(e=>String(e.from)).join(', '),message:'依赖指向未读取/跨仓库 Issue，状态未知，不计为已完成。'});
    const ls=labelsOf(i), prsForIssue=relatedPRs.get(i.number);
    const progress=ls.some(l=>/^status:(?:in-progress|in_progress|active|in-review)$/.test(l))||prsForIssue.some(p=>p.state==='open'&&p.closing);
    const manualBlocked=ls.includes('status:blocked');
    const unresolved=warnings.some(w=>w.issue===i.number&&w.kind==='unresolved')||incomplete.includes(i.number);
    let status;
    if(isDone(i))status='done';
    else if(i.state==='closed')status='cancelled';
    else if(issueType(i)==='epic')status='epic';
    else if(blockers.length)status='blocked';
    else if(unresolved||manualBlocked)status='review';
    else if(progress)status='active';
    else status='ready';
    if(manualBlocked&&!blockers.length&&i.state==='open')warnings.push({kind:'label',issue:i.number,text:'status:blocked',message:'声明的硬依赖已满足或为空，但仍有人工阻塞标签；不擅自视为可开工。'});
    if(ls.includes('status:ready')&&blockers.length&&i.state==='open')warnings.push({kind:'label',issue:i.number,text:'status:ready',message:'ready 标签与未完成的硬依赖冲突，以依赖证据提示阻塞。'});
    Object.assign(i,{status,blockers,progress,needsValidation:ls.includes('status:needs-validation'),inCycle:cycleIds.has(i.number),level:levels.get(componentOf.get(i.number))||0,prs:prsForIssue});
  }
  return {issues,byId,edges,incoming,outgoing,warnings,cycles,parentMap,repo};
}
export function walk(model,id,direction){const set=new Set(), todo=[id];while(todo.length){const n=todo.pop();for(const e of (direction==='up'?model.incoming:model.outgoing).get(n)||[]){const v=direction==='up'?e.from:e.to;if(v!==id&&!set.has(v)){set.add(v);todo.push(v);}}}return set;}
export function layout(model,visible=model.issues){const groups=new Map();visible.forEach(i=>{if(!groups.has(i.level))groups.set(i.level,[]);groups.get(i.level).push(i);});const map=new Map();const max=Math.max(1,...[...groups.values()].map(g=>g.length));for(const [col,items]of groups){items.sort((a,b)=>priority(a)-priority(b)||a.number-b.number);items.forEach((i,row)=>map.set(i.number,{x:36+col*284,y:60+row*132,w:236,h:106}));}return {positions:map,width:Math.max(700,80+(Math.max(0,...groups.keys())+1)*284),height:Math.max(440,110+max*132)};}
export function promptFor(model,issue,agent='') {
  const deps=(model.incoming.get(issue.number)||[]).map(e=>`- ${e.kind==='hard'?'前置':'条件/验收'}依赖 ${typeof e.from==='number'?'#':''}${e.from}：${model.byId.get(e.from)?.title||'未读取'}；${model.byId.get(e.from)?STATUS[model.byId.get(e.from).status]:'状态未知'}\n  依据：${e.evidence.map(x=>x.text).join(' / ')}`).join('\n') || '- 未发现明确的前置依赖；执行前重新核对 Issue。';
  return `${agent?`分配给：${agent}\n\n`:''}仓库：https://github.com/${model.repo}\n任务：#${issue.number} ${issue.title}\nIssue：https://github.com/${model.repo}/issues/${issue.number}\n看板计算状态：${STATUS[issue.status]}（必须以执行时最新 GitHub 状态为准）\n\n依赖：\n${deps}\n\n执行要求：\n1. 先读取最新 Issue、依赖 Issue、相关 PR 和仓库 AGENTS.md；不要重复实施已合并的工作。\n2. 硬依赖未完成、状态未知或需求有歧义时，先在 Issue 报告阻塞，不强行跳过。条件/验收依赖与实施前置分开确认。\n3. ${issueType(issue)==='spec'?'这是规格任务，先审议设计并将决定记录回 Issue，不把 Spec/Plan 写入仓库。':'在独立分支/worktree 中按本 Issue 范围实施，不夹带无关改动。'}\n4. 遵循 Issue 的验收标准，执行可用检查；区分本地测试与真实活字格运行验证，不伪报验证。\n5. 通过 PR 交付代码，关联本 Issue；全部验收完成才使用 Closes #${issue.number}，否则使用 Refs #${issue.number} 并列出剩余阻塞。\n\nIssue 原文（快照；执行前必须重新读取）：\n${issue.body||'（无正文）'}`;
}
