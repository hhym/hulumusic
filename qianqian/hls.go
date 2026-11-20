package qianqian

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

/* HLS 直播 → ADTS 转封装（A 方案的 Go 实现）。

   云听/蜻蜓这类电台给的是 m3u8，分片是 MPEG-TS（首字节 0x47），而 <audio>
   和我们的播放器都不吃 TS。这里在本地代理里直接把 TS 解复用成 ADTS 帧，
   一次到底输出 audio/aac 的无长度流，前端加个 src 就能放，不装 Python/ffmpeg。

   流程：master → media playlist → 按 media sequence 顺序拉分片 → 解 TS
   （PAT → PMT → 音频 PID）→ 抽 ADTS → 写响应。

   注意几件事：
   * 分片里的 PES 头、空包、视频/数据 PID 都要丢掉，只留音频 PID 的 payload；
   * ADTS 帧可能跨分片，尾部不足一帧的字节要留到下一片继续拼；
   * 客户端一断开（切台/关窗）就要立刻停，不能挂着拉流。 */

const adtsSampleRate = 44100 // 只用于探测日志，不参与解析

type hlsVariant struct {
	uri      string
	bandwidth int
}

type hlsSegment struct {
	seq  int64
	uri  string
	dur  float64
}

type hlsPlaylist struct {
	isMaster   bool
	variants   []hlsVariant
	targetDur  float64
	mediaSeq   int64
	segments   []hlsSegment
}

func isHLSTarget(target string) bool {
	p := strings.ToLower(target)
	return strings.Contains(p, ".m3u8") || strings.Contains(p, "application/vnd.apple.mpegurl")
}

func parseHLSPlaylist(body string, base *url.URL) *hlsPlaylist {
	pl := &hlsPlaylist{targetDur: 10}
	sc := bufio.NewScanner(strings.NewReader(body))
	var pendingDur float64
	var pendingVariant *hlsVariant
	seq := int64(0)
	firstSeq := true
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		switch {
		case strings.HasPrefix(line, "#EXT-X-STREAM-INF"):
			v := hlsVariant{}
			for _, kv := range strings.Split(strings.TrimPrefix(line, "#EXT-X-STREAM-INF:"), ",") {
				kv = strings.TrimSpace(kv)
				if strings.HasPrefix(kv, "BANDWIDTH=") {
					v.bandwidth, _ = strconv.Atoi(strings.TrimPrefix(kv, "BANDWIDTH="))
				}
			}
			pendingVariant = &v
			pl.isMaster = true
		case strings.HasPrefix(line, "#EXT-X-TARGETDURATION:"):
			if f, err := strconv.ParseFloat(strings.TrimSpace(strings.TrimPrefix(line, "#EXT-X-TARGETDURATION:")), 64); err == nil && f > 0 {
				pl.targetDur = f
			}
		case strings.HasPrefix(line, "#EXT-X-MEDIA-SEQUENCE:"):
			if v, err := strconv.ParseInt(strings.TrimSpace(strings.TrimPrefix(line, "#EXT-X-MEDIA-SEQUENCE:")), 10, 64); err == nil {
				pl.mediaSeq = v
				seq = v
			}
			firstSeq = false
		case strings.HasPrefix(line, "#EXTINF:"):
			s := strings.TrimPrefix(line, "#EXTINF:")
			if i := strings.IndexByte(s, ','); i >= 0 {
				s = s[:i]
			}
			pendingDur, _ = strconv.ParseFloat(strings.TrimSpace(s), 64)
		case !strings.HasPrefix(line, "#"):
			abs := resolveURL(base, line)
			if pendingVariant != nil {
				pendingVariant.uri = abs
				pl.variants = append(pl.variants, *pendingVariant)
				pendingVariant = nil
				continue
			}
			if firstSeq {
				// 没有 MEDIA-SEQUENCE 时按 0 起算
				seq = 0
				firstSeq = false
			}
			pl.segments = append(pl.segments, hlsSegment{seq: seq, uri: abs, dur: pendingDur})
			seq++
		}
	}
	return pl
}

