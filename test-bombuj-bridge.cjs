'use strict';
const assert=require('node:assert/strict');
const {test}=require('node:test');
const {bombujManifest,bombujRequestPath,getBombujJson}=require('./api/bombuj-bridge');
test('bridge preserves episode and film identities',()=>{
  assert.equal(bombujRequestPath('stream','series','bombuj-series-chicago-hope:1:1'),
    '/stream/series/bombuj-series-chicago-hope:1:1.json');
  assert.equal(bombujRequestPath('stream','series','tt1954804:1:1'),'/stream/series/tt1954804:1:1.json');
  assert.equal(bombujRequestPath('meta','movie','bombuj-movie-strange-harvest'),
    '/meta/movie/bombuj-movie-strange-harvest.json');
  assert.equal(bombujRequestPath('catalog','series','bombuj-series-search','search=Saving Hope'),
    '/catalog/series/bombuj-series-search/search=Saving+Hope.json');
});
test('reject invalid resource IDs and untrusted catalog extras',()=>{
  assert.equal(bombujRequestPath('stream','movie','sosac_m_123'),null);
  assert.equal(bombujRequestPath('meta','movie','tt10/../../bad'),null);
  assert.equal(bombujRequestPath('catalog','series','bombuj-series-search','redirect=http://evil'),null);
  assert.equal(bombujRequestPath('catalog','movie','../../bad','search=x'),null);
});
test('independent Bombuj identity preserves catalogs and adds optional Sosac prefixes',()=>{
  const raw={id:'community.caseycz.bombuj',name:'Bombuj',version:'0.8.1',
    catalogs:[{type:'movie',id:'bombuj-movies',name:'Filmy'}],
    resources:[{name:'catalog',types:['movie']},{name:'stream',types:['movie','series'],idPrefixes:['tt','bombuj-series-']}]};
  const unconfigured=bombujManifest(raw);
  assert.equal(unconfigured.id,'cz.caseycz.stremio.bombuj.unified');
  assert.deepEqual(unconfigured.catalogs,raw.catalogs);
  assert.deepEqual(unconfigured.resources[1].idPrefixes,['tt','bombuj-series-']);
  assert.ok(bombujManifest(raw,true).resources[1].idPrefixes.includes('sosac_ep_'));
  assert.equal(raw.resources[1].idPrefixes.includes('sosac_ep_'),false);
});
test('bridge reads local JSON without sending encrypted credentials downstream',async()=>{
  let observed;
  const answer=await getBombujJson('/meta/series/bombuj-series-saving-hope.json',async (url, init)=>{
    observed={url,headers:init.headers};
    return {ok:true,json:async()=>({meta:{id:'bombuj-series-saving-hope',imdb_id:'tt1954804'}})};
  });
  assert.match(observed.url,/\/meta\/series\/bombuj-series-saving-hope\.json$/);
  assert.deepEqual(observed.headers,{Accept:'application/json'});
  assert.equal(answer.meta.imdb_id,'tt1954804');
});
