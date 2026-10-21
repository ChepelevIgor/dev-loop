// Execute the actual report script with a tiny DOM fixture; no third-party runtime.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const template = fs.readFileSync('skills/sim-verify-task/templates/report.html', 'utf8');
const script = template.match(/<script>([\s\S]*?)<\/script>/)[1];
const tasks = [
  {task_id:'T1',status:'not-implemented',title:'<img src=x onerror=alert(1)>',criteria:[{before:'runs/1/before/x" onerror="alert(1).png',text:'<script>alert(1)</script>'}]},
  {task_id:'T2',status:'partial',criteria:[{before:'data:text/html,<script>alert(1)</script>',after:'../../outside.png'}]},
  {task_id:'T5',status:'pending',title:'Loop',criteria:[],loop:{status:'blocked',stage:'BRIEF',rounds:0,last_error:'business review: product: Which plan <b>gets</b> it?'},
   brief:{metric:null,summary:'Users keep their name',dod:['Name survives a restart'],cases:[{given:'a saved name',when:'the app restarts',then:'the name is shown'}],gaps:[{kind:'product',text:'Which plan?',blocking:true}]},
   plan:'# Solution <script>x</script>',qa:{author:'codex',independent:true,cases:[{title:'Restart keeps name',criterion:'Name survives a restart',given:'a',when:'b',then:'c',steps:['Open profile']}]}},
];
function setup(token, data=tasks) {
  const elements = new Map();
  const context = vm.createContext({
    URL, Blob, setTimeout,
    window:{open:()=>({opener:null,closed:false,location:{replace(){}},close(){}})},
    document:{createElement:()=>({}),querySelector:()=>({textContent:'body{color:black}'}),querySelectorAll:()=>[],getElementById:(id)=>{
      if(id==='a'&&!elements.get('main')?.innerHTML.includes('id="a"')) return null;
      if(!elements.has(id)) elements.set(id,{innerHTML:'',textContent:'',value:'',disabled:false,hidden:true,appendChild(child){this.child=child;}});
      return elements.get(id);
    }},
    fetch:async()=>({ok:true,json:async()=>[],text:async()=>''}),
  });
  vm.runInContext(script.replace('/*__DATA__*/[]',JSON.stringify(data)).replace("/*__TOKEN__*/''",JSON.stringify(token))+'\nglobalThis.report = APP;',context);
  return {context,elements};
}
(async()=>{
  const {context,elements}=setup('test-token');
  await new Promise(resolve=>setImmediate(resolve));
  context.report.render(0);
  let html=elements.get('main').innerHTML;
  assert.ok(!html.includes('value="retest"'));
  assert.ok(!html.includes('value="pr"'));
  assert.ok(html.includes('%22%20onerror%3D%22'));
  assert.ok(!html.includes('<img src=x onerror='));
  assert.ok(!html.includes('<script>alert(1)'));
  assert.ok(!html.includes('undefined.png'));
  context.report.render(1);
  html=elements.get('main').innerHTML;
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('value="retest"'));
  // Completion from a previously selected task must not alter the new task's button.
  let resolveSend;
  context.fetch=()=>new Promise(resolve=>{resolveSend=resolve;});
  context.document.getElementById('a').value='execute';
  const oldButton=elements.get('s'), oldStatus=context.document.getElementById('st');
  const send=oldButton.onclick();
  assert.equal(oldButton.disabled,true);
  elements.delete('s');elements.delete('st');context.report.render(0);
  const newButton=elements.get('s');
  resolveSend({ok:true});await send;
  assert.equal(newButton.disabled,false);
  assert.equal(oldButton.textContent,'In progress');
  assert.ok(oldStatus.textContent.includes('Sent'));
  // the stages before the code and the waiting question; the button answers instead of offering other actions
  context.report.render(2);
  html=elements.get('main').innerHTML;
  for (const part of ['Business review','not defined','product decision · blocks the work','Technical solution','QA cases','by codex · independent','Restart keeps name','Waiting for you','Your answer','>Dev Loop</button>']) assert.ok(html.includes(part), part);
  assert.ok(!html.includes('<script>x'), 'the plan is escaped');
  assert.ok(!html.includes('<b>gets</b>'), 'the question is escaped');
  assert.ok(!html.includes('id="a"'), 'a blocked task only takes an answer');
  // Malformed stage output must leave the blocking error and answer button usable.
  const validCase={title:'Valid QA case',given:'a user',when:'they open it',then:'it works',criterion:'It works'};
  for (const stages of [
    {brief:{summary:'Brief',gaps:[null],cases:[validCase]}},
    {brief:{summary:'Brief',gaps:[],cases:[null,validCase]}},
    {qa:{author:'self',independent:false,cases:[null,validCase]}},
    {brief:{gaps:[false,12,[],null],cases:'invalid'},qa:{cases:{}}},
  ]) {
    const broken=setup('test-token',[{task_id:'BAD',status:'pending',criteria:[],
      loop:{stage:'BRIEF',status:'blocked',last_error:'Invalid stage output'},...stages}]);
    await new Promise(resolve=>setImmediate(resolve));
    assert.doesNotThrow(()=>broken.context.report.render(0));
    const content=broken.elements.get('main').innerHTML;
    assert.ok(content.includes('Invalid stage output'));
    assert.ok(content.includes('Some stage data is invalid'));
    assert.match(content, /id="s" >Dev Loop/);
    assert.ok(!content.includes('Nothing missing.'));
    if(stages.qa?.cases?.includes?.(validCase)) assert.ok(content.includes('Valid QA case'));
    let answer;
    broken.context.fetch=async(path,opts)=>{answer=JSON.parse(opts.body);return {ok:true};};
    broken.context.document.getElementById('c').value='Please retry the stage';
    await broken.elements.get('s').onclick();
    assert.deepEqual(answer,{task_id:'BAD',comment:'Please retry the stage',action:'execute'});
    assert.equal(broken.elements.get('s').textContent,'In progress');
  }
  const offline=setup('');
  await new Promise(resolve=>setImmediate(resolve));
  offline.context.report.render(0);
  assert.ok(offline.elements.get('main').innerHTML.includes('View only'));
  assert.match(offline.elements.get('main').innerHTML, /id="s" disabled/);
  // Preparing an artifact is local and does not enqueue or upload anything.
  offline.context.fetch=()=>{throw new Error('Unexpected network call');};
  offline.elements.get('artifact').onclick();
  assert.equal(offline.elements.get('artifact-panel').hidden,false);
  const portableTask={task_id:'T3',title:'Only this task',criteria:[{text:'</script><script>attack()</script>',after:'data:image/png;base64,YWJj'}]};
  const portable=await offline.context.report.portableTask(portableTask);
  const exported=context.report.portableDocument(portable);
  assert.ok(!exported.includes('test-token'));
  assert.ok(!exported.includes('onerror=alert(1)'));
  assert.ok(!exported.includes('</script><script>attack()'));
  assert.ok(exported.includes('data:image/png;base64,YWJj'));
  assert.ok(exported.includes('Open in Claude Artifact'));
  // Reopened downloads execute with one task and no authenticated network access.
  const reopened=setup('');
  reopened.context.fetch=()=>{throw new Error('Export must stay offline');};
  vm.runInContext('(function(){'+exported.match(/<script>([\s\S]*?)<\/script>/)[1]+'})()',reopened.context);
  await new Promise(resolve=>setImmediate(resolve));
  assert.match(reopened.elements.get('meta').textContent,/^1 tasks/);
  assert.ok(reopened.elements.get('main').innerHTML.includes('Only this task'));
  assert.ok(!reopened.elements.get('list').innerHTML.includes('T1'));
  assert.ok(context.report.artifactPrompt({task_id:'T3',artifact_url:'https://claude.ai/code/artifact/00000000-0000-0000-0000-000000000001'}).startsWith('Update the existing Claude artifact'));
  assert.ok(!context.report.artifactPrompt({task_id:'T3',artifact_url:'https://user:secret@claude.ai/a'}).includes('secret'));
  await assert.rejects(()=>offline.context.report.portableTask({task_id:'T4',criteria:[{after:'runs/1/after/a.png'}]}),/embedded task page/);
  await assert.rejects(()=>context.report.portableTask({task_id:'T4',criteria:[{after:'https://evil.example/a.png'}]}),/Invalid screenshot/);
  // A real returned link opens only after publication; requests contain one ID.
  const live=setup('test-token');await new Promise(resolve=>setImmediate(resolve));
  const nativeURL='https://claude.ai/code/artifact/00000000-0000-0000-0000-000000000001';
  let opened='', sent;
  live.context.window.open=()=>({closed:false,location:{replace(url){opened=url;}},close(){}});
  live.context.fetch=async(path,opts)=>{
    if(opts.method==='POST'){sent=JSON.parse(opts.body);return {ok:true,json:async()=>({id:'request-1',status:'queued'})};}
    return {ok:true,json:async()=>({id:'request-1',status:'published',url:nativeURL})};
  };
  await live.elements.get('artifact').onclick();
  assert.deepEqual(sent,{task_id:'T1'});assert.equal(opened,nativeURL);
  assert.equal(live.elements.get('export-status').child.href,nativeURL);
  // Reopening the same artifact needs no server or duplicate publish.
  live.context.fetch=()=>{throw new Error('Duplicate publication');};
  live.context.window.open=url=>{opened=url;};opened='';
  await live.elements.get('artifact').onclick();assert.equal(opened,nativeURL);
  const unavailable=setup('test-token');await new Promise(resolve=>setImmediate(resolve));
  unavailable.context.fetch=async()=>({ok:false,json:async()=>({error:'No Claude session is listening.'})});
  await unavailable.elements.get('artifact').onclick();
  assert.match(unavailable.elements.get('export-status').textContent,/No Claude session/);
  assert.equal(unavailable.elements.get('artifact').disabled,false);
  // An old aggregate page picks up a link saved since it was built, without publishing again.
  const stale=setup('test-token');await new Promise(resolve=>setImmediate(resolve));
  stale.context.window.open=()=>({closed:false,location:{replace(url){opened=url;}}});
  stale.context.fetch=async(path,opts)=>{
    assert.notEqual(opts.method,'POST');
    return {ok:true,json:async()=>({artifact_url:nativeURL})};
  };
  opened='';await stale.elements.get('artifact').onclick();assert.equal(opened,nativeURL);
  console.log('Report UI: escaping, queue controls, offline export, task isolation and explicit artifact handoff passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
