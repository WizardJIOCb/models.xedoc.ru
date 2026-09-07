import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../apps/studio-web/src/main.js', import.meta.url), 'utf8');
const code = ['libraryMotions', 'selectedMotion', 'selectedUrl', 'renderMotions', 'renderPlaygroundComments'].map(name => {
  const match = source.match(new RegExp(`^function ${name}\\([^]*?^}`, 'm'));
  // selectedMotion is deliberately a one-line pure selector.
  return name === 'selectedMotion' ? source.match(/^function selectedMotion\(.*$/m)[0] : match[0];
}).join('\n');
const elements = new Map(['playground-motion', 'motion-library-status', 'comments'].map(id=>[id,{}]));
const mounted = [], disposed = [];
const job = {id:'one',status:'complete',visibility:'private',artifacts:{modelUrl:'/source.glb',riggedUrl:'/rig.glb',motionLibraryUrl:'/library/rig-a/'},rig:{available:true},motions:[{id:'own',status:'complete',glbUrl:'/own.glb',frames:60,prompt:'My motion'}]};
const state = {motionLibrary:[{id:'abcd',prompt:'Wave <then> stop',frames:90,fps:30}],motionLibraryReady:true,selectedMotion:'base',motionSignature:'',commentsModelId:null,disposeComments:null,demo:false};
const context = vm.createContext({state,isPlayground:true,isShared:false,publicModelId:null,
  $:id=>elements.get(id),escape:value=>String(value).replaceAll('<','&lt;').replaceAll('>','&gt;'),encodeURIComponent,
  sourceView:()=>false,hasRig:j=>!!j?.rig?.available,editingMesh:()=>false,artifactUrl:j=>j?.artifacts?.riggedUrl,
  mountComments:(element,id)=>{mounted.push(id);return()=>disposed.push(id);},
});
vm.runInContext(code,context);
context.renderMotions(job);
assert.match(elements.get('playground-motion').innerHTML,/^<option value="">Ходьба по кругу<\/option>/);
assert.match(elements.get('playground-motion').innerHTML,/Wave &lt;then&gt; stop · 3 с/);
assert.equal(elements.get('playground-motion').disabled,false);
assert.equal(context.selectedUrl(job),'/rig.glb');
state.selectedMotion='library:abcd';
assert.equal(context.selectedUrl(job),'/library/rig-a/abcd/animated.glb');
state.selectedMotion='library:missing';
assert.equal(context.selectedUrl(job),undefined,'Missing library motion must not silently play walking');
context.renderMotions(job);
assert.match(elements.get('playground-motion').innerHTML,/value="library:missing" disabled>Движение недоступно/);
state.selectedMotion='own';
assert.equal(context.selectedUrl(job),'/own.glb');

const unrigged = {...job, rig:{available:false}, artifacts:{modelUrl:'/source.glb'}, motions:[]};
state.selectedMotion='base';
context.renderMotions(unrigged);
assert.equal(elements.get('playground-motion').disabled,false,'The library can be browsed before rigging');
assert.match(elements.get('playground-motion').innerHTML,/value="library:abcd" disabled/);
assert.match(elements.get('motion-library-status').textContent,/после создания скелета/);
assert.equal(elements.get('motion-library-status').hidden,false);
state.selectedMotion='library:abcd';
assert.equal(context.selectedMotion(unrigged),undefined,'Do not construct a motion URL before a rig exists');
context.renderMotions(job);
assert.equal(elements.get('playground-motion').innerHTML.includes('value="library:abcd" disabled'),false,'A completed rig unlocks playback');

context.renderPlaygroundComments(job);
context.renderPlaygroundComments(job);
assert.deepEqual(mounted,['one'],'Polling must keep the composer and its draft');
context.renderPlaygroundComments({...job,id:'two'});
assert.deepEqual(mounted,['one','two']);
assert.deepEqual(disposed,['one']);
context.isShared=true;
context.renderPlaygroundComments(job);
assert.equal(elements.get('comments').hidden,true,'A private shared link does not expose owner comments');
context.publicModelId='one';
context.renderPlaygroundComments({...job,visibility:'public'});
assert.equal(elements.get('comments').hidden,false);
state.demo=true;
context.renderPlaygroundComments(job);
assert.equal(elements.get('comments').hidden,true);
console.log('PASS: base-first motion options, library/current-rig URLs, missing source, comments owner/public/private lifecycle');
