'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {testUnblockAllowed,testDirectVoeAllowed}=require('./embed-test-policy');
const {confirmedStremioEmbedFailure}=require('./provider-compat');
test('unblock requires an explicit switch and exact permitted hostname',()=>{
  const on={BOMBUJ_TEST_UNBLOCK_EMBEDS:'1'};
  for(const host of ['bysekoze.com','vsembed.ru','mixdrop.ag','mxdrop.click']){
    assert.equal(testUnblockAllowed(`https://${host}/e/test`,{}),false);
    assert.equal(testUnblockAllowed(`https://${host}/e/test`,on),true);
  }
  for(const url of ['https://mixdrop.ag.evil.test/e/test','https://evil.test','https://voe.sx/e/test','http://mixdrop.ag/e/test','https://u:p@mixdrop.ag/e/test'])assert.equal(testUnblockAllowed(url,on),false);
});
test('preflight never publishes HTML embeds even with diagnostic switches',async()=>{
  const fs=require('node:fs'),vm=require('node:vm'),{createRequire}=require('node:module');
  const file=require.resolve('./preflight-front.js'),local=createRequire(file),mod={exports:{}};
  const env={BOMBUJ_TEST_UNBLOCK_EMBEDS:'1'};
  vm.runInNewContext(fs.readFileSync(file,'utf8')+'\nmodule.exports={preflightStreams};',{
    require:p=>p==='http'?{createServer:()=>({listen(){}})}:p==='./filtered-front.js'?{}:p==='./embed-test-policy.js'?{testUnblockAllowed:u=>testUnblockAllowed(u,env),testDirectVoeAllowed:u=>testDirectVoeAllowed(u,env)}:local(p),
    module:mod,process:{env},console:{log(){},error(){}},URL,Headers,TextDecoder,AbortSignal,
    global:{fetch:()=>{throw Error('unexpected network request');}}
  });
  const streams=['bysekoze.com','vsembed.ru','mixdrop.ag'].map(host=>({name:host,externalUrl:`https://${host}/e/test`}));
  const out=await mod.exports.preflightStreams({streams},'movie','tt0133093');
  assert.equal(out.streams.length,0);
});
test('owner show-all mode still publishes only direct video URLs',async()=>{
  const fs=require('node:fs'),vm=require('node:vm'),{createRequire}=require('node:module');
  const file=require.resolve('./preflight-front.js'),local=createRequire(file),mod={exports:{}};
  const env={BOMBUJ_SHOW_ALL_SOURCES:'1'};
  vm.runInNewContext(fs.readFileSync(file,'utf8')+'\nmodule.exports={preflightStreams};',{
    require:p=>p==='http'?{createServer:()=>({listen(){}})}:p==='./filtered-front.js'?{}:local(p),
    module:mod,process:{env},console:{log(){},error(){}},URL,Headers,TextDecoder,AbortSignal,
    global:{fetch:()=>{throw Error('owner show-all mode must not preflight external players');}}
  });
  const streams=['mixdrop.ag','byse.sx','player.videasy.to','some-player.example'].map(host=>({name:host,externalUrl:`https://${host}/e/test`}));
  streams.unshift({name:'direct',url:'https://cdn.example/video.m3u8'});
  const out=await mod.exports.preflightStreams({streams},'movie','tt0468569');
  assert.equal(out.streams.length,1);
  assert.equal(out.streams[0].url,'https://cdn.example/video.m3u8');
});
test('owner show-all mode resolves Mixdrop without publishing its web player',async()=>{
  const fs=require('node:fs'),vm=require('node:vm'),{createRequire}=require('node:module');
  const frontFile=require.resolve('./front.js'),frontRequire=createRequire(frontFile);
  let requests=0;
  const globalObj={fetch:async()=>{requests++;return new Response('fixture');}};
  vm.runInNewContext(fs.readFileSync(frontFile,'utf8'),{
    require:p=>p==='http'?{createServer:()=>({listen(){}})}:p==='./bootstrap.js'?{}:frontRequire(p),
    process:{env:{BOMBUJ_SHOW_ALL_SOURCES:'1'}},console:{log(){},error(){}},URL,global:globalObj,AbortSignal
  });
  await globalObj.fetch('https://mixdrop.ag/e/test',{headers:{Accept:'text/html'}});
  assert.equal(requests,1);

  const file=require.resolve('./index.js'),local=createRequire(file),mod={exports:{}};
  const sdk={addonBuilder:class{defineCatalogHandler(){}defineStreamHandler(){}getInterface(){return{}}},serveHTTP(){}};
  vm.runInNewContext(fs.readFileSync(file,'utf8'),{
    require:p=>p==='stremio-addon-sdk'?sdk:local(p),module:mod,
    process:{env:{BOMBUJ_SHOW_ALL_SOURCES:'1'}},console:{log(){},error(){},warn(){}},
    URL,URLSearchParams,AbortSignal,Buffer,Uint8Array,
    fetch:async()=>new Response('<script>MDCore.wurl="https://mxcontent.net/fixture.mp4";</script>')
  });
  const embed='https://mixdrop.ag/e/test';
  const out=await mod.exports.playersToStreams([{provider:'Mixdrop',language:'CZ dabing',resolvedUrl:embed}],
    'https://www.bombuj.si/online-film-fixture');
  assert.equal(out.length,1);
  assert.equal(out[0].url,'https://mxcontent.net/fixture.mp4');
});
test('filter exclusion is disabled only while the diagnostic switch is set',()=>{
  const old=process.env.BOMBUJ_TEST_UNBLOCK_EMBEDS;
  try{
    delete process.env.BOMBUJ_TEST_UNBLOCK_EMBEDS;
    assert(confirmedStremioEmbedFailure('https://vsembed.ru/embed/movie'));
    process.env.BOMBUJ_TEST_UNBLOCK_EMBEDS='1';
    assert.equal(confirmedStremioEmbedFailure('https://vsembed.ru/embed/movie'),null);
    assert(confirmedStremioEmbedFailure('https://player.videasy.net/movie/603'));
  }finally{if(old===undefined)delete process.env.BOMBUJ_TEST_UNBLOCK_EMBEDS;else process.env.BOMBUJ_TEST_UNBLOCK_EMBEDS=old;}
});
test('VOE direct test is separate and limited to the two expected hosts',()=>{
  const env={BOMBUJ_TEST_DIRECT_VOE:'1'};
  assert.equal(testDirectVoeAllowed('https://voe.sx/e/test',{}),false);
  assert.equal(testDirectVoeAllowed('https://voe.sx/e/test',env),true);
  assert.equal(testDirectVoeAllowed('https://voe2.sx/e/test',env),true);
  for(const u of ['https://voe.sx.evil.test/e/test','https://mixdrop.ag/e/test','http://voe.sx/e/test'])assert.equal(testDirectVoeAllowed(u,env),false);
});
test('VOE is web-only with zero video resolver fetches', async () => {
  const fs=require('node:fs'),vm=require('node:vm'),{createRequire}=require('node:module');
  const file=require.resolve('./index'),local=createRequire(file),mod={exports:{}};
  const sdk={addonBuilder:class{defineCatalogHandler(){}defineStreamHandler(){}getInterface(){return{}}},serveHTTP(){}};
  let calls=0;
  vm.runInNewContext(fs.readFileSync(file,'utf8'),{
    require:p=>p==='stremio-addon-sdk'?sdk:local(p),module:mod,
    process:{env:{BOMBUJ_DIRECT_VOE:'1'}},console:{log(){},error(){},warn(){}},
    URL,URLSearchParams,AbortSignal,Buffer,Uint8Array,
    fetch:async()=>{calls++;throw Error('unexpected VOE fetch');}
  });
  const embed='https://voe.sx/e/fixture?subtitles='+encodeURIComponent('CZSK;cs;https://www.bombuj.si/titulky/cz.vtt');
  const result=await mod.exports.playersToStreams([{provider:'voe2.sx',language:'CZ dabing',resolvedUrl:embed}],
    'https://www.bombuj.si/online-film-fixture');
  assert.equal(result.length,1);assert.equal(result[0].externalUrl,embed);
  assert.equal(result[0].url,undefined);assert.equal(result[0].subtitles[0].lang,'ces');assert.equal(calls,0);
});
test('VOE subtitles use explicit language codes and reject malformed source parameters',()=>{
  const {voeSubtitles}=require('./resolvers/voe-subtitles');
  const base='https://voe.sx/e/fixture?subtitles=';
  assert.equal(voeSubtitles(base+encodeURIComponent('Slovak;sk;https://cdn.example/sk.vtt'),0)[0].lang,'slk');
  for(const input of ['CZSK;xx;https://cdn.example/a.vtt','CZSK;cs;javascript:alert(1)','CZSK;https://cdn.example/a.vtt'])assert.equal(voeSubtitles(base+encodeURIComponent(input),0).length,0);
});
test('front opt-in permits VOE fetch while default continues to block it without opening ports',async()=>{
  const fs=require('node:fs'),vm=require('node:vm'),{createRequire}=require('node:module');
  const file=require.resolve('./front'),local=createRequire(file);
  for(const enabled of [false,true]){
    let calls=0;const env=enabled?{BOMBUJ_TEST_DIRECT_VOE:'1'}:{};
    const g={fetch:async()=>{calls++;return new Response('fixture');}};
    vm.runInNewContext(fs.readFileSync(file,'utf8'),{
      require:p=>p==='http'?{createServer:()=>({listen(){}})}:p==='./bootstrap.js'?{}:p==='./embed-test-policy.js'?{testUnblockAllowed:u=>testUnblockAllowed(u,env),testDirectVoeAllowed:u=>testDirectVoeAllowed(u,env)}:local(p),
      process:{env},console:{log(){},error(){}},URL,global:g,AbortSignal
    });
    if(enabled)await g.fetch('https://voe.sx/e/test');else await assert.rejects(g.fetch('https://voe.sx/e/test'),/Keep original/);
    assert.equal(calls,enabled?1:0);
  }
});

