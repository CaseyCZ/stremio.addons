'use strict';
const assert=require('node:assert/strict');
const {test}=require('node:test');
const {episodeIdentityMatches,buildQueries}=require('./api/sktonline');

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
