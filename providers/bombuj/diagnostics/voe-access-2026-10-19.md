# VOE access failure and quality display

User-reported result after rollout: all three VOE direct choices failed with
403 Access Denied in Stremio. The prior successful Oracle deployment and source
count checks were not evidence of playback from the user's network.

Executor checks of fresh Oracle API results reproduced 403 HTML for all three
HLS masters, both with returned User-Agent/Referer and without headers. Resolving
the exact Slovak and subtitle-group embeds again from the executor produced valid
HLS master/media responses (200) and two MPEG-TS range samples each (206), with
and without headers. The Czech local resolution attempt returned no source.
No token, cookie or signed URL is recorded here.

This strongly indicates resolver-network/IP binding; it does not independently
prove the precise upstream authorization mechanism. Changing labels or adding a
Referer does not fix the demonstrated cross-network rejection. A manifest-only
proxy has not been established as sufficient; no video relay is deployed.

Production VOE direct is disabled using BOMBUJ_DIRECT_VOE=0. Exact original web
players remain available. Re-enabling requires verification from the actual
Stremio client's network. Other provider behavior and catalogs remain intact.

Presentation now follows the existing SKTOnline provider/quality three-line
layout: name `Bombuj • 1080p`, audio line, subtitles line, `🎬 1080p`. The formatter
no longer overwrites a known quality with Direct. HLS RESOLUTION supplies the
quality, with selection of the matching highest-resolution variant. No quality
is inferred from random numbers or tokens in a CDN URL. Missing metadata is
labeled `Kvalita neuvedena`.

HLS inspection is bounded to 64 KiB and five seconds within the VOE resolver
budget, retrieves no segments or protected keys, and rejects HTTP errors, HTML
and invalid playlists. Successful manifest access alone remains insufficient to
establish client playback. New tests cover quality, layout, variant selection,
403, HTML-200 and oversized manifests; full Bombuj checks pass.