test('normal VOE switch is host-limited and explicit disable overrides legacy opt-in',()=>{
  assert.equal(testDirectVoeAllowed('https://voe2.sx/e/test',{BOMBUJ_DIRECT_VOE:'1'}),true);
  assert.equal(testDirectVoeAllowed('https://voe.sx/e/test',{BOMBUJ_DIRECT_VOE:'0',BOMBUJ_TEST_DIRECT_VOE:'1'}),false);
  for(const url of ['http://voe.sx/e/test','https://voe.sx.evil.test/e/test','https://mixdrop.ag/e/test'])
    assert.equal(testDirectVoeAllowed(url,{BOMBUJ_DIRECT_VOE:'1'}),false);
});

test('VOE web player is preserved by public preflight without fetching video',async()=>{
  const fs=require('node:fs'),vm=require('node:vm'),{createRequire}=require('node:module');
  const file=require.resolve('./preflight-front'),local=createRequire(file),mod={exports:{}};
  const env={BOMBUJ_DIRECT_VOE:'1'},logs=[];
  vm.runInNewContext(fs.readFileSync(file,'utf8')+'\nmodule.exports={preflightStreams};',{
    require:p=>p==='http'?{createServer:()=>({listen(){}})}:p==='./filtered-front.js'?{}:p==='./embed-test-policy.js'?{
      testUnblockAllowed:u=>testUnblockAllowed(u,env),testDirectVoeAllowed:u=>testDirectVoeAllowed(u,env)
    }:local(p),module:mod,process:{env},URL,AbortSignal,
    console:{log:value=>logs.push(value),error(){}},
    global:{fetch:()=>{throw Error('preflight must not fetch VOE or media');}}
  });
  const streams=[{name:'Bombuj • VOE',url:'https://cdn.example/video.m3u8'},
    {name:'Bombuj • VOE',externalUrl:'https://voe.sx/e/original'}];
  const out=await mod.exports.preflightStreams({streams},'movie','tt0468569');
  assert.equal(out.streams.length,1);assert.equal(out.streams[0].externalUrl,streams[1].externalUrl);
  assert.equal(out.streams[0].url,undefined);
  assert(logs.some(line=>line.includes('published=1 omitted=1')));
});

