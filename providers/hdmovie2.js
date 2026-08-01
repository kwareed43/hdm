// HDMovie2 Nuvio Provider
// Uses the direct WatchKar API and resolves HDM2 or Molop streams.
// Hermes-compatible: Promise chains only, no async/await.

var DIRECT_API = 'https://cluster.watchkar.com/hdseach.php';
var HDM2_ORIGIN = 'https://hdm2.ink';
var MOLOP_ORIGIN = 'https://molop.art';

var UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
  'AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36';

function httpGet(url, extraHeaders) {
  return fetch(url, {
    redirect: 'follow',
    headers: Object.assign(
      {
        'User-Agent': UA,
        Accept: 'text/html,application/json,application/xhtml+xml,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      extraHeaders || {}
    )
  }).then(function (response) {
    if (!response.ok) {
      throw new Error('HTTP ' + response.status);
    }

    return response.text();
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
    .trim();
}

function buildApiUrl(tmdbId, mediaType, season, episode) {
  var query = ['id=' + encodeURIComponent(String(tmdbId))];

  if (mediaType) {
    query.push('type=' + encodeURIComponent(String(mediaType)));
  }

  if (season !== undefined && season !== null && season !== '') {
    query.push('season=' + encodeURIComponent(String(season)));
  }

  if (episode !== undefined && episode !== null && episode !== '') {
    query.push('episode=' + encodeURIComponent(String(episode)));
  }

  return DIRECT_API + '?' + query.join('&');
}

function fetchDirectPlayer(tmdbId, mediaType, season, episode) {
  var apiUrl = buildApiUrl(tmdbId, mediaType, season, episode);

  console.log('[HDMovie2] API: ' + apiUrl);

  return httpGet(apiUrl, {
    Accept: 'application/json'
  }).then(function (body) {
    var data;

    try {
      data = JSON.parse(body);
    } catch (error) {
      console.log(
        '[HDMovie2] Invalid API JSON: ' +
          String(body).substring(0, 300)
      );
      return null;
    }

    if (!data || typeof data !== 'object') {
      return null;
    }

    var playerUrl = normalizeUrl(
      data.url ||
      data.play_url ||
      data.playUrl ||
      data.embed_url ||
      data.embedUrl ||
      ''
    );

    if (!playerUrl) {
      console.log('[HDMovie2] API returned no player URL');
      return null;
    }

    console.log('[HDMovie2] Title: ' + (data.title || 'Unknown'));
    console.log('[HDMovie2] Player: ' + playerUrl);

    return {
      title: data.title || 'Hindi Dubbed • HD',
      url: playerUrl
    };
  });
}

function resolveHdm2(playerUrl) {
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
  return httpGet(playerUrl, {
    Referer: MOLOP_ORIGIN + '/',
    Origin: MOLOP_ORIGIN
  }).then(function (html) {
    var directMatch = html.match(
      /["'](https?:\/\/[^"']+\/master\.m3u8[^"']*)["']/i
    );

    if (directMatch) {
      return {
        url: normalizeUrl(directMatch[1]),
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

var streamUrl =
  MOLOP_ORIGIN +
  '/m3u8/1/' +
  hashMatch[1] +
  '/master.m3u8';

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

  if (url.indexOf('.m3u8') !== -1 || url.indexOf('/playlist/') !== -1) {
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

function getStreams(tmdbId, mediaType, season, episode) {
  var normalizedType =
    String(mediaType || 'movie').toLowerCase() === 'tv'
      ? 'tv'
      : 'movie';

  console.log(
    '[HDMovie2] Start: ' +
      tmdbId +
      ' ' +
      normalizedType +
      (normalizedType === 'tv'
        ? ' S' + season + 'E' + episode
        : '')
  );

  return fetchDirectPlayer(
    tmdbId,
    normalizedType,
    season,
    episode
  )
    .then(function (apiResult) {
      if (!apiResult) {
        return [];
      }

      return resolvePlayer(apiResult.url).then(function (stream) {
        if (!stream || !stream.url) {
          return [];
        }

        return [
          {
            name: 'HDMovie2',
            title: apiResult.title,
            url: stream.url,
            quality: 'Multi',
            headers: stream.headers
          }
        ];
      });
    })
    .catch(function (error) {
      console.error('[HDMovie2] Error: ' + error.message);
      return [];
    });
}

module.exports = {
  getStreams: getStreams
};
