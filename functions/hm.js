// edgeone-function-hm.js —— 直播源手机管理页【大陆可达反代】(腾讯云 EdgeOne Pages Functions)
// ============================================================================
// 部署:放进 fork 的 edgeone-proxy 仓库 functions/hm.js → 对外路径 /hm。二维码编 https://<你的域名>.edgeone.cool/hm?p=token。
//
// 为什么要它:手机管理页原来挂在 yt.kreckt.top(Cloudflare),大陆手机 GFW 在 TLS 握手按 SNI reset 掉、打不开("无法建立
// 安全的连接")。EdgeOne(腾讯云边缘)大陆可达,让手机只跟 EdgeOne 打交道:大陆手机→EdgeOne(通)→本函数回源 yt.kreckt.top
// (EdgeOne 香港节点连 CF 不受 GFW)→源站。车机端的 relay/wait(long-poll) 仍直连 CF(车机在境外,没问题),不经这里。
//
// 单函数自包含,不用 catchall:手机所有请求只打 /hm,用 op 分发——
//   GET  /hm?p=token            → 回源 /iptv-remote?p=token 的 HTML,把页面里 3 个 API 路径改写成走 /hm?op=,返回
//   GET  /hm?p=token&op=get     → 回源 /api/iptv/relay/get?p=token
//   POST /hm?p=token&op=put     → 回源 /api/iptv/relay/put?p=token (透传 body)
//   GET  /hm?p=token&op=fetch&url=X → 回源 /api/iptv/fetch?p=token&url=X (手机按URL导入拉 M3U)
// 这几个源站接口都靠 token 放行(中间件已豁免),EdgeOne 带 ?p=token 回源即通。手机端全是瞬时请求、无 long-poll。
// ============================================================================
const ORIGIN = 'https://yt.kreckt.top'; // 源站(经 Cloudflare)。换域名改这里。
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' };

export async function onRequest(context) {
  const request = context.request;
  if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
  const url = new URL(request.url);
  const p = url.searchParams.get('p') || '';
  const op = url.searchParams.get('op') || '';
  if (!p) return new Response('缺少配对码', { status: 400, headers: CORS });

  try {
    if (op === 'get') {
      const r = await fetch(ORIGIN + '/api/iptv/relay/get?p=' + encodeURIComponent(p), { headers: { 'accept': 'application/json' } });
      return passJson(r);
    }
    if (op === 'put') {
      const body = await request.text();
      const r = await fetch(ORIGIN + '/api/iptv/relay/put?p=' + encodeURIComponent(p), { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      return passJson(r);
    }
    if (op === 'fetch') {
      const target = url.searchParams.get('url') || '';
      const r = await fetch(ORIGIN + '/api/iptv/fetch?p=' + encodeURIComponent(p) + '&url=' + encodeURIComponent(target));
      const text = await r.text();
      return new Response(text, { status: r.status, headers: Object.assign({}, CORS, { 'Content-Type': 'text/plain; charset=utf-8' }) });
    }
    // 无 op:回源手机页 HTML,改写里面 3 个 API 路径走本函数(/hm?op=)。手机所有后续请求就只打 /hm。
    const r = await fetch(ORIGIN + '/iptv-remote?p=' + encodeURIComponent(p));
    let html = await r.text();
    html = html
      .split("/api/iptv/relay/get?p=").join("/hm?op=get&p=")
      .split("/api/iptv/relay/put?p=").join("/hm?op=put&p=")
      .split("/api/iptv/fetch?p=").join("/hm?op=fetch&p=");
    return new Response(html, { status: r.status, headers: Object.assign({}, CORS, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }) });
  } catch (e) {
    return new Response('反代出错: ' + (e && e.message || e), { status: 502, headers: CORS });
  }
}
function passJson(r) {
  return r.text().then((t) => new Response(t, { status: r.status, headers: Object.assign({}, CORS, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }) }));
}
