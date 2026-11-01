'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {formatStreamTitle,languageDisplay,subtitleLanguages,audioFromReleaseName,qualityFromReleaseName}=require('../api/stream-display');
test('all sources display Sosáč-style basic rows',()=>{
 assert.equal(formatStreamTitle({audio:'🇨🇿 CZ',subtitles:'🇬🇧 EN',quality:'1080p'}),'🎧 🇨🇿 CZ\n💬 🇬🇧 EN\n🎬 1080p');
 assert.equal(formatStreamTitle({}),'🎧 Neuvedeno\n💬 Neuvedeny\n🎬 Kvalita neuvedena');
});
test('a subtitle label does not imply dubbing',()=>{
 assert.equal(audioFromReleaseName('Mayday 2026 CZ titulky HD'),'Neuvedeno');
 assert.equal(audioFromReleaseName('Film EN subtitles'),'Neuvedeno');
 assert.equal(audioFromReleaseName('Forrest Gump CZ dabing'),'🇨🇿 CZ');
 assert.equal(audioFromReleaseName('Film SK dabing'),'🇸🇰 SK');
 assert.equal(audioFromReleaseName('Film EN dubbed'),'🇬🇧 EN');
});
test('actual subtitle languages are deduplicated only in the summary',()=>{
 const tracks=[{lang:'eng'},{lang:'ces'},{lang:'eng'},{lang:'slk'},{lang:'zho'}];
 assert.equal(subtitleLanguages(tracks),'🇨🇿 CZ • 🇸🇰 SK • 🇬🇧 EN • 🇨🇳 ZH');
 assert.equal(tracks.length,5);
 assert.equal(subtitleLanguages([]),'Bez titulků');
 assert.equal(languageDisplay('eng2'),'🇬🇧 EN');
 assert.equal(languageDisplay('und'),'🌐 Neurčeno');
});
test('filename quality is not measured resolution',()=>{
 assert.equal(qualityFromReleaseName('Film 1080p CZ dabing'),'1080p');
 assert.equal(qualityFromReleaseName('Film 2026 CZ titulky'),'Kvalita neuvedena');
});
test('optional release and P2P info follow the same three rows',()=>{
 const display=formatStreamTitle({audio:'Neuvedeno',subtitles:'Titulky',quality:'HD',releaseName:'Film 2026',
 extraLines:['👥 7 seed • 📦 4 GB']});
 assert.equal(display,'🎧 Neuvedeno\n💬 Titulky\n🎬 HD\n🎞 Film 2026\n👥 7 seed • 📦 4 GB');
 assert.equal(formatStreamTitle({releaseName:'fake\n🎧 CZ'}).split('\n').length,4);
});
