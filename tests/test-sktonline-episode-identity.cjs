'use strict';
const assert=require('node:assert/strict');
const {test}=require('node:test');
const {episodeIdentityMatches,buildQueries,findDirectOnlineByTitle}=require('../api/sktonline');

const titles=['Ted Lasso'];
const yes=[
  'Ted.Lasso.S01E01.1080p.WEB-DL',
  'Ted Lasso S1 E1 CZ 720p',
  'Ted Lasso 1x01 Pilot',
  'Ted Lasso 1×1 Pilot',
  'S01E01 Ted Lasso 2020 EN',
  'Ted Lasso Season 1 Episode 1 720p',
  'Ted Lasso 1. série 1. epizoda'
];
for(const name of yes)test('accept actual Ted Lasso episode: '+name,()=>{
  assert.equal(episodeIdentityMatches(name,titles,1,1),true);
});

const no=[
  'Ted S01E01 720p', // The unrelated bear series that was played on TV.
  'Ted 1x01 CZ',
  'Ted (2024) S01E01',
  'Ted Lasso S01E02',
  'Ted Lasso S02E01',
  'Ted Lasso Season 1',
  'Ted Lasso 1080p',
  'Ted.Lasso.S01E01-S01E03.PACK',
  'The Ted Lasso Parody S01E01',
  'Teddy Lasso S01E01',
  'TedS01E01 Lasso',
  'Ted Lasso S01E01 and S02E01'
];
for(const name of no)test('reject unsafe SKTOnline episode source: '+name,()=>{
  assert.equal(episodeIdentityMatches(name,titles,1,1),false);
});

test('short alternate name never overrides the complete series name',()=>{
  assert.equal(episodeIdentityMatches('Ted S01E01',['Ted Lasso','Ted'],1,1),false);
  assert.equal(episodeIdentityMatches('Ted Lasso S01E01',['Ted Lasso','Ted'],1,1),true);
});

test('one-word TV shows remain playable when their full name and exact episode match',()=>{
  assert.equal(episodeIdentityMatches('Lost S01E01 2004',['Lost'],1,1),true);
  assert.equal(episodeIdentityMatches('Lost S01E02 2004',['Lost'],1,1),false);
});

test('search queries no longer include ambiguous partial Ted title',()=>{
  const queries=buildQueries(titles,'series',1,1);
  assert(queries.includes('Ted Lasso S01E01'));
  assert(!queries.some(q=>/^Ted S01E01$|^Ted 1x01$/.test(q)));
});


test('older Ted Lasso season appears after newer episodes on paginated search',async()=>{
  const pages=[];
  const search=async(query,_wanted,page=1)=>{
    pages.push({query,page});
    if(page===1&&query==='Ted Lasso')return [
      {id:'new-season',title:'Ted Lasso S04E10',score:0.99}
    ];
    if(query==='Ted Lasso'&&page===2)return [
      {id:'bear',title:'Ted S01E01',score:1},
      {id:'another-episode',title:'Ted Lasso S02E01',score:0.99}
    ];
    if(query==='Ted Lasso'&&page===3)return [
      {id:'matching',title:'Ted Lasso S01E01 720p',score:1}
    ];
    return [];
  };
  const resolved=[];
  const resolve=async item=>{
    resolved.push(item.id);
    return [{name:'SKTOnline • 720p',url:'https://online1.sktorrent.eu/media/videos/h264/999_720p.mp4'}];
  };
  const stream=await findDirectOnlineByTitle(
    ['Ted Lasso S01E01','Ted Lasso'],['Ted Lasso'],'series',1,1,search,resolve
  );
  assert.equal(stream.length,1);
  assert.deepEqual(resolved,['matching']);
  assert(pages.some(x=>x.query==='Ted Lasso'&&x.page===3));
  assert(!pages.some(x=>x.query==='Ted'));
});

test('movies retain page-one behavior and never trigger series pagination',async()=>{
  const calls=[];
  const search=async(query,_titles,page=1)=>{
    calls.push({query,page});return [{id:'film',title:'Barbie 2023',score:1}];
  };
  const result=await findDirectOnlineByTitle(
    ['Barbie'],['Barbie'],'movie',null,null,search,
    async()=>[{name:'SKTOnline • 1080p',url:'https://online1.sktorrent.eu/media/videos/h264/123_1080p.mp4'}]
  );
  assert.equal(result.length,1);
  assert.deepEqual(calls,[{query:'Barbie',page:1}]);
});

test('series pagination rejects wrong show, wrong episodes, and never resolves them',async()=>{
  const bad=[
    {id:'ted-bear',title:'Ted S01E01',score:1},
    {id:'ted-lasso-ep2',title:'Ted Lasso S01E02',score:1},
    {id:'no-episode',title:'Ted Lasso',score:1},
    {id:'unrelated',title:'Ted Lasso Parody S01E01',score:1}
  ];
  let calls=0;
  const search=async()=>bad;
  const streams=await findDirectOnlineByTitle(
    ['Ted Lasso','Ted Lasso S01E01'],['Ted Lasso'],'series',1,1,search,
    async()=>{calls++;return []}
  );
  assert.deepEqual(streams,[]);
  assert.equal(calls,0);
});

test('pagination never discards non-first-page episodes of a one-word show',async()=>{
  const pages=[];
  const search=async(query,_,page=1)=>{
    pages.push({query,page});
    return page===4?[{id:'lost',title:'Lost.S01E01',score:1}]:[{id:'other',title:'Lost.S02E01',score:1}];
  };
  const result=await findDirectOnlineByTitle(
    ['Lost'],['Lost'],'series',1,1,search,
    async()=>[{name:'SKTOnline • 720p',url:'https://online1.sktorrent.eu/media/videos/h264/999_720p.mp4'}]
  );
  assert.equal(result.length,1);
  assert(pages.some(x=>x.page===4));
});


test('online searches use one shared session request at a time',async()=>{
  let active=0,peak=0,calls=0;
  const search=async()=>{
    active++;peak=Math.max(active,peak);calls++;
    await new Promise(resolve=>setTimeout(resolve,2));
    active--;
    return [];
  };
  const result=await findDirectOnlineByTitle(
    ['Ted Lasso S01E01','Ted Lasso 1x01','Ted Lasso'],
    ['Ted Lasso'],'series',1,1,search,async()=>[]
  );
  assert.deepEqual(result,[]);
  assert.equal(peak,1);
  assert(calls>=3);
});