// resolveURL 把 playlist 里的相对地址补全。
func resolveURL(base *url.URL, ref string) string {
	if strings.HasPrefix(ref, "http://") || strings.HasPrefix(ref, "https://") {
		return ref
	}
	if base == nil {
		return ref
	}
	u, err := base.Parse(ref)
	if err != nil {
		return ref
	}
	return u.String()
}

type hlsFetcher struct {
	client  *http.Client
	referer string
}

func newHLSFetcher(referer string) *hlsFetcher {
	return &hlsFetcher{
		client: &http.Client{
			Timeout: 20 * time.Second,
			Transport: &http.Transport{
				MaxIdleConnsPerHost: 4,
				IdleConnTimeout:     30 * time.Second,
			},
		},
		referer: referer,
	}
}

func (f *hlsFetcher) get(ctx context.Context, u string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", u, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", uaDesktop)
	req.Header.Set("Accept", "*/*")
	if f.referer != "" {
		req.Header.Set("Referer", f.referer)
	}
	res, err := f.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d", res.StatusCode)
	}
	return io.ReadAll(io.LimitReader(res.Body, 8<<20))
}

/* ── TS 解复用 ────────────────────────────────────────────────────────── */

type adtsWriter struct {
	out   io.Writer
	sink  func([]byte) // 录制落盘（没在录就是 nil）
	pid   uint16       // 音频 ES 的 PID，PMT 里读出来
	pmt   uint16
	have  int    // 0=等 PAT，1=等 PMT，2=已定位音频 PID
	buf   []byte // 跨分片的 ADTS 残帧
	latm  *latmConv
	stype byte
	n     int // 累计写出的帧数
}

const tsPacketSize = 188

func (d *adtsWriter) feed(data []byte) (frames int, err error) {
	i := 0
	for i+tsPacketSize <= len(data) {
		if data[i] != 0x47 {
			i++
			continue
		}
		p := data[i : i+tsPacketSize]
		i += tsPacketSize
		pid := uint16(p[1]&0x1f)<<8 | uint16(p[2])
		pusi := p[1]&0x40 != 0
		afc := (p[3] >> 4) & 0x03
		off := 4
		if afc == 0 {
			continue
		}
		if afc == 2 {
			continue // 只有自适应字段，没有 payload
		}
		if afc == 3 {
			off += 1 + int(p[4])
			if off >= tsPacketSize {
				continue
			}
		}
		payload := p[off:]

		switch {
		case pid == 0:
			if pusi {
				d.parsePAT(payload)
			}
		case pid == d.pmt && d.pmt != 0:
			if pusi {
				d.parsePMT(payload)
			}
		case pid == d.pid && d.pid != 0:
			if d.latm != nil {
				// PUSI 上带着 PES 头，LOAS 元素从头部之后才开始，先剥掉
				if pusi && len(payload) > 9 && payload[0] == 0 && payload[1] == 0 && payload[2] == 1 {
					if hl := int(payload[8]); 9+hl < len(payload) {
						payload = payload[9+hl:]
					}
				}
				if e := d.write(d.latm.feed(payload)); e != nil {
					return frames, e
				}
				continue
			}
			d.buf = append(d.buf, payload...)
			n, err := d.extract()
			d.n += n
			frames += n
			if err != nil {
				return frames, err
			}
		}
	}
	return frames, nil
}

// write 一条已经成形的 ADTS 字节：先给客户端，再给录制文件（如果在录）。
func (d *adtsWriter) write(p []byte) error {
	if len(p) == 0 {
		return nil
	}
	if _, err := d.out.Write(p); err != nil {
		return err
	}
	if d.sink != nil {
		d.sink(p)
	}
	return nil
}

func sectionStart(payload []byte, pusi bool) []byte {
	if pusi && len(payload) > 0 {
		skip := int(payload[0]) + 1
		if skip < len(payload) {
			return payload[skip:]
		}
		return nil
	}
	return payload
}

