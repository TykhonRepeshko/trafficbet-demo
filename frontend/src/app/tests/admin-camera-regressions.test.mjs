import '@angular/compiler';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFile, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createEnvironmentInjector, runInInjectionContext } from '@angular/core';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { BehaviorSubject, Subject, of, throwError } from 'rxjs';
const output = new URL(`.admin-camera-${process.pid}.mjs`, import.meta.url);
const bundle = await build({ stdin: { contents: `export * from './pages/admin-camera.component'; export * from './services/navigation'; export {routes} from './app.routes'; export {ApiService} from './services/api.service'; export {AuthService} from './services/auth.service';`, resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'ts' }, bundle:true, platform:'node', format:'esm', packages:'external', write:false, tsconfigRaw:{compilerOptions:{experimentalDecorators:true,useDefineForClassFields:false}} });
await writeFile(output,bundle.outputFiles[0].text); const {AdminCameraComponent,positiveRouteId,signInDestination,routes,ApiService,AuthService}=await import(output.href); await unlink(output);
const now=Date.now();
const camera=(id=45,extra={})=>({id,title:`Camera ${id}`,city:'Test',locationLabel:'Road',isActive:true,streamType:'hls',...extra});
const market=(id=7007,streamId=45,extra={})=>({id,streamId,title:`Window ${id}`,status:'open',bettingClosesAt:new Date(now-10000).toISOString(),windowStart:new Date(now+20000).toISOString(),windowEnd:new Date(now+50000).toISOString(),...extra});
const detail=(m=market())=>({market:m,snapshot:{mode:'versioned',profileId:39,publishedTitle:m.title,intervalConvention:'[start,end)'},reviews:[],observations:[]});
function harness({id='45',query={round:'7007'},api={}}={}) {
 const calls=[],navigation=[],params=new BehaviorSubject(convertToParamMap({id})),queries=new BehaviorSubject(convertToParamMap(query));
 const service={getStream:(id)=>{calls.push(['camera',id]);return of(camera(id));},adminStreams:()=>of([camera(45,{isActive:false})]),listMarkets:()=>of([market(),market(7008)]),roundReview:id=>{calls.push(['round',id]);return of(detail(market(id)));},liveRound:id=>of({marketId:id,streamId:45,status:'open',live:null}),...api};
 const injector=createEnvironmentInjector([{provide:ApiService,useValue:service},{provide:ActivatedRoute,useValue:{paramMap:params,queryParamMap:queries}},{provide:Router,useValue:{navigate:(...args)=>{navigation.push(args);return Promise.resolve(true);}}}]);
 const component=runInInjectionContext(injector,()=>new AdminCameraComponent());component.ngOnInit();
 return {component,service,calls,navigation,params,queries,destroy:()=>{component.ngOnDestroy();injector.destroy();}};
}

test('camera monitor and exact-round inspector enforce administrator access on direct navigation',()=>{
 for(const path of ['admin/cameras','admin/cameras/:id']) {
  const entry=routes.find(r=>r.path===path);assert.equal(entry.canActivate.length,2);
  for(const role of ['guest','user','admin']) {
   const auth={user:role==='guest'?null:{role},isAdmin:role==='admin'};
   const injector=createEnvironmentInjector([{provide:AuthService,useValue:auth},{provide:Router,useValue:{createUrlTree:(commands,extras)=>({commands,...extras})}}]);
   try {const url='/admin/cameras/45?round=7007#selected-round';const first=runInInjectionContext(injector,()=>entry.canActivate[0]({}, {url}));
    if(role==='guest')assert.deepEqual(first,{commands:['/login'],queryParams:{returnUrl:url}});
    else {assert.equal(first,true);const second=runInInjectionContext(injector,()=>entry.canActivate[1]({}, {url}));if(role==='admin')assert.equal(second,true);else assert.deepEqual(second,{commands:['/login'],queryParams:{returnUrl:url,admin:'required'}});}
   } finally {injector.destroy();}
  }
 }
 assert.equal(routes.find(r=>r.path==='streams').redirectTo,'admin/cameras');
 assert.equal(routes.find(r=>r.path==='streams/:id').canActivate,undefined,'members must retain access to an individual camera and its prediction form');
});

test('sign-in preserves approved exact-round context and rejects open redirects or ambiguous IDs',()=>{
 for(const url of ['/admin/cameras','/admin/cameras#camera-directory','/admin/cameras/45?round=7007#selected-round','/admin/preparation?stream=45&round=7007','/admin/preparation?stream=45&round=7007#round-review','/admin/preparation?stream=45#counting-rules','/admin?tab=markets','/streams/45?round=7007'])assert.equal(signInDestination(url),url);
 for(const url of ['//evil.test','https://evil.test/admin','/admin/../../account','/admin?returnUrl=https://evil.test','/admin/cameras/45?round=1&round=2','/admin/cameras/45?round=1e3','/admin/cameras/45#//evil.test','/admin/cameras/45?round=9007199254740992'])assert.equal(signInDestination(url),'/');
 for(const value of ['0','-1','1e3','45.2','9007199254740992','abc'])assert.equal(positiveRouteId(value),undefined);
 assert.equal(positiveRouteId('45'),45);
});