test('VOE upstream failures never expose a web player as a stream',async()=>{
  const fs=require('node:fs'),vm=require('node:vm'),{createRequire}=require('node:module');
  const file=require.resolve('./index'),local=createRequire(file),mod={exports:{}};
  const sdk={addonBuilder:class{defineCatalogHandler(){}defineStreamHandler(){}getInterface(){return{}}},serveHTTP(){}};
  vm.runInNewContext(fs.readFileSync(file,'utf8'),{
    require:p=>p==='stremio-addon-sdk'?sdk:p==='./embed-test-policy.js'?{testDirectVoeAllowed:u=>testDirectVoeAllowed(u,{BOMBUJ_DIRECT_VOE:'1'})}:local(p),
    module:mod,process:{env:{}},console:{log(){},error(){},warn(){}},URL,URLSearchParams,AbortSignal,Buffer,Uint8Array,
    fetch:async()=>new Response('unavailable',{status:403})
  });
  const embed='https://voe2.sx/e/original';
  const out=await mod.exports.playersToStreams([{provider:'voe2.sx',language:'SK dabing',resolvedUrl:embed}],'https://www.bombuj.si/online-film-example');
  assert.equal(out.length,0);
});

test('custom movie VOE signed URLs are resolved again, while other sources retain their cache',async()=>{
  const fs=require('node:fs'),vm=require('node:vm'),{createRequire}=require('node:module');
  const file=require.resolve('./filtered-front'),local=createRequire(file);
  for(const voe of [true,false]){
    const mod={exports:{}};let calls=0;
    const core={discoverBombujPlayers:async()=>[{resolvedUrl:voe?'https://voe.sx/e/test':'https://mixdrop.ag/e/test'}],
      playersToStreams:async()=>{calls++;return[{name:'Bombuj • Player',description:'CZ dabing • přímý HLS',url:'https://cdn.example/video.m3u8'}];}};
    vm.runInNewContext(fs.readFileSync(file,'utf8')+'\nmodule.exports={customMovieStreams};',{
      require:p=>p==='http'?{createServer:()=>({listen(){}})}:p==='./front.js'?{}:p==='./index.js'?core:p==='./embed-test-policy.js'?{testDirectVoeAllowed:u=>testDirectVoeAllowed(u,{BOMBUJ_DIRECT_VOE:'1'})}:local(p),
      module:mod,process:{env:{}},URL,URLSearchParams,AbortSignal,console:{log(){},error(){}},
      global:{fetch:()=>{throw Error('unexpected network request');}}
    });
    await mod.exports.customMovieStreams('bombuj-movie-test','test');
    await mod.exports.customMovieStreams('bombuj-movie-test','test');
    assert.equal(calls,voe?2:1);
  }
});
