'use strict';

// Video resolvers only need small metadata responses, never a video download.
async function boundedJson(response, maxBytes = 128 * 1024) {
  if (Number(response?.headers?.get('content-length') || 0) > maxBytes) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  const reader = response?.body?.getReader();
  if (!reader) return null;
  const buffers = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) return null;
      buffers.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  try { return JSON.parse(Buffer.concat(buffers).toString('utf8')); }
  catch { return null; }
}

module.exports = { boundedJson };
