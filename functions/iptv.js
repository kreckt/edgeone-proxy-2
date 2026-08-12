// edgeone-function-iptv.js —— 直播源(IPTV) HLS 边缘代理(腾讯云 EdgeOne Pages Functions)
// ============================================================================
// 部署:放进你 fork 的 edgeone-proxy 仓库的 functions/ 目录下(比如命名 functions/iptv.js → 对外路径就是 /iptv),
//   Git 关联部署推上去几十秒自动构建,得到 https://<你的域名>.edgeone.cool/iptv。填到 index.html 的 IPTV_EDGES.edgeone。
//   逻辑跟 cloudflare-worker-iptv.js 完全一样,只是换成 EdgeOne Pages Functions 要求的 onRequest(context) 导出格式
//   (跟当初把 cloudflare-worker.js 搬成 EdgeOne functions/proxy.js 同一个做法,见 README"换成腾讯云 EdgeOne"一节)。
//
// 为什么国内要它:Cloudflare 国内"连得上但慢",EdgeOne(腾讯云边缘)国内快;海外反之。客户端起播时对
//   【直连/CF/EdgeOne】各实测吞吐、谁快用谁(不是失败降级)。直播流量走 EdgeOne 边缘,不占你家宽上行。
//
// 注:README 记过 EdgeOne 运行时有"连续大流下游读取变慢后追不回原速"的背压 bug——但 IPTV 是【按分片离散拉取】,
//   每个 ts 一次性全速拉完、没有中途变速读,正好绕开那个连续连接的背压问题,所以适合 EdgeOne。
//
// 调用:GET /iptv?url=<原始 m3u8 或分片绝对地址>&type=hls|seg   (type 省略时按 .m3u8 后缀自动判)
// ============================================================================
const UA = 'VLC/3.0.20 LibVLC/3.0.20';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
  'Access-Control-Expose-Headers': '*',
};

function rewritePlaylist(text, baseUrl, self) {
  const out = [];
  for (let line of text.split('\n')) {
    const s = line.trim();
    if (!s) { out.push(line); continue; }
    if (s[0] === '#') {
      const m = s.match(/URI="([^"]+)"/i);
      if (m) {
        const abs = new URL(m[1], baseUrl).href;
        line = line.replace(/URI="[^"]+"/i, 'URI="' + self + '?url=' + encodeURIComponent(abs) + '&type=seg"');
      }
      out.push(line);
      continue;
    }
    const abs = new URL(s, baseUrl).href;
    const type = /\.m3u8(\?|$)/i.test(abs) ? 'hls' : 'seg';
    out.push(self + '?url=' + encodeURIComponent(abs) + '&type=' + type);
  }
  return out.join('\n');
}

export async function onRequest(context) {
  const request = context.request;
  if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
  const url = new URL(request.url);
  const target = url.searchParams.get('url');
  if (!target || !/^https?:\/\//i.test(target)) return new Response('bad url', { status: 400, headers: CORS });
  const type = url.searchParams.get('type') || (/\.m3u8(\?|$)/i.test(target) ? 'hls' : 'seg');
  const self = url.origin + url.pathname;

  const fwdHeaders = { 'User-Agent': UA, 'Accept': '*/*' };
  const range = request.headers.get('Range');
  if (range) fwdHeaders['Range'] = range;

  let upstream;
  try { upstream = await fetch(target, { headers: fwdHeaders, redirect: 'follow' }); }
  catch (e) { return new Response('upstream error: ' + (e && e.message), { status: 502, headers: CORS }); }
  if (!upstream.ok && upstream.status !== 206) return new Response('upstream ' + upstream.status, { status: 502, headers: CORS });

  if (type === 'hls') {
    const text = await upstream.text();
    const body = rewritePlaylist(text, upstream.url || target, self);
    return new Response(body, { headers: Object.assign({}, CORS, { 'Content-Type': 'application/vnd.apple.mpegurl' }) });
  }
  const h = Object.assign({}, CORS, { 'Content-Type': upstream.headers.get('Content-Type') || 'video/mp2t' });
  const cr = upstream.headers.get('Content-Range'); if (cr) h['Content-Range'] = cr;
  const ar = upstream.headers.get('Accept-Ranges'); if (ar) h['Accept-Ranges'] = ar;
  return new Response(upstream.body, { status: upstream.status, headers: h });
}
