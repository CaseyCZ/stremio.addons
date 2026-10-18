'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { parseBombujPlayerGroups, decodeAttribute } = require('./player-groups.js');

const carrie = [
  '<div class="accordion-menu" id="accordion-menu">',
  '  <div class="open">',
  '    <div class="dropdownlink"><img src="//www.bombuj.si/images/flag/cz.svg" class="cflag"> CZ dabing <i></i></div>',
  '    <ul id="ajaxtabsul" class="submenuItems">',
  '      <li link="//serialy.bombuj.si/serial/prehravace_final/player.php?v=&amp;id=322153&amp;us=&amp;vh=filemoon.sx&amp;pr=Carrie"><a href="#">byse.sx</a></li>',
  '      <li link="//serialy.bombuj.si/serial/prehravace_final/player.php?v=&amp;id=322154&amp;us=&amp;vh=voe.sx&amp;pr=Carrie"><a href="#">voe.sx - <span style="color:gold;">VIP</span></a></li>',
  '      <li link="//serialy.bombuj.si/serial/prehravace_final/player.php?v=&amp;id=322152&amp;us=&amp;vh=streamtape.com&amp;pr=Carrie"><a href="#">streamtape.com</a></li>',
  '    </ul>',
  '  </div>',
  '  <div>',
  '    <div class="dropdownlink"><img src="//www.bombuj.si/images/flag/en.svg" class="cflag"> EN dab/tit <i></i></div>',
  '    <ul id="ajaxtabsul" class="submenuItems">',
  '      <li link="//serialy.bombuj.si/serial/prehravace_final/vidsrc.php?v=&se=1&ep=1"><a href="#">vidsrc</a></li>',
  '      <li link="//serialy.bombuj.si/serial/prehravace_final/vidlink.php?v=&se=1&ep=1"><a href="#">vidlink</a></li>',
  '      <li link="//serialy.bombuj.si/serial/prehravace_final/videasy.php?v=&se=1&ep=1"><a href="#">videasy <span style="color:red;">(New)</span></a></li>',
  '      <li link="//serialy.bombuj.si/serial/prehravace_final/vidstream.php?v=&se=1&ep=1"><a href="#">vidapi <span style="color:red;">(New)</span></a></li>',
  '      <li link="//serialy.bombuj.si/serial/prehravace_final/vidnest.php?v=&se=1&ep=1"><a href="#">vidnest <span style="color:red;">(New)</span></a></li>',
  '      <li link="//serialy.bombuj.si/serial/prehravace_final/primewire.php?v=&se=1&ep=1"><a href="#">primewire</a></li>',
  '    </ul>',
  '  </div>',
  '</div>'
].join('\n');

test('Carrie 1x1 finds Streamtape and all six EN players, not VOE mislabeled Streamtape', () => {
  const found = parseBombujPlayerGroups(carrie);
  assert.deepEqual(found.map(x => x.provider), [
    'byse.sx', 'streamtape.com', 'vidsrc', 'vidlink',
    'videasy (New)', 'vidapi (New)', 'vidnest (New)', 'primewire'
  ]);
  assert.equal(found.length, 8);
  assert(found.slice(0,2).every(x=>x.language === 'CZ dabing'));
  assert(found.slice(2).every(x=>x.language === 'EN dab/tit'));
  const tape = found.find(x=>x.provider === 'streamtape.com');
  assert.equal(new URL(tape.url, 'https://serialy.bombuj.si').searchParams.get('id'), '322152');
  assert.equal(new URL(tape.url, 'https://serialy.bombuj.si').searchParams.get('vh'), 'streamtape.com');
});

test('VIP nested span cannot consume next list item', () => {
  const found = parseBombujPlayerGroups(carrie);
  assert.equal(found.filter(x=>x.provider.includes('VIP')).length,0);
  assert.equal(found.filter(x=>x.provider==='streamtape.com').length,1);
  assert.equal(found.find(x=>x.provider==='vidapi (New)').language,'EN dab/tit');
});

test('HTML entity decoding restores real wrapper query parameters', () => {
  assert.equal(decodeAttribute('https://example.com/player.php?v=&amp;id=55&amp;vh=streamtape.com'),
    'https://example.com/player.php?v=&id=55&vh=streamtape.com');
  const all = parseBombujPlayerGroups(carrie);
  const tape = all.find(x=>x.provider==='streamtape.com');
  assert(!tape.url.includes('&amp;'));
});

test('movie AJAX fragments without accordion headings remain supported', () => {
  const html='<ul><li class="selectedis" link="//www.bombuj.si/player.php?id=2">'+
    '<a href="#">Streamtape</a></li></ul>';
  assert.deepEqual(parseBombujPlayerGroups(html,'CZ dabing'),[
    {url:'//www.bombuj.si/player.php?id=2',provider:'Streamtape',language:'CZ dabing'}
  ]);
});

test('unrelated navigation list items outside accordion are ignored',()=>{
  const html=carrie+'<ul><li link="//example.invalid/promo"><a href="#">Promo</a></li></ul>';
  assert(!parseBombujPlayerGroups(html).some(x=>x.provider==='Promo'));
});