func (d *adtsWriter) parsePAT(payload []byte) {
	s := sectionStart(payload, true)
	if len(s) < 8 || s[0] != 0x00 {
		return
	}
	seclen := int(s[1]&0x0f)<<8 | int(s[2])
	if seclen+3 > len(s) {
		seclen = len(s) - 3
	}
	body := s[8 : 3+seclen]
	for i := 0; i+4 <= len(body); i += 4 {
		prog := uint16(body[i])<<8 | uint16(body[i+1])
		if prog == 0 {
			continue
		}
		d.pmt = uint16(body[i+2]&0x1f)<<8 | uint16(body[i+3])
		if d.have == 0 {
			d.have = 1
		}
		return
	}
}

func (d *adtsWriter) parsePMT(payload []byte) {
	s := sectionStart(payload, true)
	if len(s) < 12 || s[0] != 0x02 {
		return
	}
	seclen := int(s[1]&0x0f)<<8 | int(s[2])
	if seclen+3 > len(s) {
		seclen = len(s) - 3
	}
	// program_info_length 在偏移 10..11
	pil := int(s[10]&0x0f)<<8 | int(s[11])
	start := 12 + pil
	end := 3 + seclen - 4 // 末尾 4 字节 CRC
	if start > len(s) || end > len(s) || start >= end {
		return
	}
	for i := start; i+5 <= end; {
		st := s[i]
		epid := uint16(s[i+1]&0x1f)<<8 | uint16(s[i+2])
		esl := int(s[i+3]&0x0f)<<8 | int(s[i+4])
		// 0x0f = ADTS AAC, 0x11 = LATM AAC, 0x03/0x04 = MP3
		if st == 0x0f || st == 0x11 || st == 0x03 || st == 0x04 {
			if st == 0x11 {
				// LATM：PES 里是 LOAS，就地拆成 ADTS 再喂给 <audio>
				// PMT 会反复下发，转换器只能建一次，否则每来一次 PMT 就把配置和缓冲丢了
				if d.latm == nil {
					d.latm = &latmConv{}
					appLog("hls.log", "PMT: LATM AAC，走 LOAS→ADTS 转换")
				}
			}
			d.stype = st
			d.pid = epid
			d.have = 2
			appLog("hls.log", fmt.Sprintf("PMT: 音频 PID=%d stream_type=0x%02x", epid, st))
			return
		}
		i += 5 + esl
	}
}

// extract 从累积的 payload 里切出完整 ADTS 帧，残帧留在 buf 里等下一个分片。
func (d *adtsWriter) extract() (int, error) {
	frames := 0
	i := 0
	for {
		// 找 12 位同步字 0xFFF
		for i+1 < len(d.buf) && !(d.buf[i] == 0xff && d.buf[i+1]&0xf0 == 0xf0) {
			i++
		}
		if i+7 > len(d.buf) {
			break
		}
		flen := int(d.buf[i+3]&0x03)<<11 | int(d.buf[i+4])<<3 | int(d.buf[i+5])>>5
		if flen < 7 || flen > 8191 {
			i++ // 假同步，跳一个字节继续找
			continue
		}
		if i+flen > len(d.buf) {
			break // 帧不完整，等下一片
		}
		if _, err := d.out.Write(d.buf[i : i+flen]); err != nil {
			return frames, err
		}
		frames++
		i += flen
	}
	d.buf = d.buf[i:]
	if len(d.buf) > 64<<10 {
		// 一直拼不上的话（不是 ADTS），别把内存吃光
		d.buf = d.buf[len(d.buf)-4096:]
	}
	return frames, nil
}

/* ── 对外入口 ─────────────────────────────────────────────────────────── */

