import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildModel, parseRelations, references, isDone, layout, promptFor, REPO } from './model.mjs';

function item(number, options={}) {
  const { depends=[], acceptance=[], board={}, body, state='open', reason, labels=[], ...rest }=options;
  const data={schemaVersion:1,kind:'task',track:'runtime',parent:81,dependsOn:depends,acceptanceDependsOn:acceptance,externalBlockers:[],...board};
  return {number,title:`Task ${number}`,state,state_reason:reason??(state==='closed'?'completed':null),labels,body:body??`Parent: #81\nDepends on: ${depends.map(x=>'#'+x).join(', ')||'none'}.\nAcceptance depends on: ${acceptance.map(x=>'#'+x).join(', ')||'none'}.\n<!-- fgc-board\n${JSON.stringify(data)}\n-->`,...rest};
}
const model=(...items)=>buildModel(items);
const get=(items,n)=>model(...items).byId.get(n);

test('structured empty dependency list starts without requiring a ready label',()=>{
  assert.equal(get([item(82)],82).status,'ready');
});
test('hard dependencies block until completed, then recompute without a label write',()=>{
  const next=item(83,{depends:[82],labels:['status:blocked']});
  assert.equal(get([item(82),next],83).status,'blocked');
  const m=model(item(82,{state:'closed'}),next);
  assert.equal(m.byId.get(83).status,'ready');
  assert.ok(m.warnings.some(w=>w.kind==='label'));
});
test('acceptance dependencies never prevent start, but prevent relationship closure',()=>{
  const i=get([item(82),item(83,{acceptance:[82]})],83);
  assert.equal(i.status,'ready');assert.equal(i.canStart,true);assert.equal(i.canClose,false);
});
test('required environment and needs-validation describe allocation, not a fabricated pause',()=>{
  const i=get([item(82,{labels:['status:needs-validation'],board:{requiredEnvironment:['forguncy-real','mcp']}})],82);
  assert.equal(i.status,'ready');assert.equal(i.needsValidation,true);
});
test('explicit nonempty manual hold pauses an otherwise-ready task',()=>{
  const i=get([item(82,{board:{manualHold:'等待可丢弃工程访问权限'}})],82);
  assert.equal(i.status,'paused');assert.match(i.holdReasons[0],/权限/);
});
test('only active external blockers pause; resolved records remain inspectable',()=>{
  assert.equal(get([item(82,{board:{externalBlockers:[{active:false,reason:'旧权限已恢复'}]}})],82).status,'ready');
  assert.equal(get([item(82,{board:{externalBlockers:[{active:true,reason:'管理员需授权'}]}})],82).status,'paused');
});
test('legacy blocked label without an explanation is never silently erased',()=>{
  const i=get([item(52,{body:'Depends on: none.',labels:['status:blocked']})],52);
  assert.equal(i.status,'paused');
});
test('metadata conflicts, missing declarations and unsupported schemas fail closed',()=>{
  for(const options of [
    {board:{dependsOn:[9]}},
    {board:{schemaVersion:99}},
    {board:{dependOn:[]}},
    {board:{manualHold:''}},
    {board:{dependsOn:[9,9]}},
    {board:{externalBlockers:[{reason:'missing active flag'}]}},
    {board:{requiredEnvironment:['']}},
  ]) assert.equal(get([item(9,{state:'closed'}),item(82,options)],82).status,'review');
  const body='<!-- fgc-board\n'+JSON.stringify({schemaVersion:1,kind:'task',dependsOn:[],acceptanceDependsOn:[]})+'\n-->';
  assert.equal(get([item(82,{body})],82).status,'review');
});
test('malformed, duplicated and unterminated metadata blocks are visible errors',()=>{
  const valid=item(82).body;
  for(const body of ['<!-- fgc-board\n{bad}\n-->','<!-- fgc-board\n{}',valid+'\n'+valid])
    assert.equal(get([item(82,{body})],82).status,'review');
});
test('Parent, Related, prose, blockquotes and fenced examples are not dependencies',()=>{
  const body='Parent: #3\nRelated: #9, PR #47\nText cites #20.\n> Depends on: #31\n```text\nDepends on: #32\n```\n- [ ] Depends on: #33\nDepends on: none.';
  assert.deepEqual(parseRelations(item(52,{body})).edges,[]);
});
test('#52 provenance with an already merged PR never becomes an Issue dependency',()=>{
  const body='Depends on: — (the implementation this corrects is already merged: #9, via PR #47).';
  const parsed=parseRelations(item(52,{body}));
  assert.deepEqual(parsed.edges,[]);assert.ok(parsed.warnings.length); // ambiguous old syntax is reported, not guessed
  assert.deepEqual(parseRelations(item(52,{body:'Depends on: none.\nRelated implementation: #9 via PR #47.'})).edges,[]);
});
test('#17 consumes its available spec baseline without waiting for its own evidence producer',()=>{
  const body='Depends on: #8\nCompiler-aware probes also depend on: #7\nSpecification baseline: #16, implemented by merged PR #45.';
  const edges=parseRelations(item(17,{body})).edges;
  assert.deepEqual(edges.map(e=>[e.from,e.kind]),[[8,'hard'],[7,'conditional']]);
});
test('#67 outgoing dependency takes the explicit prefix, not later historical references',()=>{
  const body='- Depends on #23 — the harness. #23 stays open for evidence.\n- Blocks #25 — clean checkout, previously spelled with a flag #22 does not have.';
  assert.deepEqual(parseRelations(item(67,{body})).edges.map(e=>[e.from,e.to]),[[23,67],[67,25]]);
});
test('parenthetical indirect dependencies do not duplicate hard edges',()=>{
  assert.deepEqual(parseRelations(item(7,{body:'Depends on: #6 (therefore indirectly #4 and #5)'})).edges.map(e=>e.from),[6]);
});
test('conditional and final-only legacy relationships retain their distinct meaning',()=>{
  const edges=parseRelations(item(26,{body:'Depends on: #5, #19 for final target locator semantics.\nReal-project closure also depends on: #20 (final validation only).'})).edges;
  assert.ok(edges.every(e=>e.kind==='acceptance'));
});
test('not_planned, duplicate and unspecified closures do not satisfy hard prerequisites',()=>{
  for(const reason of ['not_planned','duplicate','']) {
    const i=get([item(82,{state:'closed',reason}),item(83,{depends:[82]})],83);
    assert.equal(i.status,'blocked');assert.equal(isDone({state:'closed',state_reason:reason}),false);
  }
});
test('a completed issue remains completed even if historical metadata has a warning',()=>{
  assert.equal(get([item(82,{state:'closed',board:{schemaVersion:2}})],82).status,'done');
});
test('missing hard references are data errors; missing acceptance references only withhold closure',()=>{
  assert.equal(get([item(82,{depends:[999]})],82).status,'review');
  const i=get([item(82,{acceptance:[999]})],82);
  assert.equal(i.status,'ready');assert.equal(i.canClose,false);
});
test('cross-repository dependencies are never mistaken for same-number local Issues',()=>{
  assert.deepEqual(references('#5, Another/Repo#5, PR #7'),[5,'Another/Repo#5']);
  const m=model(item(5,{state:'closed'}),item(82,{body:'Depends on: Another/Repo#5'}));
  assert.equal(m.byId.get(82).status,'review');
});
test('PR-only numbered references are diagnosed instead of inventing an unfinished Issue',()=>{
  const m=model(item(82,{depends:[47]}),{number:47,state:'closed',body:'',pull_request:{merged_at:'2026-09-20'}});
  assert.equal(m.issues.length,1);assert.equal(m.byId.get(82).status,'review');assert.ok(m.warnings.some(w=>w.kind==='pr-reference'));
});
test('an assignee alone is not started; an open closing PR is',()=>{
  const target=item(82,{assignees:[{login:'MangMax'}]});assert.equal(get([target],82).status,'ready');
  const pr={number:108,state:'open',body:'Closes #82',pull_request:{merged_at:null}};
  assert.equal(get([target,pr],82).status,'active');
  assert.equal(get([target,{...pr,body:'Refs #82'}],82).status,'ready');
  assert.equal(get([target,{...pr,state:'closed'}],82).status,'ready');
});
test('PR prose and fenced closing examples do not mark a task active',()=>{
  const pr={number:108,state:'open',body:'This discusses #82\n```md\nCloses #82\n```',pull_request:{}};
  assert.equal(get([item(82),pr],82).status,'ready');
});
test('open PR cannot override genuine hard blockers',()=>{
  const pr={number:108,state:'open',body:'Closes #83',pull_request:{}};
  assert.equal(get([item(82),item(83,{depends:[82]}),pr],83).status,'blocked');
});
test('gates and epics are not ordinary implementation-ready queue items',()=>{
  const m=model(item(81,{board:{kind:'epic'}}),item(107,{board:{kind:'gate'}}));
  assert.equal(m.byId.get(81).status,'epic');assert.equal(m.byId.get(107).status,'gate');
});
test('native relations combine with metadata; inconsistent additional native edges are errors',()=>{
  const items=[item(82),item(83,{depends:[82]})];
  const matching=buildModel(items,{83:[{number:82}]});
  assert.equal(matching.byId.get(83).status,'blocked');assert.equal(matching.edges.length,1);
  const mismatch=buildModel(items,{83:[{number:999}]});assert.equal(mismatch.byId.get(83).status,'review');
});
test('unread native data is never counted as an empty dependency list',()=>{
  assert.equal(buildModel([item(82)],{},[82]).byId.get(82).status,'review');
});
test('hard cycles and self-loops are errors, not layout recursion',()=>{
  const m=model(item(82,{depends:[83]}),item(83,{depends:[82]}),item(84,{depends:[84]}));
  assert.equal(m.cycles.length,2);for(const i of m.issues)assert.equal(i.status,'review');
  assert.ok(Number.isFinite(layout(m).height));
});
test('acceptance back-references do not create start cycles',()=>{
  const m=model(item(82,{acceptance:[83]}),item(83,{depends:[82]}));
  assert.equal(m.cycles.length,0);assert.equal(m.byId.get(82).status,'ready');
});
test('long dependency chains can be analyzed without recursive stack exhaustion',()=>{
  const items=Array.from({length:1200},(_,k)=>item(k+1,{depends:k?[k]:[]}));
  const m=buildModel(items);assert.equal(m.cycles.length,0);assert.equal(m.byId.get(1200).level,1199);
});
test('layout projects visible levels rather than carrying hidden history gaps',()=>{
  const m=model(item(82),item(83,{depends:[82]}),item(84,{depends:[83]}));
  const l=layout(m,[m.byId.get(84)]);assert.equal(l.positions.get(84).col,0);
});
test('handoff includes start and acceptance conditions, environment and original specification',()=>{
  const m=model(item(82),item(83,{acceptance:[82],board:{requiredEnvironment:['forguncy-real']}}));
  const text=promptFor(m,m.byId.get(83),'Codex-01');
  for(const required of ['AGENTS.md','Spec/Plan','Closes #83','最终验收条件','forguncy-real','Issue 原文','Codex-01'])assert.ok(text.includes(required));
});
test('same input produces the same graph and no source Issue mutation',()=>{
  const items=[item(82),item(83,{depends:[82]})],before=JSON.stringify(items);
  const a=model(...items),b=model(...items);
  assert.deepEqual(a.edges,b.edges);assert.equal(JSON.stringify(items),before);assert.equal(REPO,'Mang-X/forguncy-react-workspace');
});
