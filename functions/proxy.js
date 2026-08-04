// 真正自己发请求的版本——原模板那份是转发给 cors-anywhere.herokuapp.com 这个公共免费演示服务，
// 那玩意需要手动"激活"(访问 /corsdemo 点确认)、被限流得很死，而且它自己转发给目标站点时不会带上
// 我们需要的自定义 Referer，从根上就用不了。这里改成边缘函数自己直接 fetch() 目标地址，能自己随便
// 设 Referer/UA，是这次要用这套东西的真正原因(bilivideo.com 的视频 CDN 认 Referer)。
//
// 后来抖音（点播+直播）也接了进来——之前抖音固定走本机 /api/proxy，是因为 Cloudflare Worker
// 那条路的白名单没加抖音域名；换到这个腾讯云边缘节点是同样的思路（国内云厂商出口 IP 不像
// Cloudflare 那样被针对性拉黑）。注意抖音的 CDN 认的 Referer 跟 B 站不是同一个域，所以下面
// Referer 改成按目标域名分流，不能像之前那样写死成 bilibili.com。
//
// 2026-07-22 补充 douyincdn.com：之前只在解析"点播链接兜底数据"时见过 douyinvod.com/
// douyinliving.com/zjcdn.com 这几个域名，一直没有拿真实在播的直播间验证过实际拉流地址长什么样。
// 这次靠真实搜索接口拿到了真正在播的房间去测，发现直播拉流(flv_pull_url)给的域名其实是
// douyincdn.com(比如 pull-q5.douyincdn.com/pull-flv-f26.douyincdn.com)，不在白名单里，直接被
// 这个边缘函数拒了(返回 invalid target)，表现成车机播放器那边永远卡在"加载中"、白名单拒绝
// 时的 400 响应没有 CORS 头，浏览器 fetch() 只会看到一个笼统的 Failed to fetch，不会有明确报错。
// 单独用 https?(不强制 https)——真实拿到的直播拉流地址是 http:// 的，跟这里其它域名一直以来
// 观察到的都是 https 不一样，光加域名不够，正则还卡在只认 https 前缀，同一个"invalid
// target"错误，看着像域名没加对，其实是协议前缀不匹配；DOUYIN_HOST_RE 判断 Referer 用哪个也
// 有同样的问题，不改的话 http 的抖音直播流会被误当成 B 站请求、带上错的 Referer。
//
// 2026-07-22 又一次补充 douyinliving.com：跟上面 douyincdn.com 一模一样的坑，只是这次踩到
// 的是另一个域名——douyinliving.com 当时是照抄"点播链接兜底数据"里见过的 https 形式加进
// 白名单的，从来没拿真实在播的直播间验证过。这次车机反馈"直连失败、改走这个代理也失败"，
// 一路排查下来发现真实直播间(比如 pull-flv-f6.douyinliving.com)给的拉流地址同样是
// http://，被这条卡死 https 前缀的正则拒了——效果上看起来像是"代理兜底也没用"，其实代理
// 那次请求根本没送到目标站点，白名单这一步就被本地直接拒绝了(400 invalid target)。跟
// douyincdn.com 一样挪进 https? 那一组。
//
// 2026-08-04 补充 红果短剧(qznovelvod.com 视频直链 / fqnovel·byteimg 封面)：跟 B 站/抖音不一样——
// 【改动①】白名单加进 .qznovelvod.com 等(视频节点号 v3-reading-videocdn30x 会变，按整域匹配，别写死子域)。
// 【改动②】红果 CDN 不认 Referer，服务端"干净拉"(只带 Range、不带 Referer)就给；带上 bilibili.com 的
//   Referer 反而会被防盗链判 403(本机 server.js 的 /api/hongguo/fetch 能成，正因为它不带 Referer)。
//   所以下面对红果目标【不设 Referer】。
// 【改动③】补上 Access-Control-Expose-Headers——原本没设，跨域下浏览器 JS 读不到 content-length/
//   content-range，红果真版的 CustomIOLoader 要靠这俩算文件大小 + 做 seek。B 站/抖音也顺带受益。
const ALLOWED_HOST_RE = /^https:\/\/[^/]*\.bilivideo\.com\/|^https:\/\/upos-[^/]*\.akamaized\.net\/|^https:\/\/[^/]*\.(douyinvod\.com|zjcdn\.com)\/|^https:\/\/www\.douyin\.com\/aweme\/v1\/play\/|^https?:\/\/[^/]*\.(douyincdn\.com|douyinliving\.com)\/|^https:\/\/[^/]*\.(qznovelvod\.com|fqnovel\.com|fqnovelpic\.com|byteimg\.com)\//;
const DOUYIN_HOST_RE = /^https:\/\/[^/]*\.(douyinvod\.com|zjcdn\.com)\/|^https:\/\/www\.douyin\.com\/aweme\/v1\/play\/|^https?:\/\/[^/]*\.(douyincdn\.com|douyinliving\.com)\//;
// 红果目标：不设 Referer(带错 Referer 会被防盗链 403，干净拉才给)
const HONGGUO_HOST_RE = /^https:\/\/[^/]*\.(qznovelvod\.com|fqnovel\.com|fqnovelpic\.com|byteimg\.com)\//;

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
    // 拒绝时也带上 CORS 头，这样浏览器能读到"invalid target"这个明确原因，而不是笼统的 Failed to fetch
    return new Response('invalid target', { status: 400, headers: { 'Access-Control-Allow-Origin': '*' } });
  }

  const upstreamHeaders = {
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  };
  // 红果 CDN 不认 Referer(带上反而 403)；只有非红果目标才按域设 Referer(抖音 / B 站各自的域)
  if (!HONGGUO_HOST_RE.test(target)) {
    upstreamHeaders.referer = DOUYIN_HOST_RE.test(target) ? 'https://www.douyin.com/' : 'https://www.bilibili.com/';
  }
  const range = request.headers.get('range');
  if (range) upstreamHeaders.range = range;

  try {
    const upstream = await fetch(target, { headers: upstreamHeaders });

    const headers = new Headers();
    headers.set('Access-Control-Allow-Origin', '*');
    // 跨域下必须显式暴露这些响应头，浏览器 JS 才读得到(CustomIOLoader 要读 content-length/content-range 算大小+seek)
    headers.set('Access-Control-Expose-Headers', 'content-type, content-length, content-range, accept-ranges');
    ['content-type', 'content-length', 'content-range', 'accept-ranges'].forEach((h) => {
      const v = upstream.headers.get(h);
      if (v) headers.set(h, v);
    });

    return new Response(upstream.body, { status: upstream.status, headers });
  } catch (error) {
    // 502 也带上 CORS：这样"边缘收到请求、但拉不到上游红果 CDN(被 403/RST/超时)"这种失败，浏览器能读到
    // 真实的 Proxy Error 文本，而不是笼统的 Failed to fetch，方便区分"没部署"还是"边缘也被 CDN 拒"。
    return new Response(`Proxy Error: ${error.message}`, { status: 502, headers: { 'Access-Control-Allow-Origin': '*' } });
  }
}
