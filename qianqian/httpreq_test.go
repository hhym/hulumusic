package qianqian

import (
	"bytes"
	"compress/flate"
	"compress/gzip"
	"compress/zlib"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func gzipBytes(t *testing.T, s string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	if _, err := zw.Write([]byte(s)); err != nil {
		t.Fatalf("gzip write: %v", err)
	}
	zw.Close()
	return buf.Bytes()
}

// 插件里普遍写了 Accept-Encoding: gzip, deflate。若原样透传，net/http 就不解压，
// 插件拿到的是二进制包体，JSON.parse 失败后在 res.list.map 上崩
// （线上见过的报错：Cannot read properties of undefined (reading 'map')）。
// 这里守两件事：这个头不透传；服务端真回了 gzip 也要解出来。
func TestHTTPRequestGzipIsDecoded(t *testing.T) {
	const payload = `{"list":[{"songId":1}],"pageInfo":{"cur":1,"totalPages":1}}`
	sawAE := ""
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawAE = r.Header.Get("Accept-Encoding")
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Content-Encoding", "gzip")
		w.Write(gzipBytes(t, payload))
	}))
	defer ts.Close()

	var a App
	res := a.HttpRequest(ts.URL, "GET", map[string]string{
		"User-Agent":      "x",
		"Accept-Encoding": "gzip, deflate",
		"Referer":         "http://search.5sing.kugou.com/home/index",
		"Host":            "search.5sing.kugou.com",
	}, "", false)
	if res.Err != "" {
		t.Fatalf("请求失败：%s", res.Err)
	}
	// 插件传的是 "gzip, deflate"；Go 自己会补一个 "gzip" 以便透明解压，那没问题。
	// 只要不是原值（带 deflate）就说明我们的透传已经掐掉了。
	if strings.Contains(strings.ToLower(sawAE), "deflate") {
		t.Fatalf("插件传的 Accept-Encoding 不该透传，服务端收到了 %q", sawAE)
	}
	if res.Body != payload {
		t.Fatalf("解压后不是原文：%q", res.Body)
	}
}

func TestDecodeContentEncodingVariants(t *testing.T) {
	const text = "hello 世界"
	// zlib 包装的 deflate
	var zbuf bytes.Buffer
	zw := zlib.NewWriter(&zbuf)
	zw.Write([]byte(text))
	zw.Close()
	// 裸 deflate
	var fbuf bytes.Buffer
	fw, _ := flate.NewWriter(&fbuf, flate.DefaultCompression)
	fw.Write([]byte(text))
	fw.Close()

	cases := []struct {
		name string
		body []byte
		enc  string
	}{
		{"gzip", gzipBytes(t, text), "gzip"},
		{"zlib-deflate", zbuf.Bytes(), "deflate"},
		{"raw-deflate", fbuf.Bytes(), "deflate"},
		{"none", []byte(text), ""},
		{"gzip-header-but-plain", []byte(text), "gzip"},
	}
	for _, c := range cases {
		out, err := decodeContentEncoding(c.body, c.enc)
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if string(out) != text {
			t.Fatalf("%s: got %q want %q", c.name, out, text)
		}
	}
	_ = io.Discard
}