test('locked and then settled requested round remains selected as new rounds arrive',()=>{
 let selected=market(),rows=[market(7008)];const h=harness({api:{listMarkets:()=>of(rows),roundReview:id=>of(detail(selected))}});
 try {assert.equal(h.component.selected.id,7007);assert.equal(h.component.phase(h.component.selected),'locked');assert.equal(h.component.rounds.some(r=>r.id===7007),true);
  rows=[market(7009)];selected={...selected,status:'settled',actualCount:33};h.component.load(true);
  assert.equal(h.component.selected.id,7007);assert.equal(h.component.selected.actualCount,33);assert.equal(h.component.snapshot.profileId,39);assert.deepEqual(h.navigation,[]);
 }finally{h.destroy();}
});

test('an expired requested round cannot silently select the next accepting prediction round',()=>{
 const h=harness({api:{roundReview:()=>of(detail(market(7007,45,{status:'void',voidReason:'Missing source footage'})))}});
 try {assert.equal(h.component.selected.id,7007);assert.equal(h.component.selected.status,'void');assert.equal(h.component.selectedId,7007);}finally{h.destroy();}
});

test('a round from another camera is rejected without displaying foreign rules or count',()=>{
 const h=harness({api:{roundReview:()=>of(detail(market(7007,49)))}});
 try {assert.match(h.component.error,/another camera/i);assert.equal(h.component.selected,undefined);assert.equal(h.component.snapshot,undefined);assert.equal(h.component.processedCount,undefined);}finally{h.destroy();}
});

test('invalid and duplicate address parameters make no camera or round request',()=>{
 for(const config of [{id:'0'},{query:{round:'wrong'}},{query:{round:['7007','7008']}}]) {
  const h=harness(config);try{assert.match(h.component.error,/invalid/i);h.component.load();assert.deepEqual(h.calls,[]);}finally{h.destroy();}
 }
});

test('route changes cancel in-flight detail loads and late responses cannot replace the selected camera',()=>{
 const old=new Subject();const h=harness({api:{roundReview:id=>id===7007?old:of(detail(market(id,49))),liveRound:id=>of({marketId:id,streamId:49,live:null})}});
 try {assert.equal(old.observed,true);h.params.next(convertToParamMap({id:'49'}));h.queries.next(convertToParamMap({round:'7009'}));assert.equal(old.observed,false);
  old.next(detail());old.complete();assert.equal(h.component.stream.id,49);assert.equal(h.component.selected.id,7009);assert.equal(h.component.selected.streamId,49);
  h.component.selectRound(market(9999,45));assert.deepEqual(h.navigation,[]);
  h.component.selectRound(market(7009,49));assert.deepEqual(h.navigation[0],[['/admin/cameras',49],{queryParams:{round:7009},fragment:'selected-round'}]);
 }finally{h.destroy();}
});

test('archived camera history loads without pretending that its live broadcast is available',()=>{
 const h=harness({api:{getStream:()=>throwError(()=>({status:404})),roundReview:()=>of(detail(market(7007,45,{status:'settled',actualCount:12})))}});
 try{assert.equal(h.component.stream.isActive,false);assert.equal(h.component.selected.actualCount,12);assert.equal(h.component.error,'');}finally{h.destroy();}
});

test('a forbidden camera response cannot fall back to privileged catalog data',()=>{
 let fallback=false;const h=harness({api:{getStream:()=>throwError(()=>({status:403})),adminStreams:()=>{fallback=true;return of([]);}}});
 try{assert.equal(fallback,false);assert.ok(h.component.error);assert.equal(h.component.stream,undefined);}finally{h.destroy();}
});

test('live progress from a different round or camera never appears in the selected round count',()=>{
 const h=harness({api:{liveRound:()=>of({marketId:7007,streamId:49,live:{vehicleCount:123}})}});
 try{assert.equal(h.component.processedCount,undefined);}finally{h.destroy();}
});

test('camera history bounds rendered rows while preserving an older selected round',()=>{
 const rows=Array.from({length:150},(_,i)=>market(8000+i,45,{windowStart:new Date(now+i*60000).toISOString()}));
 const h=harness({api:{listMarkets:()=>of(rows),roundReview:()=>of(detail(market(7007,45,{status:'settled',actualCount:45})))}});
 try{assert.equal(h.component.rounds.length,31);assert.equal(h.component.rounds[0].id,7007);assert.equal(h.component.rounds[1].id,8149);assert.equal(h.component.selected.actualCount,45);}finally{h.destroy();}
});
