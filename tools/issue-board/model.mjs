// Issue #103. No network or persistent state: GitHub data in, derived view out.
export const REPO = 'Mang-X/forguncy-react-workspace';
export const STATUS = {ready:'可开始',blocked:'等待前置',active:'进行中',done:'已完成',cancelled:'未采纳',closed:'关闭原因未知',review:'依赖数据异常',paused:'明确暂停',gate:'可准备验收',epic:'计划总览'};
export const TRACKS = {runtime:'Runtime 装配',extension:'项目扩展',esm:'ESM 支持',skill:'Skill 操作',sync:'同步恢复',cache:'缓存与证据',build:'构建与资源',consumer:'消费方体验',ci:'测试与 CI',board:'依赖看板',validation:'验收 Gate',cleanup:'可选收敛',integration:'整改计划',overview:'项目总览',legacy:'历史任务'};
export const labelsOf = issue => (issue.labels || []).map(label => typeof label === 'string' ? label : label.name).filter(Boolean);
export const isDone = issue => issue?.state === 'closed' && issue.state_reason === 'completed';
export const issueType = issue => issue.board?.kind === 'gate' ? 'gate' : labelsOf(issue).find(label=>label.startsWith('type:'))?.slice(5) || (/^Bootstrap:/i.test(issue.title) ? 'infra' : 'issue');
export const priority = issue => Number(labelsOf(issue).find(label=>/^priority:p\d+$/.test(label))?.split('p').at(-1) ?? 3);
const sameSet = (a,b) => JSON.stringify([...new Set(a)].sort()) === JSON.stringify([...new Set(b)].sort());
const issueId = value => Number.isSafeInteger(value) && value > 0;

export function references(text, repo = REPO) {
  const out=[];
  const pattern=/https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)|([\w.-]+\/[\w.-]+)#(\d+)|(?<![\w/])#(\d+)\b/g;
  for (const match of text.matchAll(pattern)) {
    // PR references are provenance, not an Issue dependency.
    if (/\b(?:PR|pull\s+request)\s*$/i.test(text.slice(Math.max(0,match.index-25),match.index))) continue;
    const other=match[1]||match[3], number=Number(match[2]||match[4]||match[5]);
    const id=other&&other.toLowerCase()!==repo.toLowerCase()?`${other}#${number}`:number;
    if(!out.includes(id))out.push(id);
  }
  return out;
}

