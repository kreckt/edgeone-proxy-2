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

    // 直播这种连续不会"结束"的流实测发现一个问题：下游(播放器)读取变慢一阵子(解码跟不上、
    // 暂停读)之后再恢复快速读取，这条连接没法完全恢复到原来的速度，会卡在一个折半左右的
    // 低速平台出不来——之前直接 `new Response(upstream.body, ...)` 相当于把上游 fetch() 的
    // ReadableStream 原样透传给下游，中间隔着的这一层运行时自己的流水线在下游变慢时具体是
    // 怎么缓冲/怎么恢复的是黑盒(EdgeOne Pages Functions 不开源)，看不到内部实现，只能从外部
    // 行为倒推着试。这里改成显式手动搬运每个 chunk，给读写两端都设一个很小的 highWaterMark
    // (不让运行时攒一大截再整批处理)，是这类"边缘函数代理直播流卡在降速状态出不来"问题社区
    // 里比较常见的应对方式——不确定百分之百是这同一个机制，但方向对：让背压信号尽量细粒度地
    // 逐块传递，而不是让某一层攒一大坨之后再决定要不要减速。
    // ByteLengthQueuingStrategy 不是这个运行时的全局对象(报 "ByteLengthQueuingStrategy is not
    // defined")——EdgeOne Pages Functions 这个 V8 隔离环境显然只实现了 Streams API 的一部分，
    // 跟浏览器/Node 不是同一个完整集合。QueuingStrategy 本身按 spec 就是个普通对象(有
    // highWaterMark + 可选的 size 函数)，不一定非要用那个内置类，这里手写一个等价的替代。
    const reader = upstream.body.getReader();
    const body = new ReadableStream({
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) { controller.close(); return; }
        controller.enqueue(value);
      },
      cancel(reason) { reader.cancel(reason); },
    }, { highWaterMark: 16384, size: (chunk) => chunk.byteLength });

    return new Response(body, { status: upstream.status, headers });
  } catch (error) {
    return new Response(`Proxy Error: ${error.message}`, { status: 502 });
  }
}
