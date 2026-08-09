// HDMovie2 Nuvio Provider
// Supports:
// - API: https://cluster.watchkar.com/hdmtv.php
// - HDM2 player URLs: https://hdm2.ink/play?v=...
// - Molop player URLs: https://molop.art/watch?v=...

var API_BASE = 'https://cluster.watchkar.com/hdmtv.php';
var HDM2 = 'https://hdm2.ink';
var MOLOP = 'https://molop.art';

var UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
  'AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36';

async function httpGet(url, headers) {
  var response = await fetch(url, {
    method: 'GET',
    redirect: 'follow',
    headers: Object.assign(
      {
        'User-Agent': UA,
        Accept: '*/*'
      },
      headers || {}
    )
  });

  if (!response.ok) {
    throw new Error(
      'HTTP ' + response.status + ' for ' + url
    );
  }

  return await response.text();
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#039;/gi, "'")
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

async function resolveHdm2(playerUrl) {
  console.log(
    '[HDMovie2] Resolving HDM2: ' + playerUrl
  );

  var html = await httpGet(playerUrl, {
    Referer: HDM2 + '/',
    Origin: HDM2
  });

  var match = html.match(
    /data-stream-url\s*=\s*["']([^"']+)["']/i
  );

  if (!match) {
    console.log(
      '[HDMovie2] HDM2 data-stream-url not found'
    );

    return null;
  }

  var streamUrl = decodeHtml(match[1]).trim();

  if (!/^https?:\/\//i.test(streamUrl)) {
    streamUrl =
      HDM2.replace(/\/$/, '') +
      (streamUrl.startsWith('/') ? '' : '/') +
      streamUrl;
  }

  if (!streamUrl.includes('.m3u8')) {
    streamUrl += '#index.m3u8';
  }

  console.log(
    '[HDMovie2] HDM2 stream resolved: ' +
      streamUrl
  );

  return {
    url: streamUrl,
    headers: {
      Referer: HDM2 + '/',
      Origin: HDM2,
      'User-Agent': UA
    }
  };
}

async function resolveMolop(playerUrl) {
  console.log(
    '[HDMovie2] Resolving Molop: ' + playerUrl
  );

  var html = await httpGet(playerUrl, {
    Referer: MOLOP + '/',
    Origin: MOLOP
  });

  var match = html.match(
    /sniff\s*\(\s*["'][^"']+["']\s*,\s*["'][^"']+["']\s*,\s*["']([a-f0-9]+)["']/i
  );

  if (!match) {
    match = html.match(
      /["']([a-f0-9]{24,64})["'][\s\S]*?master\.m3u8/i
    );
  }

  if (!match) {
    console.log(
      '[HDMovie2] Molop hash not found'
    );

    return null;
  }

  var hash = match[1];

  var streamUrl =
    MOLOP +
    '/m3u8/1/' +
    hash +
    '/master.m3u8?s=1&cache=1';

  console.log(
    '[HDMovie2] Molop stream resolved: ' +
      streamUrl
  );

  return {
    url: streamUrl,
    headers: {
      Referer: MOLOP + '/',
      Origin: MOLOP,
      'User-Agent': UA
    }
  };
}

function buildApiUrl(
  tmdbId,
  type,
  season,
  episode
) {
  var params = [];

  params.push(
    'id=' + encodeURIComponent(tmdbId)
  );

  params.push(
    'type=' +
      encodeURIComponent(type || 'movie')
  );

  if (
    type === 'tv' &&
    season !== undefined &&
    season !== null
  ) {
    params.push(
      'season=' +
        encodeURIComponent(season)
    );
  }

  if (
    type === 'tv' &&
    episode !== undefined &&
    episode !== null
  ) {
    params.push(
      'episode=' +
        encodeURIComponent(episode)
    );
  }

  return API_BASE + '?' + params.join('&');
}

async function getStreams(
  tmdbId,
  type,
  season,
  episode
) {
  try {
    type =
      String(type || 'movie').toLowerCase() === 'tv'
        ? 'tv'
        : 'movie';

    console.log(
      '[HDMovie2] Start: ' +
        tmdbId +
        ' ' +
        type
    );

    if (type === 'tv') {
      console.log(
        '[HDMovie2] Season: ' +
          season +
          ' Episode: ' +
          episode
      );
    }

    var apiUrl = buildApiUrl(
      tmdbId,
      type,
      season,
      episode
    );

    console.log(
      '[HDMovie2] API: ' + apiUrl
    );

    var apiText = await httpGet(apiUrl, {
      Accept: 'application/json'
    });

    var data;

    try {
      data = JSON.parse(apiText);
    } catch (error) {
      console.log(
        '[HDMovie2] Invalid API JSON'
      );

      console.log(
        apiText.substring(0, 500)
      );

      return [];
    }

    if (!Array.isArray(data)) {
      console.log(
        '[HDMovie2] API response is not array'
      );

      return [];
    }

    if (data.length === 0) {
      console.log(
        '[HDMovie2] No API results'
      );

      return [];
    }

    console.log(
      '[HDMovie2] API results: ' +
        data.length
    );

    var streams = [];

    for (var i = 0; i < data.length; i++) {
      var item = data[i] || {};
      var playerUrl = item.url || '';

      if (!playerUrl) {
        continue;
      }

      var name =
        item.name ||
        item.title ||
        (
          type === 'tv'
            ? 'EP' +
              String(episode || i + 1)
                .padStart(2, '0')
            : 'HDMovie2'
        );

      // HDM2 player
      if (
        playerUrl.includes(
          'hdm2.ink/play?'
        )
      ) {
        try {
          var hdm2 = await resolveHdm2(
            playerUrl
          );

          if (!hdm2) {
            continue;
          }

          streams.push({
            name: name,
            title: item.title || name,
            url: hdm2.url,
            quality: '1080p',
            headers: hdm2.headers
          });
        } catch (error) {
          console.log(
            '[HDMovie2] ' +
              name +
              ' HDM2 resolve error: ' +
              error.message
          );
        }

        continue;
      }

      // Molop player
      if (
        playerUrl.includes(
          'molop.art/watch?'
        )
      ) {
        try {
          var molop = await resolveMolop(
            playerUrl
          );

          if (!molop) {
            continue;
          }

          streams.push({
            name: name,
            title: item.title || name,
            url: molop.url,
            quality: '1080p',
            headers: molop.headers
          });
        } catch (error) {
          console.log(
            '[HDMovie2] ' +
              name +
              ' Molop resolve error: ' +
              error.message
          );
        }

        continue;
      }

      // Already direct stream
      if (
        playerUrl.includes('.m3u8') ||
        playerUrl.includes('/playlist/')
      ) {
        streams.push({
          name: name,
          title: item.title || name,
          url: playerUrl,
          quality:
            item.quality || '1080p',
          headers:
            item.headers || {
              Referer: HDM2 + '/',
              Origin: HDM2,
              'User-Agent': UA
            }
        });

        continue;
      }

      console.log(
        '[HDMovie2] Unsupported URL: ' +
          playerUrl
      );
    }

    console.log(
      '[HDMovie2] Final streams: ' +
        streams.length
    );

    return streams;
  } catch (error) {
    console.error(
      '[HDMovie2] Error: ' +
        error.message
    );

    return [];
  }
}

module.exports = {
  getStreams: getStreams
};
