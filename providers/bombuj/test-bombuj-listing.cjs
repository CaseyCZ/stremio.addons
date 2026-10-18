'use strict';
const assert = require('node:assert/strict');
const {test} = require('node:test');
const {parseMovieCards} = require('./bombuj-listing.js');

test('picture catalogue reads the translated Strange Harvest card', () => {
  const html='<a href="/online-film-podivna-sklizen-2024">'+
    '<img src="/images/covers/podivna.jpg">'+
    '<div style="font-size: 18px">Podivná sklizeň</div></a>';
  const [item]=parseMovieCards(html);
  assert.equal(item.detailUrl,'https://www.bombuj.si/online-film-podivna-sklizen-2024');
  assert.equal(item.year,'2024');
  assert.equal(item.title,'Podivná sklizeň');
});

test('different cards never consume each others thumbnails or titles', () => {
  const html='<a href="/online-film-first-2024"><img src="/images/covers/a.jpg">'+
    '<div style="font-size:18px">First</div></a>'+
    '<a href="/online-film-second-2025"><img src="/images/covers/b.jpg">'+
    '<div style="font-size:23px">Second</div></a>';
  assert.deepEqual(parseMovieCards(html).map(x=>x.title),['First','Second']);
});

test('images with data-src and text-only movie anchors are accepted', () => {
  const html='<a href="/online-film-first-2024"><img data-src="/images/covers/a.jpg" alt="First"></a>'+
    '<a href="/online-film-second-2025">Second Movie</a>';
  assert.deepEqual(parseMovieCards(html).map(x=>x.title),['First','Second Movie']);
});

test('exclude external film links, recommended duplicates and slider image', () => {
  const html='<a href="https://evil.invalid/online-film-fake-2024">Fake</a>'+
    '<a href="/online-film-first-2024"><img src="/images/covers/1.jpg">First</a>'+
    '<a href="/online-film-first-2024">Duplicate</a>'+
    '<a href="/online-film-slider-2024"><img src="/images/slide/slide.jpg">Slider</a>';
  assert.deepEqual(parseMovieCards(html).map(x=>x.slug),['first-2024']);
});