// serveHLS 把远端 m3u8 转成一条连续的 ADTS 流写到响应里，直到客户端断开。
func serveHLS(w http.ResponseWriter, r *http.Request, target, referer string) {
	ctx := r.Context()
	if allowAudioCORS(w, r) {
		return
	}
	w.Header().Set("Content-Type", "audio/aac")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.WriteHeader(http.StatusOK)
	fl, _ := w.(http.Flusher)

	f := newHLSFetcher(referer)
	mediaURL := target

	// master playlist 要先挑一路码流
	body, err := f.get(ctx, mediaURL)
	if err != nil {
		appLog("hls.log", "拉 m3u8 失败: "+err.Error()+" url="+mediaURL)
		return
	}
	pl := parseHLSPlaylist(string(body), mustURL(mediaURL))
	if pl.isMaster && len(pl.variants) > 0 {
		// 按带宽从高到低排，试到能取为止（有的高码率源在部分地区不可用）
		best := pl.variants[0]
		for _, v := range pl.variants {
			if v.bandwidth > best.bandwidth {
				best = v
			}
		}
		mediaURL = best.uri
		body, err = f.get(ctx, mediaURL)
		if err != nil {
			appLog("hls.log", "拉子 playlist 失败: "+err.Error())
			return
		}
		pl = parseHLSPlaylist(string(body), mustURL(mediaURL))
	}
	appLog("hls.log", fmt.Sprintf("起播 seq=%d 分片=%d 目标时长=%.1fs", pl.mediaSeq, len(pl.segments), pl.targetDur))

	dw := &adtsWriter{out: w, sink: recSink()}
	// 从直播边缘稍退一点起播，供需缓冲；太靠边容易第一片还没生成完
	next := pl.mediaSeq
	if n := len(pl.segments); n > 0 {
		next = pl.segments[n-1].seq
	}
	mediaBase := mustURL(mediaURL)
	plURL := mediaURL
	targetDur := pl.targetDur
	lastRefresh := time.Now()

	refresh := func() bool {
		data, e := f.get(ctx, plURL)
		if e != nil {
			appLog("hls.log", "刷新 playlist 失败: "+e.Error())
			return false
		}
		p := parseHLSPlaylist(string(data), mediaBase)
		if p.isMaster { // 极端情况下又被指到 master
			if len(p.variants) > 0 {
				plURL = p.variants[0].uri
				mediaBase = mustURL(plURL)
			}
			return false
		}
		pl = p
		if p.targetDur > 0 {
			targetDur = p.targetDur
		}
		lastRefresh = time.Now()
		return true
	}

	frameTotal := 0
	for {
		select {
		case <-ctx.Done():
			appLog("hls.log", fmt.Sprintf("客户端断开，共输出 %d 帧", frameTotal))
			return
		default:
		}

		var seg *hlsSegment
		for i := range pl.segments {
			if pl.segments[i].seq == next {
				seg = &pl.segments[i]
				break
			}
		}
		if seg == nil {
			// 追不上直播边缘（说明中间有分片过期了），跳到最新一片，别越积越落后
			latest := pl.mediaSeq
			if n := len(pl.segments); n > 0 {
				latest = pl.segments[n-1].seq
			}
			if next < latest {
				appLog("hls.log", fmt.Sprintf("分片 %d 已过期，跳到 %d", next, latest))
				next = latest
				continue
			}
			// 还没生成新分片：等半个目标时长再刷新
			wait := time.Duration(targetDur/2*float64(time.Second))
			if wait < 300*time.Millisecond {
				wait = 300 * time.Millisecond
			}
			if time.Since(lastRefresh) > wait {
				refresh()
			}
			time.Sleep(250 * time.Millisecond)
			continue
		}

		data, e := f.get(ctx, seg.uri)
		if e != nil {
			appLog("hls.log", fmt.Sprintf("拉分片 %d 失败: %v", seg.seq, e))
			next = seg.seq + 1
			continue
		}
		n, e := dw.feed(data)
		frameTotal += n
		if e != nil {
			appLog("hls.log", "写响应失败（多半是客户端关了）: "+e.Error())
			return
		}
		if fl != nil {
			fl.Flush()
		}
		next = seg.seq + 1

		// 每次回到播放位置附近就刷新一次 playlist，滚动窗口才不会断
		if time.Since(lastRefresh) > time.Duration(targetDur*0.5*float64(time.Second)) {
			refresh()
		}
	}
}

func mustURL(s string) *url.URL {
	u, err := url.Parse(s)
	if err != nil {
		return nil
	}
	return u
}
