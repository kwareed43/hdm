// HDMovie2 Nuvio Provider
// Uses the direct WatchKar API and resolves HDM2 or Molop streams.
// Hermes-compatible: Promise chains only, no async/await.

var DIRECT_API = 'https://cluster.watchkar.com/hdseach.php';
var HDM2_ORIGIN = 'https://hdm2.ink';
var MOLOP_ORIGIN = 'https://molop.art';

var MOLOP_PROXY = 'https://cluster.watchkar.com/mop.php?url=';

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

/*
|--------------------------------------------------------------------------
| Molop Proxy
|--------------------------------------------------------------------------
|
| Input:
| https://molop.art/m3u8/2/HASH/master.txt?s=1&cache=1
|
| Output:
| https://cluster.watchkar.com/mop.php?url=https://molop.art/m3u8/2/HASH/master.txt?s=1&cache=1
|
*/

function wrapMolopUrl(url) {
  url = normalizeUrl(url);

  if (url.indexOf(MOLOP_PROXY) === 0) {
    return url;
  }

  if (url.indexOf('https://molop.art/') === 0) {
    return MOLOP_PROXY + url;
  }

  return url;
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
  var apiUrl = buildApiUrl(
    tmdbId,
    mediaType,
    season,
    episode
  );

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

    console.log(
      '[HDMovie2] Title: ' +
      (data.title || 'Unknown')
    );

    console.log(
      '[HDMovie2] Player: ' +
      playerUrl
    );

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
      html.match(
        /data-stream-url\s*=\s*["']([^"']+)["']/i
      ) ||
      html.match(
        /["'](https?:\/\/[^"']+\/playlist\/[^"']+)["']/i
      ) ||
      html.match(
        /["']([^"']+\.m3u8[^"']*)["']/i
      );

    if (!match) {
      console.log(
        '[HDMovie2] HDM2 stream URL not found'
      );

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

    console.log(
      '[HDMovie2] HDM2 Stream: ' +
      streamUrl
    );

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

    /*
    |--------------------------------------------------------------------------
    | Direct Molop stream URL
    |--------------------------------------------------------------------------
    */

    var directMatch = html.match(
      /["'](https?:\/\/[^"']+\/master\.(?:m3u8|txt)[^"']*)["']/i
    );

    if (directMatch) {
      var directUrl = normalizeUrl(
        directMatch[1]
      );

      var proxiedDirectUrl =
        wrapMolopUrl(directUrl);

      console.log(
        '[HDMovie2] Molop Direct: ' +
        directUrl
      );

      console.log(
        '[HDMovie2] Molop Proxy: ' +
        proxiedDirectUrl
      );

      return {
        url: proxiedDirectUrl,
        headers: {
          'User-Agent': UA
        }
      };
    }


    /*
    |--------------------------------------------------------------------------
    | Extract Molop hash
    |--------------------------------------------------------------------------
    */

    var hashMatch =
      html.match(
        /sniff\s*\(\s*["'][^"']+["']\s*,\s*["'][^"']+["']\s*,\s*["']([a-f0-9]+)["']/i
      ) ||
      html.match(
        /["']([a-f0-9]{24,64})["'][\s\S]*?master\.(?:m3u8|txt)/i
      );

    if (!hashMatch) {
      console.log(
        '[HDMovie2] Molop hash not found'
      );

      return null;
    }

    /*
    |--------------------------------------------------------------------------
    | Build actual Molop URL
    |--------------------------------------------------------------------------
    |
    | Using /m3u8/2/ and master.txt as requested.
    |
    */

    var actualStreamUrl =
      MOLOP_ORIGIN +
      '/m3u8/2/' +
      hashMatch[1] +
      '/master.txt?s=1&cache=1';


    /*
    |--------------------------------------------------------------------------
    | Add WatchKar proxy before actual Molop URL
    |--------------------------------------------------------------------------
    */

    var streamUrl =
      wrapMolopUrl(actualStreamUrl);

    console.log(
      '[HDMovie2] Molop Actual: ' +
      actualStreamUrl
    );

    console.log(
      '[HDMovie2] Molop Proxy: ' +
      streamUrl
    );

    return {
      url: streamUrl,
      headers: {
        'User-Agent': UA
      }
    };
  });
}

function resolvePlayer(playerUrl) {
  var url = normalizeUrl(playerUrl);

  /*
  |--------------------------------------------------------------------------
  | Direct Molop stream
  |--------------------------------------------------------------------------
  */

  if (
    url.indexOf('molop.art/m3u8/') !== -1 ||
    url.indexOf('molop.art/stream/') !== -1
  ) {
    var proxiedUrl = wrapMolopUrl(url);

    console.log(
      '[HDMovie2] Molop Proxy: ' +
      proxiedUrl
    );

    return Promise.resolve({
      url: proxiedUrl,
      headers: {
        'User-Agent': UA
      }
    });
  }


  /*
  |--------------------------------------------------------------------------
  | Other direct streams
  |--------------------------------------------------------------------------
  */

  if (
    url.indexOf('.m3u8') !== -1 ||
    url.indexOf('/playlist/') !== -1
  ) {
    return Promise.resolve({
      url: url,
      headers: {
        Referer: HDM2_ORIGIN + '/',
        Origin: HDM2_ORIGIN,
        'User-Agent': UA
      }
    });
  }


  /*
  |--------------------------------------------------------------------------
  | HDM2 player
  |--------------------------------------------------------------------------
  */

  if (
    url.indexOf('hdm2.ink/play') !== -1 ||
    url.indexOf('hdm2.ink/embed') !== -1
  ) {
    return resolveHdm2(url);
  }


  /*
  |--------------------------------------------------------------------------
  | Molop player
  |--------------------------------------------------------------------------
  */

  if (
    url.indexOf('molop.art/watch') !== -1 ||
    url.indexOf('molop.art/embed') !== -1
  ) {
    return resolveMolop(url);
  }

  console.log(
    '[HDMovie2] Unsupported player URL: ' +
    url
  );

  return Promise.resolve(null);
}

function getStreams(
  tmdbId,
  mediaType,
  season,
  episode
) {
  var normalizedType =
    String(mediaType || 'movie')
      .toLowerCase() === 'tv'
      ? 'tv'
      : 'movie';

  console.log(
    '[HDMovie2] Start: ' +
    tmdbId +
    ' ' +
    normalizedType +
    (
      normalizedType === 'tv'
        ? ' S' + season + 'E' + episode
        : ''
    )
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

      return resolvePlayer(
        apiResult.url
      ).then(function (stream) {
        if (!stream || !stream.url) {
          return [];
        }

        console.log(
          '[HDMovie2] Final Stream: ' +
          stream.url
        );

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