// Read only an enumerated prefix; prose after an em dash is context, not a
// second dependency list (the historical #67 sentence also mentions #22).
function leadingReferences(text,repo) {
  const ids=[];let rest=text;
  const token=/^(https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+|[\w.-]+\/[\w.-]+#\d+|#\d+)/;
  for(let guard=0;guard<1000;guard++) {
    rest=rest.replace(/^\s*(?:[,，/&;；]|and\b)?\s*/i,'');
    const match=token.exec(rest);if(!match)break;
    ids.push(...references(match[1],repo));rest=rest.slice(match[0].length);
  }
  return [...new Set(ids)];
}

function validateMetadata(value) {
  const errors=[];
  if(!value || Array.isArray(value) || typeof value!=='object')return ['fgc-board 必须是一个 JSON 对象'];
  if(value.schemaVersion!==1)errors.push('不支持的 fgc-board schemaVersion');
  if(!['task','gate','epic'].includes(value.kind))errors.push('kind 必须是 task / gate / epic');
  const known=new Set(['schemaVersion','kind','track','parent','dependsOn','acceptanceDependsOn','related','externalBlockers','manualHold','requiredEnvironment','optional']);
  for(const key of Object.keys(value))if(!known.has(key))errors.push(`未知字段 ${key}，可能是拼写错误`);
  for(const key of ['dependsOn','acceptanceDependsOn']) {
    if(!Array.isArray(value[key]) || !value[key].every(issueId))errors.push(`${key} 必须是当前仓库 Issue 正整数数组`);
    else if(new Set(value[key]).size!==value[key].length)errors.push(`${key} 存在重复编号`);
  }
  if(value.related!==undefined&&(!Array.isArray(value.related)||!value.related.every(issueId)))errors.push('related 必须是编号数组');
  if(value.parent!==undefined&&!issueId(value.parent))errors.push('parent 必须是一个 Issue 编号');
  if(value.track!==undefined&&(typeof value.track!=='string'||!value.track.trim()))errors.push('track 必须是非空字符串');
  if(value.optional!==undefined&&typeof value.optional!=='boolean')errors.push('optional 必须是布尔值');
  if(value.manualHold!==undefined&&(typeof value.manualHold!=='string'||!value.manualHold.trim()))errors.push('manualHold 必须说明非空暂停原因；解除时删除该字段');
  if(value.requiredEnvironment!==undefined&&(!Array.isArray(value.requiredEnvironment)||!value.requiredEnvironment.every(x=>typeof x==='string'&&x.trim())))errors.push('requiredEnvironment 必须是非空字符串数组');
  if(value.externalBlockers!==undefined) {
    if(!Array.isArray(value.externalBlockers))errors.push('externalBlockers 必须是数组');
    else for(const blocker of value.externalBlockers)if(!blocker||typeof blocker.active!=='boolean'||typeof blocker.reason!=='string'||!blocker.reason.trim())errors.push('每个 externalBlocker 必须含 active 布尔值和非空 reason');
  }
  return errors;
}

// Only leading, explicit relationship declarations are authoritative. A reference
// in prose, checklist, fenced example, Parent, Related or PR description is not.
export function parseRelations(issue, repo=REPO) {
  const edges=[],warnings=[],parents=[], declarations={hard:[],acceptance:[]};
  const warn=(kind,message,text)=>warnings.push({issue:issue.number,kind,message,text});
  const rawBody=issue.body||'';
  const blocks=[...rawBody.matchAll(/<!--\s*fgc-board\s*\n([\s\S]*?)-->/g)];
  let board=null,invalid=false;
  if(blocks.length>1){warn('metadata','存在多个 fgc-board 块，不能选择其中一个猜测',String(blocks.length));invalid=true;}
  if(blocks.length===1) {
    try {
      board=JSON.parse(blocks[0][1]);
      const errors=validateMetadata(board);
      if(errors.length){invalid=true;for(const error of errors)warn('metadata',error,blocks[0][1]);board=null;}
    } catch(error){invalid=true;warn('metadata','fgc-board JSON 无法解析',error.message);}
  } else if(/<!--\s*fgc-board\b/.test(rawBody)) {invalid=true;warn('metadata','fgc-board 块未正确结束', '需要以 --> 结束');}
  const body=rawBody.replace(/<!--[\s\S]*?-->/g,'');
  let fence=null,section='';
  const add=(ids,kind,direction,text,source='body')=>{
    for(const id of ids)edges.push({from:direction==='blocks'?issue.number:id,to:direction==='blocks'?id:issue.number,kind,evidence:[{issue:issue.number,text,source}]});
  };
  for(const raw of body.split(/\r?\n/)) {
    const mark=/^\s*(`{3,}|~{3,})/.exec(raw);
    if(mark){if(!fence)fence=mark[1][0];else if(mark[1][0]===fence)fence=null;continue;}
    if(fence||/^\s*>/.test(raw))continue;
    const heading=/^#{1,6}\s+(.+)$/.exec(raw);
    if(heading){section=heading[1].trim().toLowerCase();continue;}
    let line=raw.trim().replace(/^[-*]\s+(?!\[[ xX]\])/, '');
    if(!line||/^[-*]?\s*\[[ xX]\]/.test(line))continue;
    line=line.replace(/\*\*/g,'');
    if(/^(parent|父任务|所属(?:任务|epic))\s*[:：]/i.test(line)){parents.push(...references(line,repo));continue;}
    const acceptance=/^(?:acceptance\s+depends?\s+on|real-project\s+closure\s+also\s+depends?\s+on|验收(?:依赖|前置))\s*[:：]?\s*(.*)$/i.exec(line);
    const hard=/^(?:depends?\s+on|blocked\s+by|依赖(?:于)?|前置(?:依赖|条件|任务)?)\s*[:：]?\s*(.*)$/i.exec(line);
    const condition=/^(?:compiler-aware\s+probes|extension\s+test\s+path)\s+also\s+depends?\s+on\s*[:：]?\s*(.*)$/i.exec(line);
    const outgoing=/^blocks?\s*[:：]?\s*(.*)$/i.exec(line);
    const bareOutgoing=/^(?:blocks?|阻塞下游)$/.test(section)&&/^(?:#\d+|https:\/\/github\.com\/)/.test(line);
    if(!acceptance&&!hard&&!condition&&!outgoing&&!bareOutgoing)continue;
    let payload=(acceptance||hard||condition||outgoing)?.[1]??line;
    let kind=acceptance?'acceptance':condition?'conditional':'hard';
    if(hard&&/\bfor final\b|final validation only|最终.*(?:语义|验收)/i.test(payload))kind='acceptance';
    if(outgoing&&/to the extent|optional|when\b/i.test(payload))kind='conditional';
    // Parenthetical context must not silently add indirect deps or PR numbers.
    const leading=payload.split(/[（(]/,1)[0].trim();
    const none=/^(?:none|nothing|no\s+(?:implementation\s+)?dependenc(?:y|ies)|无)(?:\b|[。；;.]|$)/i.test(leading);
    const ids=none?[]:leadingReferences(leading,repo);
    if((hard||acceptance)&&!condition)declarations[kind==='acceptance'?'acceptance':'hard'].push(ids);
    if(!none&&!ids.length){if(!outgoing&&!bareOutgoing)warn('unresolved','明确的依赖声明未能读取编号',line);continue;}
    if(!board||invalid)add(ids,kind,outgoing||bareOutgoing?'blocks':'depends',line);
  }
  if(board&&!invalid) {
    for(const [kind,key]of [['hard','dependsOn'],['acceptance','acceptanceDependsOn']]) {
      const statements=declarations[kind];
      if(statements.length===0)warn('metadata','结构化依赖缺少对应的可读声明',key);
      else if(statements.some(ids=>!sameSet(ids,board[key])))warn('metadata','可读声明与 fgc-board 依赖不一致',`${key}: ${JSON.stringify(board[key])}；正文: ${JSON.stringify(statements)}`);
      add(board[key],kind,'depends',`${key}: ${board[key].map(n=>'#'+n).join(', ')||'none'}`,'metadata');
    }
    if(board.parent!==undefined){if(parents.length&&!sameSet(parents,[board.parent]))warn('metadata','Parent 与 fgc-board.parent 不一致',JSON.stringify(parents));parents.push(board.parent);}
  }
  return {edges,warnings,parents:[...new Set(parents)],board,structured:blocks.length===1&&!invalid};
}

// Iterative SCC avoids recursive stack exhaustion on a long repository history.
function componentsOf(ids, edges) {
  const idSet=new Set(ids),adj=new Map(ids.map(id=>[id,[]])),back=new Map(ids.map(id=>[id,[]]));
  for(const {from,to}of edges)if(idSet.has(from)&&idSet.has(to)){adj.get(from).push(to);back.get(to).push(from);}
  const visited=new Set(),order=[];
  for(const start of ids){if(visited.has(start))continue;const stack=[[start,false]];while(stack.length){const [v,end]=stack.pop();if(end){order.push(v);continue;}if(visited.has(v))continue;visited.add(v);stack.push([v,true]);for(const next of adj.get(v))if(!visited.has(next))stack.push([next,false]);}}
  visited.clear();const groups=[];
  for(const start of order.reverse()){if(visited.has(start))continue;const group=[],stack=[start];visited.add(start);while(stack.length){const v=stack.pop();group.push(v);for(const next of back.get(v))if(!visited.has(next)){visited.add(next);stack.push(next);}}groups.push(group);}
  return groups;
}

export function buildModel(records,native={},incomplete=[],repo=REPO) {
  const byRecord=new Map();
  for(const item of records||[])if(issueId(Number(item.number)))byRecord.set(Number(item.number),item);
  const issues=[...byRecord.values()].filter(i=>!i.pull_request).map(i=>({...i,number:Number(i.number)})).sort((a,b)=>a.number-b.number);
  const byId=new Map(issues.map(i=>[i.number,i])),prs=[...byRecord.values()].filter(i=>i.pull_request);
  const prIds=new Set(prs.map(p=>Number(p.number))),edgeMap=new Map(),warnings=[],parentMap=new Map();
  const add=e=>{const key=`${e.from}>${e.to}:${e.kind}`;if(edgeMap.has(key))edgeMap.get(key).evidence.push(...e.evidence);else edgeMap.set(key,e);};
  for(const issue of issues) {
    const parsed=parseRelations(issue,repo);issue.board=parsed.board;issue.structured=parsed.structured;
    issue.kind=parsed.board?.kind||(issueType(issue)==='epic'?(/gate/i.test(issue.title)?'gate':'epic'):'task');
    issue.track=parsed.board?.track||'legacy';issue.optional=parsed.board?.optional===true;
    issue.requiredEnvironment=parsed.board?.requiredEnvironment||[];
    warnings.push(...parsed.warnings);parentMap.set(issue.number,parsed.parents);
    for(const edge of parsed.edges) {
      if(prIds.has(edge.from)||prIds.has(edge.to)){warnings.push({kind:'pr-reference',issue:issue.number,text:edge.evidence[0].text,message:'依赖编号实际是 PR；请声明真实 Issue，而非将 PR 当作任务'});continue;}
      add(edge);
    }
    for(const dep of native[issue.number]||[]) {
      const foreign=(dep.html_url||'').match(/github\.com\/([^/]+\/[^/]+)\/issues\//)?.[1]||repo;
      const from=foreign.toLowerCase()===repo.toLowerCase()?Number(dep.number):`${foreign}#${dep.number}`;
      add({from,to:issue.number,kind:'hard',evidence:[{issue:issue.number,source:'native',text:`GitHub blocked by ${foreign}#${dep.number}`}]});
      if(issue.structured&&!issue.board.dependsOn.includes(from))warnings.push({kind:'metadata',issue:issue.number,text:String(from),message:'原生开工依赖与显式 fgc-board 声明不一致'});
    }
    if(incomplete.includes(issue.number)&&issue.state==='open')warnings.push({kind:'native-incomplete',issue:issue.number,text:'GitHub 原生依赖尚未读完整',message:'有未读的依赖信息，不能将其当作空依赖'});
  }
  const edges=[...edgeMap.values()];
  const incoming=new Map(issues.map(i=>[i.number,[]])),outgoing=new Map(issues.map(i=>[i.number,[]]));
  for(const e of edges){incoming.get(e.to)?.push(e);outgoing.get(e.from)?.push(e);}
  const hard=edges.filter(e=>e.kind==='hard'),components=componentsOf(issues.map(i=>i.number),hard);
  const cycles=components.filter(group=>group.length>1||hard.some(e=>e.from===group[0]&&e.to===group[0]));
  const cycleIds=new Set(cycles.flat());
  for(const group of cycles)warnings.push({kind:'cycle',issue:group[0],ids:group,text:group.map(n=>'#'+n).join(' → '),message:'存在开工依赖循环；必须在源 Issue 中修正'});
  const componentOf=new Map();components.forEach((g,k)=>g.forEach(n=>componentOf.set(n,k)));
  const levels=new Map(components.map((_,k)=>[k,0]));
  for(let step=0;step<components.length;step++){let changed=false;for(const e of hard){const a=componentOf.get(e.from),b=componentOf.get(e.to);if(a===undefined||b===undefined||a===b)continue;const next=levels.get(a)+1;if(next>levels.get(b)){levels.set(b,next);changed=true;}}if(!changed)break;}
  const relatedPRs=new Map(issues.map(i=>[i.number,[]]));
  for(const pr of prs){let fence=false;for(const raw of (pr.body||'').split(/\r?\n/)){if(/^\s*(```|~~~)/.test(raw)){fence=!fence;continue;}if(fence||/^\s*>/.test(raw))continue;const match=/^\s*(?:[-*]\s*)?(close[sd]?|fix(?:e[sd])?|resolve[sd]?|refs?)\s+(.+)$/i.exec(raw);if(!match)continue;for(const n of references(match[2],repo)){const list=relatedPRs.get(n);if(list&&!list.some(x=>x.number===pr.number))list.push({...pr,closing:!/^refs?$/i.test(match[1])});}}}
  for(const issue of issues) {
    const deps=incoming.get(issue.number),blockers=deps.filter(e=>e.kind==='hard'&&!isDone(byId.get(e.from)));
    const acceptanceBlockers=deps.filter(e=>e.kind==='acceptance'&&!isDone(byId.get(e.from)));
    const missing=deps.filter(e=>!byId.has(e.from));
    if(missing.length)warnings.push({kind:missing.some(e=>e.kind==='hard')?'missing':'acceptance-missing',issue:issue.number,text:missing.map(e=>String(e.from)).join(', '),message:'依赖指向未读取或跨仓库 Issue，不计为完成'});
    const labels=labelsOf(issue), linked=relatedPRs.get(issue.number);
    const progress=labels.some(l=>/^status:(in-progress|in_progress|active|in-review)$/.test(l))||linked.some(p=>p.state==='open'&&p.closing);
    const holdReasons=[...(issue.board?.manualHold?[issue.board.manualHold]:[]),...(issue.board?.externalBlockers||[]).filter(b=>b.active).map(b=>b.reason)];
    if(labels.includes('status:blocked')&&issue.state==='open') {
      if(issue.structured)warnings.push({kind:'label',issue:issue.number,text:'status:blocked',message:'标签滞后：显式依赖与暂停字段决定状态，不由旧 blocked 标签覆盖'});
      else if(!blockers.length)holdReasons.push('旧票只有 status:blocked 标签，尚未说明是否为外部条件；请在 Issue 明确暂停原因或更新标签。');
    }
    if(labels.includes('status:ready')&&blockers.length&&issue.state==='open')warnings.push({kind:'label',issue:issue.number,text:'status:ready',message:'ready 标签滞后，以未完成的真实前置为准'});
    const invalid=cycleIds.has(issue.number)||warnings.some(w=>w.issue===issue.number&&['metadata','unresolved','pr-reference','native-incomplete','missing'].includes(w.kind));
    const canStart=!invalid&&!blockers.length&&!holdReasons.length&&issue.state==='open';
    let status;
    if(isDone(issue))status='done';
    else if(issue.state==='closed')status=['not_planned','duplicate'].includes(issue.state_reason)?'cancelled':'closed';
    else if(invalid)status='review';
    else if(holdReasons.length)status='paused';
    else if(issue.kind==='epic')status='epic';
    else if(blockers.length)status='blocked';
    else if(progress)status='active';
    else if(issue.kind==='gate')status='gate';
    else status='ready';
    Object.assign(issue,{status,blockers,acceptanceBlockers,holdReasons,canStart,canClose:canStart&&acceptanceBlockers.length===0,progress,needsValidation:labels.includes('status:needs-validation'),inCycle:cycleIds.has(issue.number),level:levels.get(componentOf.get(issue.number))||0,prs:linked});
  }
  return {issues,byId,edges,incoming,outgoing,warnings,cycles,parentMap,repo};
}

export function walk(model,id,direction) {
  const found=new Set(),todo=[id];while(todo.length){const n=todo.pop();for(const e of (direction==='up'?model.incoming:model.outgoing).get(n)||[]){const next=direction==='up'?e.from:e.to;if(next!==id&&!found.has(next)){found.add(next);todo.push(next);}}}return found;
}
export function inRound(model,issue,round=81) {return issue.number===round||(model.parentMap.get(issue.number)||[]).includes(round)||issue.number===25;}
export function layout(model,visible=model.issues) {
  const ids=new Set(visible.map(i=>i.number)),levels=new Map(visible.map(i=>[i.number,0]));
  // Layout is a projection only; do not pull hidden historical levels into this view.
  for(let k=0;k<visible.length;k++){let change=false;for(const e of model.edges){if(e.kind!=='hard'||!ids.has(e.from)||!ids.has(e.to)||model.byId.get(e.to).inCycle)continue;const level=Math.min(visible.length,levels.get(e.from)+1);if(level>levels.get(e.to)){levels.set(e.to,level);change=true;}}if(!change)break;}
  const groups=new Map();for(const i of visible){const col=levels.get(i.number);if(!groups.has(col))groups.set(col,[]);groups.get(col).push(i);}
  const positions=new Map();const trackOrder=Object.keys(TRACKS);
  for(const [col,items]of groups){items.sort((a,b)=>trackOrder.indexOf(a.track)-trackOrder.indexOf(b.track)||priority(a)-priority(b)||a.number-b.number);items.forEach((i,row)=>positions.set(i.number,{x:36+col*278,y:60+row*132,w:236,h:106,col}));}
  return {positions,width:Math.max(700,80+(Math.max(0,...groups.keys())+1)*278),height:Math.max(440,110+Math.max(0,...[...groups.values()].map(g=>g.length))*132)};
}
export function promptFor(model,issue,agent='') {
  const depText=(kind)=> (model.incoming.get(issue.number)||[]).filter(e=>e.kind===kind).map(e=>`- ${typeof e.from==='number'?'#':''}${e.from} ${model.byId.get(e.from)?.title||'未读取'}：${isDone(model.byId.get(e.from))?'已完成':STATUS[model.byId.get(e.from)?.status]||'未知'}；来源：${e.evidence.map(x=>x.text).join(' / ')}`).join('\n')||'- 无明确声明。';
  return `${agent?'分配给：'+agent+'\n\n':''}仓库：https://github.com/${model.repo}\nIssue：https://github.com/${model.repo}/issues/${issue.number}\n任务：#${issue.number} ${issue.title}\n看板状态：${STATUS[issue.status]}，执行时重新读取 GitHub。\n\n开工前置：\n${depText('hard')}\n\n最终验收条件（不阻止准备/实施）：\n${depText('acceptance')}\n\n环境：${issue.requiredEnvironment.join(' / ')||'以 Issue 验证要求为准'}\n${issue.holdReasons.length?'暂停：'+issue.holdReasons.join('；')+'\n':''}\n执行要求：\n1. 读取 AGENTS.md、最新 Issue、依赖及相关 PR，检查当前 main，避免重复实现；仓库已安装的 Skill 自主发现。\n2. Spec/Plan/设计决定写回 Issue；代码在独立分支/worktree 中经 PR 交付，不能写入 specs/ 或 plans/。\n3. 先证明修改前失败，再验证修改后实际消费路径。不要以字符串、类型或文档存在代替执行。\n4. 区分本地测试、模拟 MCP、真实活字格证据；需要真机的项未执行不得打勾。\n5. 开工前置未满足或明确暂停时不得跳过；验收条件未齐可以准备/实施，但不能关闭本票。\n6. 完整完成本票验收才使用 Closes #${issue.number}，否则 Refs #${issue.number}。不要连带关闭父 Epic/Gate。\n7. 多代理改同一文件须协调接口与 PR 基线，禁止以最后覆盖解决冲突。\n\nIssue 原文（快照；以 GitHub 最新版本为准）：\n${issue.body||'无正文'}`;
}
