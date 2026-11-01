'use strict';
// Sosáč-style metadata formatting, without changing stream URLs.
const MAP={cs:['CZ','🇨🇿'],cz:['CZ','🇨🇿'],cze:['CZ','🇨🇿'],ces:['CZ','🇨🇿'],
 sk:['SK','🇸🇰'],slo:['SK','🇸🇰'],slk:['SK','🇸🇰'],
 en:['EN','🇬🇧'],eng:['EN','🇬🇧'],de:['DE','🇩🇪'],deu:['DE','🇩🇪'],ger:['DE','🇩🇪'],
 fr:['FR','🇫🇷'],fre:['FR','🇫🇷'],fra:['FR','🇫🇷'],es:['ES','🇪🇸'],spa:['ES','🇪🇸'],
 pl:['PL','🇵🇱'],pol:['PL','🇵🇱'],it:['IT','🇮🇹'],ita:['IT','🇮🇹'],
 ru:['RU','🇷🇺'],rus:['RU','🇷🇺'],hu:['HU','🇭🇺'],hun:['HU','🇭🇺'],
 ua:['UA','🇺🇦'],ukr:['UA','🇺🇦'],ja:['JA','🇯🇵'],jpn:['JA','🇯🇵'],
 ko:['KO','🇰🇷'],kor:['KO','🇰🇷'],zh:['ZH','🇨🇳'],zho:['ZH','🇨🇳'],chi:['ZH','🇨🇳']};
const safe=(v,n=220)=>String(v??'').replace(/[\r\n\t]+/g,' ').replace(/\s+/g,' ').trim().slice(0,n);
function languageDisplay(value){
 const code=safe(value,24).toLowerCase().split(/[-_]/)[0].replace(/\d+$/,'');
 if(!code||code==='und')return '🌐 Neurčeno';
 return MAP[code]?MAP[code][1]+' '+MAP[code][0]:/^[a-z]{2,3}$/.test(code)?'🌐 '+code.toUpperCase():'🌐 Neurčeno';
}
function subtitleLanguages(tracks,empty='Bez titulků'){
 if(!Array.isArray(tracks)||!tracks.length)return safe(empty);
 const labels=[...new Set(tracks.map(t=>languageDisplay(t&&t.lang)))],priority=['🇨🇿 CZ','🇸🇰 SK','🇬🇧 EN'];
 labels.sort((a,b)=>(priority.indexOf(a)<0?99:priority.indexOf(a))-(priority.indexOf(b)<0?99:priority.indexOf(b)));
 return labels.slice(0,10).join(' • ')+(labels.length>10?' • +'+(labels.length-10)+' jazyků':'');
}
function audioFromReleaseName(title){
 const v=safe(title,300).normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
 const dub='(?:dab|dabing|dub|dubbed)';
 const names=[['(?:cz|cs|cze|ces|cesky|cestina)','🇨🇿 CZ'],['(?:sk|slo|slk|slovensky|slovencina)','🇸🇰 SK'],['(?:en|eng|english|anglicky)','🇬🇧 EN']];
 const a=names.filter(([lang])=>new RegExp('(?:^| )'+lang+' '+dub+'(?: |$)|(?:^| )'+dub+' '+lang+'(?: |$)').test(v)).map(([,flag])=>flag);
 return a.length?a.join(' • '):'Neuvedeno';
}
function qualityFromReleaseName(value){
 const s=safe(value,300);
 for(const [test,q] of [[/\b(?:2160p|4k|uhd)\b/i,'2160p'],[/\b1440p\b/i,'1440p'],
 [/\b(?:1080p|fhd)\b|\bfull[\s._-]*hd\b/i,'1080p'],[/\b720p\b/i,'720p'],[/\b576p\b/i,'576p'],
 [/\b480p\b/i,'480p'],[/\b360p\b/i,'360p'],[/\b240p\b/i,'240p'],[/\bhd\b/i,'HD'],[/\bsd\b/i,'SD']])
 if(test.test(s))return q;
 return 'Kvalita neuvedena';
}
function formatStreamTitle({audio,subtitles,quality,releaseName,extraLines=[]}={}){
 const lines=['🎧 '+(safe(audio)||'Neuvedeno'),'💬 '+(safe(subtitles)||'Neuvedeny'),
  '🎬 '+(safe(quality)||'Kvalita neuvedena')];
 const release=safe(releaseName,180);
 if(release)lines.push('🎞 '+release);
 for(const x of (Array.isArray(extraLines)?extraLines:[]).slice(0,3)){const value=safe(x);if(value)lines.push(value)}
 return lines.join('\n');
}
module.exports={formatStreamTitle,languageDisplay,subtitleLanguages,audioFromReleaseName,qualityFromReleaseName};
