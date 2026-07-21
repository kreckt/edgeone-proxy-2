// 真正自己发请求的版本——原模板那份是转发给 cors-anywhere.herokuapp.com 这个公共免费演示服务，
// 那玩意需要手动"激活"(访问 /corsdemo 点确认)、被限流得很死，而且它自己转发给目标站点时不会带上
// 我们需要的自定义 Referer，从根上就用不了。这里改成边缘函数自己直接 fetch() 目标地址，能自己随便
// 设 Referer/UA，是这次要用这套东西的真正原因(bilivideo.com 的视频 CDN 认 Referer)。
//
// 后来抖音（点播+直播）也接了进来——之前抖音固定走本机 /api/proxy，是因为 Cloudflare Worker
// 那条路的白名单没加抖音域名；换到这个腾讯云边缘节点是同样的思路（国内云厂商出口 IP 不像
// Cloudflare 那样被针对性拉黑）。注意抖音的 CDN 认的 Referer 跟 B 站不是同一个域，所以下面
// Referer 改成按目标域名分流，不能像之前那样写死成 bilibili.com。
const ALLOWED_HOST_RE = /^https:\/\/[^/]*\.bilivideo\.com\/|^https:\/\/upos-[^/]*\.akamaized\.net\/|^https:\/\/[^/]*\.(douyinvod\.com|douyinliving\.com|zjcdn\.com)\/|^https:\/\/www\.douyin\.com\/aweme\/v1\/play\//;
const DOUYIN_HOST_RE = /^https:\/\/[^/]*\.(douyinvod\.com|douyinliving\.com|zjcdn\.com)\/|^https:\/\/www\.douyin\.com\/aweme\/v1\/play\//;

export async function onRequest(context) {
  const { request } = context;
  const requestUrl = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Range',
      },
    });
  }

  const target = requestUrl.searchParams.get('url');
  if (!target || !ALLOWED_HOST_RE.test(target)) {
    return new Response('invalid target', { status: 400 });
  }

  const upstreamHeaders = {
    referer: DOUYIN_HOST_RE.test(target) ? 'https://www.douyin.com/' : 'https://www.bilibili.com/',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  };
  const range = request.headers.get('range');
  if (range) upstreamHeaders.range = range;

  try {
    const upstream = await fetch(target, { headers: upstreamHeaders });

    const headers = new Headers();
    headers.set('Access-Control-Allow-Origin', '*');
    ['content-type', 'content-length', 'content-range', 'accept-ranges'].forEach((h) => {
      const v = upstream.headers.get(h);
      if (v) headers.set(h, v);
    });

    return new Response(upstream.body, { status: upstream.status, headers });
  } catch (error) {
    return new Response(`Proxy Error: ${error.message}`, { status: 502 });
  }
}
