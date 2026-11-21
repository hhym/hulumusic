package qianqian

import (
	"bytes"
	"compress/flate"
	"compress/gzip"
	"compress/zlib"
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

/* 插件运行在 WebView 里，直接 fetch 三方接口会被 CORS 拦掉。
   所有插件网络请求都绕到后端来发，顺带把 UA / Referer 这些头补上。 */

type HttpResult struct {
	Status  int               `json:"status"`
	BodyB64 string            `json:"bodyB64"`
	Body    string            `json:"body"`
	Err     string            `json:"err"`
	Headers map[string]string `json:"headers"`
}

// 响应头要回传给插件：不少平台（酷我、B站）靠 Set-Cookie 或自定义头下发凭证，
// 插件拿不到头就没法继续拿数据。
func collectHeaders(h http.Header) map[string]string {
	out := make(map[string]string, len(h))
	for k, vs := range h {
		out[strings.ToLower(k)] = strings.Join(vs, "\n")
	}
	return out
}

func (a *App) HttpRequest(rawURL, method string, headers map[string]string, body string, manualRedirect bool) HttpResult {
	u, err := url.Parse(rawURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") {
		return HttpResult{Err: "只支持 http/https 地址"}
	}
	if method == "" {
		method = "GET"
	}
	var rdr io.Reader
	if body != "" && method != "GET" && method != "HEAD" {
		rdr = strings.NewReader(body)
	}
	req, err := http.NewRequest(strings.ToUpper(method), rawURL, rdr)
	if err != nil {
		return HttpResult{Err: "请求构造失败：" + err.Error()}
	}
	req.Header.Set("User-Agent", uaDesktop)
	for k, v := range headers {
		if k == "" || v == "" {
			continue
		}
		// Host 只能通过 req.Host 设，塞进 Header 是无效的（5sing 插件就带了 Host）
		if strings.EqualFold(k, "Host") {
			req.Host = v
			continue
		}
		// Accept-Encoding 不能透传：一旦显式写了这个头，net/http 会认为调用方自己解压，
		// 于是把 gzip 字节原样交回来。插件拿到压缩包以后 JSON.parse 失败，
		// 就在 res.list.map 上报「Cannot read properties of undefined (reading 'map')」。
		// 这里丢掉它，让 Go 自己协商 gzip 并透明解压。
		if strings.EqualFold(k, "Accept-Encoding") {
			continue
		}
		req.Header.Set(k, v)
	}
	client := &http.Client{Timeout: 30 * time.Second}
	// 插件显式要求 redirect: 'manual' 时不要自动跟随：
	// QQ 登录靠 check_sig 返回的 302 和 Location 拿授权票据，跟随后就看不到 302 了
	if manualRedirect {
		client.CheckRedirect = func(req *http.Request, via []*http.Request) error {
			return http.ErrUseLastResponse
		}
	}
	res, err := client.Do(req)
	track := strings.Contains(rawURL, "qishui.com") || strings.Contains(rawURL, "beta-luna.douyin.com")
	if track {
		if err != nil {
			procLog("[http] " + method + " " + rawURL + " -> err=" + err.Error() + "\n")
		}
	}
	if err != nil {
		return HttpResult{Err: "请求失败：" + err.Error()}
	}
	defer res.Body.Close()
	b, err := io.ReadAll(io.LimitReader(res.Body, 12<<20))
	if err != nil {
		return HttpResult{Status: res.StatusCode, Err: "读取响应失败：" + err.Error()}
	}
	// 兜底：万一服务端无视协商、或者我们哪天又透传了 Accept-Encoding，
	// 这里把 gzip/deflate 的包体解回来，别把二进制当文本交给插件
	if b, err = decodeContentEncoding(b, res.Header.Get("Content-Encoding")); err != nil {
		return HttpResult{Status: res.StatusCode, Err: "解压响应失败：" + err.Error()}
	}
	// 文本类响应给原文；图片/音频这类二进制响应额外给 base64，
	// 否则插件里 `(await fetch(...)).arrayBuffer()` 拿到的字节是错的
	ct := res.Header.Get("Content-Type")
	if strings.Contains(rawURL, "qishui.com") || strings.Contains(rawURL, "beta-luna.douyin.com") {
		names := []string{}
		for k := range headers {
			names = append(names, "H:"+k)
		}
		procLog("[http-hdr] " + strings.Join(names, ";") + "\n")
		names = names[:0]
		for k, v := range headers {
			if len(v) > 40 {
				v = v[:40] + "…"
			}
			names = append(names, k+"="+v)
		}
		procLog("[http-hdr] " + strings.Join(names, "; ") + "\n")
		body := string(b)
		if len(body) > 400 {
			body = body[:400] + "…"
		}
		procLog("[http] " + method + " " + rawURL + " -> " + strconv.Itoa(res.StatusCode) + " ct=" + ct + " body=" + body + "\n")
	}
	// 有些站点的响应是 GBK / 混合编码字节，直接塞进 JSON 里会让 Wails 的编码器报
	// jsontext: invalid UTF-8。这里统一清洗成合法 UTF-8，原文另走 bodyB64。
	resp := HttpResult{Status: res.StatusCode, Body: strings.ToValidUTF8(string(b), "\uFFFD"), Headers: collectHeaders(res.Header)}
	// 判断「文本还是二进制」很容易翻车：QQ 的二维码接口连 Content-Type 都不给，
	// 只看头会把它当文本，字节就全坏了。所以小响应一律额外带上 base64 原文，
	// 插件要 arrayBuffer 时直接用它，不必猜。
	// 大响应（>1MB，基本是音频/图片包体）才只按类型给一种。
	if len(b) <= 1<<20 {
		resp.BodyB64 = base64.StdEncoding.EncodeToString(b)
	} else if !isTextualType(ct) || !utf8.Valid(b) {
		resp.BodyB64 = base64.StdEncoding.EncodeToString(b)
	}
	return resp
}

// isTextualType 判断响应是不是能安全当作文本交给前端。
func isTextualType(ct string) bool {
	ct = strings.ToLower(strings.TrimSpace(ct))
	if ct == "" {
		return true
	}
	return strings.HasPrefix(ct, "text/") ||
		strings.Contains(ct, "json") ||
		strings.Contains(ct, "xml") ||
		strings.Contains(ct, "javascript") ||
		strings.Contains(ct, "urlencoded")
}

// PluginPlayURL 把插件拿到的音频地址包装成本地代理地址。
// 插件管的站点往往要自己的 Referer，所以一并带过去。
func (a *App) PluginPlayURL(rawURL, referer string) (string, string) {
	base := a.ensureProxy()
	if base == "" {
		return "", "本地代理没起来"
	}
	u, err := url.Parse(rawURL)
	if err != nil {
		return "", "插件返回的地址不合法"
	}
	// 插件转码后给的是 file:// 本地文件，也走代理（代理内部只读数据目录）
	if u.Scheme != "http" && u.Scheme != "https" && u.Scheme != "file" {
		return "", "插件返回的地址不合法"
	}
	out := base + "?u=" + encodeTarget(rawURL)
	if referer != "" {
		out += "&h=" + encodeTarget(referer)
	}
	return out, ""
}

// decodeContentEncoding 把 gzip / deflate 包体解成原文；其它编码原样返回。
// deflate 两种流派都试：zlib 包装的和裸 deflate 的，站点两种都有。
func decodeContentEncoding(b []byte, enc string) ([]byte, error) {
	switch strings.ToLower(strings.TrimSpace(enc)) {
	case "gzip", "x-gzip":
		if len(b) < 2 || b[0] != 0x1f || b[1] != 0x8b {
			return b, nil // 头里写了 gzip 但包体没压缩，说明已经解过了
		}
		zr, err := gzip.NewReader(bytesReader(b))
		if err != nil {
			return nil, err
		}
		defer zr.Close()
		out, err := io.ReadAll(io.LimitReader(zr, 24<<20))
		if err != nil {
			return nil, err
		}
		return out, nil
	case "deflate":
		if zr, err := zlib.NewReader(bytesReader(b)); err == nil {
			defer zr.Close()
			if out, rerr := io.ReadAll(io.LimitReader(zr, 24<<20)); rerr == nil {
				return out, nil
			}
		}
		fr := flate.NewReader(bytesReader(b))
		defer fr.Close()
		out, err := io.ReadAll(io.LimitReader(fr, 24<<20))
		if err != nil {
			return nil, fmt.Errorf("deflate: %w", err)
		}
		return out, nil
	}
	return b, nil
}

func bytesReader(b []byte) io.Reader { return bytes.NewReader(b) }
