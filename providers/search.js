// HDMovie2 Nuvio Provider - MERGED + SOURCE FALLBACK
// Movie API: https://cluster.watchkar.com/hdseach.php
// TV API:    https://cluster.watchkar.com/hdmtv.php
//
// Movie flow:
// 1) Try existing WatchKar API / MySQL cache.
// 2) If movie API returns no usable result, fetch TMDB title/year.
// 3) Search owner's source site: https://hdmovie2a.icu/
// 4) Open candidates and verify exact TMDb ID from source page.
// 5) Extract post ID.
// 6) Call doo_player_ajax servers 1..4 and extract HDM2/Molop player URL.
// 7) Save the discovered result back to MySQL through hdsave.php URL parameters.
// 8) Resolve the player and return the stream in the same request.
//
// TV continues using the existing TV API.
// Hermes-compatible: Promise chains only, no async/await.

var MOVIE_API = 'https://cluster.watchkar.com/hdseach.php';
var TV_API = 'https://cluster.watchkar.com/hdmtv.php';

var SOURCE_ORIGIN = 'https://hdmovie2a.icu';
var SOURCE_SEARCH = SOURCE_ORIGIN + '/';
var SOURCE_AJAX = SOURCE_ORIGIN + '/wp-admin/admin-ajax.php';

var SAVE_API = 'https://cluster.watchkar.com/hdsave.php';

// Existing TMDB API key from the current backend configuration.
var TMDB_KEY = 'd80ba92bc7cefe3359668d30d06f3305';
var TMDB_API = 'https://api.themoviedb.org/3';

var HDM2_ORIGIN = 'https://hdm2.ink';
var MOLOP_ORIGIN = 'https://molop.art';

var UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/120.0.0.0 Safari/537.36';

function httpRequest(url, options) {
  options = options || {};

  var headers = Object.assign(
    {
      'User-Agent': UA,
      Accept: 'text/html,application/json,application/xhtml+xml,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9'
    },
    options.headers || {}
  );

  return fetch(url, {
    method: options.method || 'GET',
    redirect: 'follow',
    headers: headers,
    body: options.body
  }).then(function (response) {
    return response.text().then(function (body) {
      return {
        ok: response.ok,
        status: response.status,
        url: response.url || url,
        body: body
      };
    });
  });
}

function httpGet(url, extraHeaders) {
  return httpRequest(url, {
    method: 'GET',
    headers: extraHeaders || {}
  }).then(function (result) {
    if (!result.ok) {
      throw new Error('HTTP ' + result.status + ' for ' + url);
    }

    return result.body;
  });
}

function httpPostForm(url, formBody, extraHeaders) {
  var headers = Object.assign(
    {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
    },
    extraHeaders || {}
  );

  return httpRequest(url, {
    method: 'POST',
    headers: headers,
    body: formBody
  }).then(function (result) {
    if (!result.ok) {
      throw new Error('HTTP ' + result.status + ' for ' + url);
    }

    return result.body;
  });
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#039;/gi, "'")
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&nbsp;/gi, ' ');
}

