'use strict';

// Bombuj's film browser is paginated in groups of 16. Keep the catalogue
// ids stable so installed Stremio clients can request later pages via skip.
const PAGE_SIZE = 16;
const MOVIE_CATALOGS = Object.freeze([
  // Four public film categories; year sorting remains supported internally.
  { id: 'bombuj-movies', name: '🆕 Bombuj – Nejnovější filmy', sort: 'id' },
  { id: 'bombuj-movies-best-rated', name: '⭐ Bombuj – Nejlépe hodnocené filmy', sort: 'hodnotenie' },
  { id: 'bombuj-movies-top-today', name: '🔥 Bombuj – TOP dnes', sort: 'todayviews' },
  { id: 'bombuj-movies-most-watched', name: '🏆 Bombuj – TOP celkově', sort: 'views' }
]);

// Separate searchable catalogue; the four browse rows never advertise 'search'.
const SEARCH_MOVIE_CATALOG = Object.freeze({
  id: 'bombuj-movies-search', name: '🔎 Bombuj – Hledat filmy', sort: 'id'
});

const SORT_OPTIONS = Object.freeze([
  { label: 'Nejnovější filmy', value: 'id' },
  { label: 'Podle roku', value: 'year' },
  { label: 'Nejlépe hodnocené', value: 'hodnotenie' },
  { label: 'TOP dnes', value: 'todayviews' },
  { label: 'TOP celkově', value: 'views' }
]);

const AUDIO_OPTIONS = Object.freeze([
  { label: 'Všechny filmy', value: '1' },
  { label: 'S dabingem', value: '2' },
  { label: 'S titulky', value: '3' }
]);

const GENRE_LABEL_ALIASES = Object.freeze({
  'akcni': 'akcne',
  'komedie': 'komedie',
  'drama': 'drama',
  'vanocni filmy': 'vianocne filmy'
});

function normalizeLabel(text) {
  return String(text || '').toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

function normalizeGenreLabel(text) {
  const normalized = normalizeLabel(text);
  return GENRE_LABEL_ALIASES[normalized] || normalized;
}

function chooseSort(value, fallback = 'id') {
  const option = SORT_OPTIONS.find(item =>
    normalizeLabel(value) === normalizeLabel(item.label) ||
    normalizeLabel(value) === normalizeLabel(item.value));
  return option?.value || fallback;
}

function chooseAudio(value) {
  // Keep previous installations' extras working after labels are renamed.
  const aliases = {
    'vsechny i s titulky': '1',
    'jen dabovane': '2',
    'jen s titulky': '3'
  };
  const key = normalizeLabel(value);
  if (aliases[key]) return aliases[key];
  const option = AUDIO_OPTIONS.find(item =>
    key === normalizeLabel(item.label) || key === item.value);
  return option?.value || '1';
}

function catalogById(id) {
  return MOVIE_CATALOGS.find(item => item.id === id) ||
    (id === SEARCH_MOVIE_CATALOG.id ? SEARCH_MOVIE_CATALOG : null);
}

function parseCatalogPath(pathname) {
  const match = String(pathname || '').match(/^\/catalog\/movie\/([^/]+?)(?:\/([^/]+))?\.json$/i);
  if (!match) return null;
  const catalog = catalogById(match[1]);
  if (!catalog) return null;
  const extra = new URLSearchParams(match[2] || '');
  const parsedSkip = Number.parseInt(extra.get('skip') || '0', 10);
  return {
    id: catalog.id,
    search: String(extra.get('search') || '').trim(),
    genre: String(extra.get('genre') || '').trim(),
    audio: chooseAudio(extra.get('audio')),
    sort: chooseSort(extra.get('sort'), catalog.sort),
    skip: Number.isFinite(parsedSkip) ? Math.max(0, Math.min(parsedSkip, 100000)) : 0
  };
}

function browseUrl({ page, sort, audio, genre }) {
  const query = new URLSearchParams({
    page: String(Math.max(1, Math.floor(Number(page) || 1))),
    sort: chooseSort(sort),
    title: chooseAudio(audio),
    zaner: String(genre || 'all')
  });
  return 'https://www.bombuj.si/zanre/obr/all.php?' + query.toString();
}

function manifestCatalogs(genreOptions) {
  return [
    ...MOVIE_CATALOGS.map(catalog => ({
      type: 'movie',
      id: catalog.id,
      name: catalog.name,
      extra: [
        { name: 'genre', options: genreOptions },
        { name: 'audio', options: AUDIO_OPTIONS.map(option => option.label) },
        { name: 'skip' }
      ]
    })),
    {
      type: 'movie',
      id: SEARCH_MOVIE_CATALOG.id,
      name: SEARCH_MOVIE_CATALOG.name,
      extra: [{ name: 'search', isRequired: true }, { name: 'skip' }]
    }
  ];
}

module.exports = {
  PAGE_SIZE, MOVIE_CATALOGS, SEARCH_MOVIE_CATALOG, SORT_OPTIONS, AUDIO_OPTIONS,
  parseCatalogPath, browseUrl, manifestCatalogs,
  chooseSort, chooseAudio, normalizeGenreLabel
};
