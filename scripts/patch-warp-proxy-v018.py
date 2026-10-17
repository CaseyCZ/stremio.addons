from pathlib import Path
import json

root = Path('.')

# api/sktonline.js
p = root / 'api' / 'sktonline.js'
s = p.read_text()

needle = "const NodeCache = require('node-cache');\nconst { getClient } = require('./sktorrent');\n"
repl = "const NodeCache = require('node-cache');\nconst { SocksProxyAgent } = require('socks-proxy-agent');\nconst { getClient } = require('./sktorrent');\n"
assert needle in s
s = s.replace(needle, repl, 1)

needle = "const RESOLVER_TOKEN = String(process.env.SKTONLINE_RESOLVER_TOKEN || '').trim();\nconst USER_AGENT ="
repl = "const RESOLVER_TOKEN = String(process.env.SKTONLINE_RESOLVER_TOKEN || '').trim();\nconst SKTONLINE_PROXY_URL = String(process.env.SKTONLINE_PROXY_URL || '').trim();\nconst USER_AGENT ="
assert needle in s
s = s.replace(needle, repl, 1)

needle = "function makeHttp(baseURL, timeout = 9000) {\n  return axios.create({\n    baseURL,\n    timeout,\n    maxContentLength: 8 * 1024 * 1024,\n    headers: {"
repl = "function proxyConfig(agent) {\n  return agent ? { httpAgent: agent, httpsAgent: agent, proxy: false } : {};\n}\n\nconst sktOnlineProxyAgent = SKTONLINE_PROXY_URL ? new SocksProxyAgent(SKTONLINE_PROXY_URL) : null;\n\nfunction makeHttp(baseURL, timeout = 9000, agent = null) {\n  return axios.create({\n    baseURL,\n    timeout,\n    maxContentLength: 8 * 1024 * 1024,\n    ...proxyConfig(agent),\n    headers: {"
assert needle in s
s = s.replace(needle, repl, 1)

needle = "const onlineHttp = makeHttp(ONLINE_BASE_URL, 9000);"
repl = "const onlineHttp = makeHttp(ONLINE_BASE_URL, 9000, sktOnlineProxyAgent);"
assert needle in s
s = s.replace(needle, repl, 1)

needle = "    const response = await axios.head(url, {\n      timeout: 2200,"
repl = "    const response = await axios.head(url, {\n      timeout: 2200,\n      ...proxyConfig(sktOnlineProxyAgent),"
assert needle in s
s = s.replace(needle, repl, 1)

p.write_text(s)

# ecosystem.config.js
p = root / 'ecosystem.config.js'
s = p.read_text()
needle = "        PORT: 7003,\n        CONFIG_ENCRYPTION_KEY_FILE: '/home/ubuntu/.stremio-sktonline-config-key'"
repl = "        PORT: 7003,\n        CONFIG_ENCRYPTION_KEY_FILE: '/home/ubuntu/.stremio-sktonline-config-key',\n        SKTONLINE_PROXY_URL: 'socks5h://127.0.0.1:40000'"
assert needle in s
s = s.replace(needle, repl, 1)
p.write_text(s)

# addon.js health visibility
p = root / 'addon.js'
s = p.read_text()
needle = "    resolverConfigured: Boolean(process.env.SKTONLINE_RESOLVER_URL),\n"
repl = "    resolverConfigured: Boolean(process.env.SKTONLINE_RESOLVER_URL),\n    sktonlineProxyConfigured: Boolean(String(process.env.SKTONLINE_PROXY_URL || '').trim()),\n"
assert needle in s
s = s.replace(needle, repl, 1)
p.write_text(s)

# package.json version + dependency
p = root / 'package.json'
pkg = json.loads(p.read_text())
pkg['version'] = '0.1.8'
pkg.setdefault('dependencies', {})['socks-proxy-agent'] = '^8.0.5'
p.write_text(json.dumps(pkg, indent=2, ensure_ascii=False) + '\n')

print('Applied WARP proxy patch v0.1.8')
