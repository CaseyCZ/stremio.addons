'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { searchTorrents, getClient } = require('./api/sktorrent');

const examplePage = `<!doctype html><html><body>
  <table><tr><td><b>Film - HD</b><a href="details.php?id=31415" title="Barbie 2023 1080p CZ">
  <img src="/poster/barbie.jpg"></a><span>Velkost 4.1 GB | Odosielaju : 7</span></td></tr></table>
</body></html>`;

test('SKTorrent search uses the authenticated client, including its session', async () => {
  const calls = [];
  const client = {
    clientKey: 'account-session-a',
    authenticatedGet: async (url, options) => {
      calls.push({ url, options });
      return { data: examplePage };
    }
  };
  const list = await searchTorrents(client, 'Barbie', ['Barbie', 'Barbie 2023']);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, '31415');
  assert.equal(list[0].name, 'Barbie 2023 1080p CZ');
  assert.equal(list[0].seeds, 7);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /torrents_v2\.php$/);
  assert.equal(calls[0].options.params.search, 'Barbie');
  // Identical searches should reuse the same account's result.
  await searchTorrents(client, 'Barbie', ['Barbie', 'Barbie 2023']);
  assert.equal(calls.length, 1);
});

test('SKTorrent search does not share authenticated results between accounts', async () => {
  let calls = 0;
  const accountB = {
    clientKey: 'account-session-b',
    authenticatedGet: async () => { calls++; return { data: '<html><body>No search results</body></html>' }; }
  };
  const list = await searchTorrents(accountB, 'Barbie', ['Barbie', 'Barbie 2023']);
  assert.deepEqual(list, []);
  assert.equal(calls, 1);
});

test('SKTorrent relogs when a successful HTTP 200 is actually the login form', async () => {
  const client = getClient('unit-only-login-user', 'unit-only-login-password');
  const forced = [];
  const requests = [];
  client.login = async force => {
    forced.push(Boolean(force));
    client.cookies = { uid: 'unit123', pass: 'unitpass' };
    return true;
  };
  client.http.get = async (_url, options) => {
    requests.push(options);
    return { data: requests.length === 1
      ? '<html><form action="login.php?returnto=index.php"><input name="uid"></form></html>'
      : '<html><a href="usercp.php">Account</a><main>Search results</main></html>',
      request: { res: { responseUrl: 'https://sktorrent.eu/torrent/torrents_v2.php' } }
    };
  };
  const response = await client.authenticatedGet('https://sktorrent.eu/torrent/torrents_v2.php', { params: { search: 'Barbie' } });
  assert.deepEqual(forced, [false, true]);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].headers.Cookie, 'uid=unit123; pass=unitpass');
  assert.match(response.data, /Search results/);
});

test('Failed SKTorrent search is not cached as no available torrents', async () => {
  let calls = 0;
  const client = {
    clientKey: 'account-session-transient-error',
    authenticatedGet: async () => { calls++; throw new Error('network timeout'); }
  };
  for (let i=0; i<2; i++) {
    const results = await searchTorrents(client, 'Unique Fixture Movie', ['Unique Fixture Movie']);
    assert.deepEqual(results, []);
  }
  assert.equal(calls, 2);
});
