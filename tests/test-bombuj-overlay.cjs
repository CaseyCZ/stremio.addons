'use strict';
const assert=require('node:assert/strict');
const {test}=require('node:test');
const {parseBombujId,resolveBombujId}=require('../api/bombuj-overlay');
function fixture(imdb){return async()=>({ok:true,json:async()=>({meta:{id:'bombuj-series-test',imdb_id:imdb}})})}
test('Bombuj film ID resolves to Cinemeta IMDb without credentials',async()=>{
  const r=await resolveBombujId('movie','bombuj-movie-strange-harvest',{fetchImpl:fixture('tt33400719')});
  assert.equal(r.canonicalId,'tt33400719');
});
test('Bombuj series episode ID preserves season and episode',async()=>{
  const r=await resolveBombujId('series','bombuj-series-saving-hope:1:1',{fetchImpl:fixture('tt1954804')});
  assert.equal(r.canonicalId,'tt1954804:1:1');
});
test('Bombuj recent episode ID resolves with same IMDb episode',async()=>{
  const r=await resolveBombujId('series','bombuj-episode-chicago-hope-1x1',{fetchImpl:fixture('tt0108724')});
  assert.equal(r.canonicalId,'tt0108724:1:1');
});
test('Bombuj ID parser rejects unsafe paths and invalid episode numbers',()=>{
  assert.equal(parseBombujId('series','bombuj-series-../../path'),null);
  assert.equal(parseBombujId('series','bombuj-series-hope:0:1'),null);
});
test('Missing authoritative IMDb ID is never guessed',async()=>{
  const r=await resolveBombujId('movie','bombuj-movie-unmapped',{fetchImpl:fixture(null)});
  assert.equal(r,null);
});