function normalizeUrl(value) {
  return decodeHtmlEntities(value)
    .replace(/\\\//g, '/')
    .replace(/\\u0026/gi, '&')
    .trim();
}

function absoluteSourceUrl(value) {
  var url = normalizeUrl(value);

  if (!url) {
    return '';
  }

  if (/^https?:\/\//i.test(url)) {
    return url;
  }

  if (url.indexOf('//') === 0) {
    return 'https:' + url;
  }

  if (url.charAt(0) !== '/') {
    url = '/' + url;
  }

  return SOURCE_ORIGIN + url;
}

function normalizeMediaType(mediaType) {
  return String(mediaType || 'movie').toLowerCase() === 'tv'
    ? 'tv'
    : 'movie';
}

function buildApiUrl(tmdbId, mediaType, season, episode) {
  var type = normalizeMediaType(mediaType);
  var apiBase = type === 'tv' ? TV_API : MOVIE_API;
  var query = [
    'id=' + encodeURIComponent(String(tmdbId)),
    'type=' + encodeURIComponent(type)
  ];

  if (
    type === 'tv' &&
    season !== undefined &&
    season !== null &&
    season !== ''
  ) {
    query.push('season=' + encodeURIComponent(String(season)));
  }

  if (
    type === 'tv' &&
    episode !== undefined &&
    episode !== null &&
    episode !== ''
  ) {
    query.push('episode=' + encodeURIComponent(String(episode)));
  }

  return apiBase + '?' + query.join('&');
}

function getPlayerUrl(item) {
  if (!item || typeof item !== 'object') {
    return '';
  }

  return normalizeUrl(
    item.url ||
    item.play_url ||
    item.playUrl ||
    item.embed_url ||
    item.embedUrl ||
    ''
  );
}

function normalizeApiResponse(data) {
  if (!data) {
    return [];
  }

  if (Array.isArray(data)) {
    return data;
  }

  if (typeof data === 'object') {
    // Explicit API error object must NOT be treated as a media result.
    if (data.success === false) {
      return [];
    }

    if (Array.isArray(data.results)) {
      return data.results;
    }

    if (Array.isArray(data.data)) {
      return data.data;
    }

    if (data.data && typeof data.data === 'object') {
      return [data.data];
    }

    // Only accept a single object when it actually contains a player URL.
    if (getPlayerUrl(data)) {
      return [data];
    }
  }

  return [];
}

function fetchPrimaryApiResults(tmdbId, mediaType, season, episode) {
  var apiUrl = buildApiUrl(tmdbId, mediaType, season, episode);

  console.log('[HDMovie2] API: ' + apiUrl);

  return httpGet(apiUrl, {
    Accept: 'application/json'
  }).then(function (body) {
    var parsed;

    try {
      parsed = JSON.parse(body);
    } catch (error) {
      console.log(
        '[HDMovie2] Invalid API JSON: ' +
          String(body).substring(0, 500)
      );
      return [];
    }

    var items = normalizeApiResponse(parsed);

    if (items.length === 0) {
      console.log('[HDMovie2] API returned no usable results');
      return [];
    }

    console.log('[HDMovie2] API results: ' + items.length);
    return items;
  });
}

// -----------------------------------------------------------------------------
// TMDB metadata used only for movie DB-miss fallback.
// -----------------------------------------------------------------------------

function fetchTmdbMovieMetadata(tmdbId) {
  var url =
    TMDB_API +
    '/movie/' +
    encodeURIComponent(String(tmdbId)) +
    '?api_key=' +
    encodeURIComponent(TMDB_KEY);

  console.log('[HDMovie2] TMDB fallback metadata: ' + url);

  return httpGet(url, {
    Accept: 'application/json'
  }).then(function (body) {
    var data;

    try {
      data = JSON.parse(body);
    } catch (error) {
      throw new Error('Invalid TMDB JSON');
    }

    if (!data || data.id === undefined || data.id === null) {
      throw new Error('TMDB movie not found');
    }

    var title = String(data.title || data.original_title || '').trim();
    var releaseDate = String(data.release_date || '').trim();
    var year = '';

    if (/^\d{4}/.test(releaseDate)) {
      year = releaseDate.substring(0, 4);
    }

    if (!title) {
      throw new Error('TMDB title missing');
    }

    return {
      tmdbId: String(data.id),
      title: title,
      year: year
    };
  });
}

// -----------------------------------------------------------------------------
// Source search / candidate extraction.
// -----------------------------------------------------------------------------

function cleanSourceTitle(value) {
  return decodeHtmlEntities(String(value || ''))
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractYear(value) {
  var match = String(value || '').match(/\b(19\d{2}|20\d{2})\b/);
  return match ? match[1] : '';
}

function sourceSearchTerms(title, year) {
  var list = [];
  var base = String(title || '').trim();

  if (base) {
    list.push(base);
  }

  if (base && year) {
    list.push(base + ' ' + year);
  }

  // Short title before colon is sometimes indexed more reliably.
  if (base.indexOf(':') !== -1) {
    var shortTitle = base.split(':')[0].trim();

    if (shortTitle && shortTitle !== base) {
      list.push(shortTitle);

      if (year) {
        list.push(shortTitle + ' ' + year);
      }
    }
  }

  var seen = {};
  return list.filter(function (item) {
    var key = item.toLowerCase();

    if (seen[key]) {
      return false;
    }

    seen[key] = true;
    return true;
  });
}

function parseSourceSearchResults(html) {
  var results = [];
  var seen = {};
  var source = String(html || '');

  // Capture movie-like post URLs from href attributes.
  var regex =
    /href\s*=\s*["']([^"']*\/(?:movies|movie)\/[^"'?#]+\/?[^"']*)["']/gi;

  var match;

  while ((match = regex.exec(source)) !== null) {
    var url = absoluteSourceUrl(match[1]);

    if (!url) {
      continue;
    }

    var key = url.toLowerCase();

    if (seen[key]) {
      continue;
    }

    seen[key] = true;

    var beforeStart = Math.max(0, match.index - 800);
    var afterEnd = Math.min(source.length, regex.lastIndex + 1200);
    var nearby = source.substring(beforeStart, afterEnd);

    var title = '';

    var altMatch = nearby.match(/\balt\s*=\s*["']([^"']+)["']/i);
    if (altMatch) {
      title = cleanSourceTitle(altMatch[1]);
    }

    if (!title) {
      var titleAttrMatch = nearby.match(/\btitle\s*=\s*["']([^"']+)["']/i);
      if (titleAttrMatch) {
        title = cleanSourceTitle(titleAttrMatch[1]);
      }
    }

    var pathMatch = url.match(/\/(?:movies|movie)\/([^/?#]+)/i);
    var slug = pathMatch ? pathMatch[1] : '';

    if (!title && slug) {
      title = cleanSourceTitle(
        slug
          .replace(/^\d+-/, '')
          .replace(/[-_]+/g, ' ')
      );
    }

    results.push({
      title: title,
      year: extractYear(title + ' ' + slug),
      slug: slug,
      url: url
    });
  }

  return results;
}

function searchSource(title, year) {
  var terms = sourceSearchTerms(title, year);
  var all = [];
  var seen = {};
  var chain = Promise.resolve();

  terms.forEach(function (term) {
    chain = chain.then(function () {
      var url =
        SOURCE_SEARCH +
        '?s=' +
        encodeURIComponent(term);

      console.log('[HDMovie2] Source search: ' + url);

      return httpGet(url, {
        Referer: SOURCE_ORIGIN + '/',
        Accept: 'text/html,application/xhtml+xml,*/*;q=0.8'
      })
        .then(function (html) {
          var items = parseSourceSearchResults(html);

          console.log(
            '[HDMovie2] Source candidates for "' +
              term +
              '": ' +
              items.length
          );

          items.forEach(function (item) {
            var key = String(item.url || '').toLowerCase();

            if (!key || seen[key]) {
              return;
            }

            seen[key] = true;
            all.push(item);
          });
        })
        .catch(function (error) {
          console.log(
            '[HDMovie2] Source search failed for "' +
              term +
              '": ' +
              error.message
          );
        });
    });
  });

  return chain.then(function () {
    return all;
  });
}

// -----------------------------------------------------------------------------
// Exact TMDb verification and post ID extraction from source page.
// -----------------------------------------------------------------------------

function extractSourceTmdbId(html) {
  var source = decodeHtmlEntities(String(html || ''));

  var patterns = [
    /\bTMDb\s*ID\s*:?\s*(\d+)\b/i,
    /\bTMDB\s*ID\s*:?\s*(\d+)\b/i,
    /\btmdb[_-]?id["']?\s*[:=]\s*["']?(\d+)/i,
    /["']tmdb[_-]?id["']\s*:\s*["']?(\d+)/i,
    /themoviedb\.org\/(?:movie|tv)\/(\d+)/i,
    /api\.themoviedb\.org\/3\/(?:movie|tv)\/(\d+)/i,
    /\btmdb\s*[:#-]?\s*(\d{4,})\b/i
  ];

  var i;

  for (i = 0; i < patterns.length; i++) {
    var match = source.match(patterns[i]);

    if (match && match[1]) {
      return String(match[1]);
    }
  }

  return '';
}

function extractPostId(html) {
  var source = String(html || '');

  var patterns = [
    /postid-(\d+)/i,
    /postid["']?\s*[:=]\s*["']?(\d+)/i,
    /data-post\s*=\s*["']?(\d+)["']?/i,
    /\bpost-(\d+)\b/i,
    /data-id\s*=\s*["']?(\d+)["']?/i,
    /doo_player_ajax[\s\S]{0,2000}?post["']?\s*[:=]\s*["']?(\d+)/i
  ];

  var i;

  for (i = 0; i < patterns.length; i++) {
    var match = source.match(patterns[i]);

    if (match && match[1]) {
      return String(match[1]);
    }
  }

  return '';
}

function fetchAndVerifyCandidate(candidate, wantedTmdbId) {
  console.log('[HDMovie2] Checking source candidate: ' + candidate.url);

  return httpGet(candidate.url, {
    Referer: SOURCE_ORIGIN + '/',
    Accept: 'text/html,application/xhtml+xml,*/*;q=0.8'
  })
    .then(function (html) {
      var sourceTmdbId = extractSourceTmdbId(html);

      if (!sourceTmdbId) {
        console.log(
          '[HDMovie2] Candidate has no TMDb ID: ' +
            candidate.url
        );

        return null;
      }

      if (String(sourceTmdbId) !== String(wantedTmdbId)) {
        console.log(
          '[HDMovie2] TMDb mismatch: wanted=' +
            wantedTmdbId +
            ' found=' +
            sourceTmdbId
        );

        return null;
      }

      var postId = extractPostId(html);

      if (!postId) {
        console.log(
          '[HDMovie2] Exact TMDb match but post ID missing: ' +
            candidate.url
        );

        return null;
      }

      console.log(
        '[HDMovie2] Exact TMDb match: ' +
          wantedTmdbId +
          ' post=' +
          postId
      );

      return {
        title: candidate.title || '',
        sourceUrl: candidate.url,
        postId: postId,
        html: html
      };
    })
    .catch(function (error) {
      console.log(
        '[HDMovie2] Candidate request failed: ' +
          candidate.url +
          ' | ' +
          error.message
      );

      return null;
    });
}

function findExactSourceCandidate(candidates, tmdbId) {
  var found = null;
  var chain = Promise.resolve();

  candidates.forEach(function (candidate) {
    chain = chain.then(function () {
      if (found) {
        return null;
      }

      return fetchAndVerifyCandidate(candidate, tmdbId)
        .then(function (result) {
          if (result) {
            found = result;
          }
        });
    });
  });

  return chain.then(function () {
    return found;
  });
}

// -----------------------------------------------------------------------------
// Source player extraction.
// -----------------------------------------------------------------------------

function extractPlayerUrl(response) {
  var text = normalizeUrl(response);
  var embedText = text;

  try {
    var parsed = JSON.parse(response);

    if (parsed && typeof parsed === 'object') {
      embedText = normalizeUrl(
        parsed.embed_url ||
        parsed.embedUrl ||
        parsed.url ||
        parsed.html ||
        (parsed.data && parsed.data.embed_url) ||
        response
      );
    }
  } catch (error) {
    // Plain text/HTML response is allowed.
  }

  var patterns = [
    /https?:\/\/(?:www\.)?hdm2\.ink\/play\?v=[A-Za-z0-9_-]+/i,
    /https?:\/\/(?:www\.)?molop\.art\/watch\?v=[A-Za-z0-9_-]+/i
  ];

  var i;

  for (i = 0; i < patterns.length; i++) {
    var match = embedText.match(patterns[i]);

    if (match && match[0]) {
      return normalizeUrl(match[0]);
    }
  }

  return '';
}

function getSourcePlayerUrl(postId, sourceUrl, mediaType) {
  var type = normalizeMediaType(mediaType);
  var server = 1;

  function tryNextServer() {
    if (server > 4) {
      return Promise.resolve('');
    }

    var currentServer = server;
    server += 1;

    var body =
      'action=' + encodeURIComponent('doo_player_ajax') +
      '&post=' + encodeURIComponent(String(postId)) +
      '&nume=' + encodeURIComponent(String(currentServer)) +
      '&type=' + encodeURIComponent(type);

    console.log(
      '[HDMovie2] Source AJAX server ' +
        currentServer +
        ' post=' +
        postId
    );

    return httpPostForm(
      SOURCE_AJAX,
      body,
      {
        Referer: sourceUrl,
        Origin: SOURCE_ORIGIN,
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'application/json,text/javascript,*/*;q=0.01'
      }
    )
      .then(function (response) {
        var playerUrl = extractPlayerUrl(response);

        if (playerUrl) {
          console.log(
            '[HDMovie2] Source player found: ' +
              playerUrl
          );

          return playerUrl;
        }

        return tryNextServer();
      })
      .catch(function (error) {
        console.log(
          '[HDMovie2] Source AJAX server ' +
            currentServer +
            ' failed: ' +
            error.message
        );

        return tryNextServer();
      });
  }

  return tryNextServer();
}

// -----------------------------------------------------------------------------
// Save newly discovered result to backend MySQL.
// hdsave.php is expected to accept GET parameters:
// tmdb_id, type, title, url, source_url, post_id
// -----------------------------------------------------------------------------

function saveDiscoveredResult(
  tmdbId,
  mediaType,
  title,
  playerUrl,
  sourceUrl,
  postId
) {
  var saveUrl =
    SAVE_API +
    '?tmdb_id=' + encodeURIComponent(String(tmdbId)) +
    '&type=' + encodeURIComponent(normalizeMediaType(mediaType)) +
    '&title=' + encodeURIComponent(String(title || '')) +
    '&url=' + encodeURIComponent(String(playerUrl || '')) +
    '&source_url=' + encodeURIComponent(String(sourceUrl || '')) +
    '&post_id=' + encodeURIComponent(String(postId || ''));

  console.log('[HDMovie2] Saving discovered result to DB');

  return httpGet(saveUrl, {
    Accept: 'application/json'
  })
    .then(function (body) {
      try {
        var result = JSON.parse(body);

        if (result && result.success === false) {
          console.log(
            '[HDMovie2] Save API rejected result: ' +
              String(result.message || 'unknown error')
          );
        } else {
          console.log('[HDMovie2] Result saved to DB');
        }

        return result;
      } catch (error) {
        console.log(
          '[HDMovie2] Save API non-JSON response: ' +
            String(body).substring(0, 300)
        );

        return null;
      }
    })
    .catch(function (error) {
      // Saving failure must NOT block playback.
      console.log(
        '[HDMovie2] DB save failed: ' +
          error.message
      );

      return null;
    });
}

function discoverMovieFromSource(tmdbId) {
  console.log(
    '[HDMovie2] Movie DB/API miss. Starting source fallback for TMDB ' +
      tmdbId
  );

  return fetchTmdbMovieMetadata(tmdbId)
    .then(function (meta) {
      console.log(
        '[HDMovie2] TMDB: ' +
          meta.title +
          (meta.year ? ' (' + meta.year + ')' : '')
      );

      return searchSource(meta.title, meta.year)
        .then(function (candidates) {
          if (!candidates || candidates.length === 0) {
            console.log('[HDMovie2] Source search returned 0 candidates');
            return null;
          }

          return findExactSourceCandidate(
            candidates,
            meta.tmdbId
          ).then(function (found) {
            if (!found) {
              console.log(
                '[HDMovie2] No exact source TMDb candidate found'
              );
              return null;
            }

            return getSourcePlayerUrl(
              found.postId,
              found.sourceUrl,
              'movie'
            ).then(function (playerUrl) {
              if (!playerUrl) {
                console.log(
                  '[HDMovie2] Exact source movie found but player missing'
                );
                return null;
              }

              var finalTitle =
                found.title ||
                meta.title +
                  (meta.year ? ' (' + meta.year + ')' : '');

              // Save in background of the same Promise chain, but playback
              // still succeeds even if the save endpoint fails.
              return saveDiscoveredResult(
                meta.tmdbId,
                'movie',
                finalTitle,
                playerUrl,
                found.sourceUrl,
                found.postId
              ).then(function () {
                return [
                  {
                    tmdbId: meta.tmdbId,
                    title: finalTitle,
                    url: playerUrl,
                    source_url: found.sourceUrl,
                    post_id: found.postId
                  }
                ];
              });
            });
          });
        });
    })
    .catch(function (error) {
      console.log(
        '[HDMovie2] Source fallback error: ' +
          error.message
      );

      return [];
    });
}

// -----------------------------------------------------------------------------
// Primary API + fallback.
// -----------------------------------------------------------------------------

function fetchApiResults(tmdbId, mediaType, season, episode) {
  var type = normalizeMediaType(mediaType);

  return fetchPrimaryApiResults(
    tmdbId,
    type,
    season,
    episode
  )
    .then(function (items) {
      if (items && items.length > 0) {
        return items;
      }

      // Source fallback is intentionally only for movies.
      // TV continues through the existing hdmtv.php API.
      if (type !== 'movie') {
        return [];
      }

      return discoverMovieFromSource(tmdbId);
    })
    .catch(function (error) {
      console.log(
        '[HDMovie2] Primary API error: ' +
          error.message
      );

      if (type !== 'movie') {
        return [];
      }

      return discoverMovieFromSource(tmdbId);
    });
}

// -----------------------------------------------------------------------------
// Player resolution.
// -----------------------------------------------------------------------------

function resolveHdm2(playerUrl) {
  console.log('[HDMovie2] Resolving HDM2: ' + playerUrl);

  return httpGet(playerUrl, {
    Referer: HDM2_ORIGIN + '/',
    Origin: HDM2_ORIGIN
  }).then(function (html) {
    var match =
      html.match(/data-stream-url\s*=\s*["']([^"']+)["']/i) ||
      html.match(/["'](https?:\/\/[^"']+\/playlist\/[^"']+)["']/i) ||
      html.match(/["']([^"']+\.m3u8[^"']*)["']/i);

    if (!match) {
      console.log('[HDMovie2] HDM2 stream URL not found');
      return null;
    }

    var streamUrl = normalizeUrl(match[1]);

    if (!/^https?:\/\//i.test(streamUrl)) {
      if (streamUrl.charAt(0) !== '/') {
        streamUrl = '/' + streamUrl;
      }

      streamUrl = HDM2_ORIGIN + streamUrl;
    }

    if (
      streamUrl.indexOf('.m3u8') === -1 &&
      streamUrl.indexOf('#index.m3u8') === -1
    ) {
      streamUrl += '#index.m3u8';
    }

    console.log('[HDMovie2] HDM2 stream resolved: ' + streamUrl);

    return {
      url: streamUrl,
      headers: {
        Referer: HDM2_ORIGIN + '/',
        Origin: HDM2_ORIGIN,
        'User-Agent': UA
      }
    };
  });
}

function resolveMolop(playerUrl) {
  console.log('[HDMovie2] Resolving Molop: ' + playerUrl);

  return httpGet(playerUrl, {
    Referer: MOLOP_ORIGIN + '/',
    Origin: MOLOP_ORIGIN
  }).then(function (html) {
    var directMatch = html.match(
      /["'](https?:\/\/[^"']+\/master\.m3u8[^"']*)["']/i
    );

    if (directMatch) {
      var directUrl = normalizeUrl(directMatch[1]);

      console.log('[HDMovie2] Molop direct stream: ' + directUrl);

      return {
        url: directUrl,
        headers: {
          Referer: MOLOP_ORIGIN + '/',
          Origin: MOLOP_ORIGIN,
          'User-Agent': UA
        }
      };
    }

    var hashMatch =
      html.match(
        /sniff\s*\(\s*["'][^"']+["']\s*,\s*["'][^"']+["']\s*,\s*["']([a-f0-9]+)["']/i
      ) ||
      html.match(
        /["']([a-f0-9]{24,64})["'][\s\S]*?master\.m3u8/i
      );

    if (!hashMatch) {
      console.log('[HDMovie2] Molop hash not found');
      return null;
    }

    var originalStreamUrl =
      MOLOP_ORIGIN +
      '/m3u8/1/' +
      hashMatch[1] +
      '/master.m3u8';

    var streamUrl =
      'https://cluster.watchkar.com/mop.php?url=' +
      encodeURIComponent(originalStreamUrl);

    console.log(
      '[HDMovie2] Molop proxied stream: ' +
        streamUrl
    );

    return {
      url: streamUrl,
      headers: {
        Referer: MOLOP_ORIGIN + '/',
        Origin: MOLOP_ORIGIN,
        'User-Agent': UA
      }
    };
  });
}

function resolvePlayer(playerUrl) {
  var url = normalizeUrl(playerUrl);

  if (!url) {
    return Promise.resolve(null);
  }

  if (
    url.indexOf('.m3u8') !== -1 ||
    url.indexOf('/playlist/') !== -1
  ) {
    var isMolop = url.indexOf('molop.art') !== -1;
    var origin = isMolop ? MOLOP_ORIGIN : HDM2_ORIGIN;

    return Promise.resolve({
      url: url,
      headers: {
        Referer: origin + '/',
        Origin: origin,
        'User-Agent': UA
      }
    });
  }

  if (
    url.indexOf('hdm2.ink/play') !== -1 ||
    url.indexOf('hdm2.ink/embed') !== -1
  ) {
    return resolveHdm2(url);
  }

  if (
    url.indexOf('molop.art/watch') !== -1 ||
    url.indexOf('molop.art/embed') !== -1
  ) {
    return resolveMolop(url);
  }

  console.log('[HDMovie2] Unsupported player URL: ' + url);
  return Promise.resolve(null);
}

function makeStreamName(item, mediaType, season, episode, index) {
  if (item && item.name) {
    return String(item.name);
  }

  if (mediaType === 'tv') {
    if (
      item &&
      item.episode !== undefined &&
      item.episode !== null
    ) {
      return 'EP' + String(item.episode).padStart(2, '0');
    }

    if (
      episode !== undefined &&
      episode !== null &&
      episode !== ''
    ) {
      return 'EP' + String(episode).padStart(2, '0');
    }

    return 'EP' + String(index + 1).padStart(2, '0');
  }

  return 'HDMovie2';
}

function resolveApiItem(item, mediaType, season, episode, index) {
  item = item || {};

  var playerUrl = getPlayerUrl(item);

  if (!playerUrl) {
    console.log(
      '[HDMovie2] Result ' +
        (index + 1) +
        ' has no player URL'
    );

    return Promise.resolve(null);
  }

  var name = makeStreamName(
    item,
    mediaType,
    season,
    episode,
    index
  );

  var title = item.title || name;

  console.log(
    '[HDMovie2] Result ' +
      (index + 1) +
      ': ' +
      title
  );

  console.log('[HDMovie2] Player: ' + playerUrl);

  return resolvePlayer(playerUrl)
    .then(function (stream) {
      if (!stream || !stream.url) {
        return null;
      }

      return {
        name: name,
        title: title,
        url: stream.url,
        quality:
          item.quality ||
          (mediaType === 'tv' ? '1080p' : 'Multi'),
        headers: item.headers || stream.headers
      };
    })
    .catch(function (error) {
      console.log(
        '[HDMovie2] ' +
          name +
          ' resolve error: ' +
          error.message
      );

      return null;
    });
}

function resolveAllItems(items, mediaType, season, episode) {
  var streams = [];
  var chain = Promise.resolve();

  items.forEach(function (item, index) {
    chain = chain.then(function () {
      return resolveApiItem(
        item,
        mediaType,
        season,
        episode,
        index
      ).then(function (stream) {
        if (stream) {
          streams.push(stream);
        }
      });
    });
  });

  return chain.then(function () {
    return streams;
  });
}

function getStreams(tmdbId, mediaType, season, episode) {
  var normalizedType = normalizeMediaType(mediaType);

  console.log(
    '[HDMovie2] Start: ' +
      tmdbId +
      ' ' +
      normalizedType +
      (normalizedType === 'tv'
        ? ' S' + season + 'E' + episode
        : '')
  );

  return fetchApiResults(
    tmdbId,
    normalizedType,
    season,
    episode
  )
    .then(function (items) {
      if (!items || items.length === 0) {
        return [];
      }

      return resolveAllItems(
        items,
        normalizedType,
        season,
        episode
      );
    })
    .then(function (streams) {
      console.log(
        '[HDMovie2] Final streams: ' +
          streams.length
      );

      return streams;
    })
    .catch(function (error) {
      console.error(
        '[HDMovie2] Error: ' +
          error.message
      );

      return [];
    });
}

module.exports = {
  getStreams: getStreams
};
