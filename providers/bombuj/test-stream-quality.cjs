'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {qualityLabel,hlsVariants,inspectHls}=require('./stream-quality');
const {formatBombujStream}=require('./stream-display');

test('Bombuj uses the same provider/quality and three-line layout as SKTOnline',()=>{
 const out=formatBombujStream({name:'Bombuj • voe2.sx',description:'CZ dabing • přímý HLS • 1080p',url:'https://cdn.example/master.m3u8'});
 assert.equal(out.name,'Bombuj • 1080p');
 assert.equal(out.title,'🎧 🇨🇿 CZ\n💬 Neuvedeny\n🎬 1080p');
 assert.equal(formatBombujStream(out).title,out.title);
 assert.equal(formatBombujStream(out).name,out.name);
});
test('quality is never invented from random numbers in signed URLs',()=>{
 assert.equal(qualityLabel({url:'https://cdn.example/1080/movie.m3u8?token=720'}),'Kvalita neuvedena');
 assert.equal(qualityLabel({description:'4K'}),'2160p');
 assert.equal(qualityLabel({name:'Bombuj • 540p'}),'540p');
 assert.equal(qualityLabel({description:'HD'}),'720p');
});
test('HLS quality comes from RESOLUTION and selected URL matches that quality',async()=>{
 const body='#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=1280x720,BANDWIDTH=10\n720.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=20,RESOLUTION=1920x1080\n1080.m3u8';
 assert.deepEqual(hlsVariants(body,'https://cdn.example/path/master.m3u8').map(x=>x.quality),['1080p','720p']);
 const out=await inspectHls('https://cdn.example/path/master.m3u8',{fetchImpl:async()=>new Response(body)});
 assert.deepEqual(out,{url:'https://cdn.example/path/1080.m3u8',height:1080,quality:'1080p'});
});
test('HTTP 200 HTML, forbidden media, oversized data and fetch failures do not pass as valid HLS',async()=>{
 for(const [body,status] of [['<html>Access denied</html>',200],['forbidden',403],['#EXTM3U\n'+'x'.repeat(65536),200]]){
  assert.equal(await inspectHls('https://cdn.example/master.m3u8',{fetchImpl:async()=>new Response(body,{status})}),null);
 }
 await assert.rejects(inspectHls('https://cdn.example/master.m3u8',{fetchImpl:async()=>{throw Error('fixture');}}));
 assert.deepEqual(hlsVariants('#EXTM3U\n#EXT-X-STREAM-INF:RESOLUTION=1280x720\njavascript:alert(1)','https://cdn.example/master.m3u8'),[]);
});
