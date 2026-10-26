'use strict';

// Prioritise known audio and usable subtitle URLs over container quality.
// Keep the existing stream-display.js naming unchanged.
const { languageCode, parseGroup } = require('./group-labels.js');
const { subtitleTracks } = require('./stream-display.js');

function displayLine(stream, prefix) {
  return String(stream?.title || '').split(/\r?\n/)
    .find(line => line.startsWith(prefix + ' '))?.slice(prefix.length + 1) || '';
}

function groupMetadata(stream) {
  const raw = String(stream?.description || '').split(/\s*•\s*/)[0].trim();
  const group = parseGroup(raw);
  if (group.audio.length || group.subtitles.length || group.hasAudio || group.hasSubtitles) return group;

  // /stream/:id sometimes arrives after the shared formatter has removed
  // description. Its 🎧/💬 lines are the existing single source of truth.
  const audioLine = displayLine(stream, '🎧');
  const subtitleLine = displayLine(stream, '💬');
  const audio = parseGroup(audioLine).audio;
  const subtitles = parseGroup(subtitleLine).audio;
  return { audio, subtitles, raw, hasAudio: !!audio.length, hasSubtitles: !!subtitles.length };
}

function streamPriority(stream) {
  const group = groupMetadata(stream);
  const audio = group.audio;
  const subtitleFiles = subtitleTracks([stream]);
  const hasCzechTrack = subtitleFiles.some(sub => languageCode(sub.lang) === 'ces');
  const declaredCzech = group.subtitles.includes('ces');
  if (audio.includes('ces')) return 0;
  if (audio.includes('eng') && hasCzechTrack) return 1;
  if (!audio.length && hasCzechTrack) return 2;
  if (audio.includes('eng') && declaredCzech) return 3;
  if (!audio.length && declaredCzech) return 4;
  if (audio.includes('slk')) return 5;
  if (audio.includes('eng')) return 6;
  return 7;
}

function sortBombujStreams(streams, providerRank = () => 0) {
  return [...(Array.isArray(streams) ? streams : [])].sort((a, b) =>
    streamPriority(a) - streamPriority(b) || providerRank(a) - providerRank(b));
}

module.exports = { streamPriority, sortBombujStreams };
