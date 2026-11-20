package qianqian

/* 云听（央广）电台目录 —— 全量版。

   接口没有文档，签名是页面 api.js 那套：参数按 key 升序拼成 k=v&...，再拼
   &timestamp=<ms>&key=<固定密钥>，取 MD5 大写当 sign 头。每个请求都要现算，
   因为流地址里的 key/time 是随请求签发的，缓存下来的地址过一会儿就 404。

   全量目录的抓法：先取省份表（32 个，含「国家 0」），再按每个省拉一次
   /web/appBroadcast/list（categoryId=0 取该省全部台），去重后就是 979 个。
   32 个请求并发 3、批间 180ms 就够，云端不会 503；实测 11 秒抓完。

   目录落盘缓存 12 小时：启动先读本地（零请求），过期了再后台静默重建，
   重建失败保留旧目录。逐省重试 3 次（300/1200ms 退避），还失败的省沿用上一份。 */

import (
	"crypto/md5"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	cloudBase = "https://ytmsout.radio.cn"
	cloudKey  = "f0fc4c668392f9f9a447e48584c214ee"
)

type cloudTrack struct {
	ContentID    string `json:"contentId"`
	Title        string `json:"title"`
	Subtitle     string `json:"subtitle"`
	Image        string `json:"image"`
	PlayURLMulti string `json:"playUrlMulti"`
	MP3High      string `json:"mp3PlayUrlHigh"`
	MP3Low       string `json:"mp3PlayUrlLow"`
	PlayURLLow   string `json:"playUrlLow"`
	Region       string `json:"region"`
}

type cloudProvince struct {
	Name string `json:"provinceName"`
	Code int64  `json:"provinceCode"`
}

type cloudResp struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data"`
}

func md5Upper(s string) string {
	sum := md5.Sum([]byte(s))
	return strings.ToUpper(fmt.Sprintf("%x", sum))
}

// cloudSign 返回本次请求要带的 timestamp 与 sign。
func cloudSign(params map[string]string) (ts, sign string) {
	keys := make([]string, 0, len(params))
	for k := range params {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var sb strings.Builder
	for i, k := range keys {
		if i > 0 {
			sb.WriteByte('&')
		}
		sb.WriteString(k)
		sb.WriteByte('=')
		sb.WriteString(params[k])
	}
	if sb.Len() > 0 {
		sb.WriteByte('&')
	}
	ts = fmt.Sprintf("%d", time.Now().UnixMilli())
	sb.WriteString("timestamp=" + ts + "&key=" + cloudKey)
	return ts, md5Upper(sb.String())
}

// cloudRaw 发一次带签名的请求，返回 data 字段的原始 JSON。
func cloudRaw(path string, params map[string]string) ([]byte, error) {
	ts, sign := cloudSign(params)
	q := url.Values{}
	for k, v := range params {
		q.Set(k, v)
	}
	u := cloudBase + path
	if len(params) > 0 {
		u += "?" + q.Encode()
	}
	req, err := http.NewRequest("GET", u, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("timestamp", ts)
	req.Header.Set("sign", sign)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("equipmentId", "0000")
	req.Header.Set("platformCode", "WEB")
	req.Header.Set("Referer", "https://www.radio.cn/")
	req.Header.Set("User-Agent", uaDesktop)

	client := &http.Client{Timeout: 8 * time.Second}
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("云听接口 HTTP %d", res.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	if err != nil {
		return nil, err
	}
	var r cloudResp
	if err := json.Unmarshal(b, &r); err != nil {
		return nil, fmt.Errorf("云听返回不是 JSON")
	}
	if r.Code != 0 {
		return nil, fmt.Errorf("云听返回 code=%d %s", r.Code, r.Message)
	}
	return r.Data, nil
}

func cloudProvinces() ([]cloudProvince, error) {
	data, err := cloudRaw("/web/appProvince/list/all", nil)
	if err != nil {
		return nil, err
	}
	var ps []cloudProvince
	if err := json.Unmarshal(data, &ps); err != nil {
		return nil, fmt.Errorf("省份表解析失败")
	}
	// 「国家 0」排最前，其余按名字排，前端看着顺
	sort.Slice(ps, func(i, j int) bool {
		if ps[i].Code == 0 {
			return true
		}
		if ps[j].Code == 0 {
			return false
		}
		return ps[i].Name < ps[j].Name
	})
	return ps, nil
}

// cloudTracksOfProvince 取一个省的全部台，失败重试三次（云端 503 是常事）。
func cloudTracksOfProvince(p cloudProvince) ([]cloudTrack, error) {
	var last error
	for attempt := 0; attempt < 3; attempt++ {
		if attempt > 0 {
			wait := 300 * time.Millisecond
			if attempt > 1 {
				wait = 1200 * time.Millisecond
			}
			time.Sleep(wait)
		}
		data, err := cloudRaw("/web/appBroadcast/list", map[string]string{
			"provinceCode": fmt.Sprintf("%d", p.Code),
			"categoryId":   "0",
		})
		if err != nil {
			last = err
			continue
		}
		var ts []cloudTrack
		if err := json.Unmarshal(data, &ts); err != nil {
			last = fmt.Errorf("台表解析失败")
			continue
		}
		for i := range ts {
			ts[i].Region = p.Name
		}
		return ts, nil
	}
	return nil, last
}

/* ── 目录状态 ─────────────────────────────────────────────────────────── */

type cloudCatalog struct {
	mu      sync.Mutex
	items   []cloudTrack
	at      time.Time
	busy    bool
	loaded  bool
	done    chan struct{} // 第一次抓完关掉，给 Stations() 等用
	lastErr error
}

var catalog = &cloudCatalog{}

func cloudCachePath() string { return filepath.Join(dataDir(), "cloud-catalog.json") }

type cloudCacheFile struct {
	At    int64        `json:"at"`
	Items []cloudTrack `json:"items"`
}

func loadCatalogCache() {
	catalog.mu.Lock()
	defer catalog.mu.Unlock()
	if catalog.loaded {
		return
	}
	catalog.loaded = true
	b, err := os.ReadFile(cloudCachePath())
	if err != nil {
		return
	}
	var f cloudCacheFile
	if err := json.Unmarshal(b, &f); err != nil {
		return
	}
	if len(f.Items) > 0 {
		catalog.items = f.Items
		catalog.at = time.Unix(f.At, 0)
		appLog("cloud.log", fmt.Sprintf("读本地目录：%d 个台（%s 抓的）", len(f.Items), catalog.at.Format("01-02 15:04")))
	}
}

func saveCatalogCache(items []cloudTrack, at time.Time) {
	b, err := json.Marshal(cloudCacheFile{At: at.Unix(), Items: items})
	if err != nil {
		return
	}
	if err := os.WriteFile(cloudCachePath(), b, 0o644); err != nil {
		appLog("cloud.log", "目录缓存写盘失败: "+err.Error())
	}
}

// buildCloudCatalog 32 个省并发 3 抓一遍，失败省份用旧目录回填。
func buildCloudCatalog(old []cloudTrack) ([]cloudTrack, error) {
	provinces, err := cloudProvinces()
	if err != nil {
		return nil, err
	}
	oldByRegion := map[string][]cloudTrack{}
	for _, t := range old {
		oldByRegion[t.Region] = append(oldByRegion[t.Region], t)
	}

	type result struct {
		items []cloudTrack
		prov  cloudProvince
		err   error
	}
	results := make([]result, len(provinces))
	sem := make(chan struct{}, 3)
	var wg sync.WaitGroup
	for i, p := range provinces {
		wg.Add(1)
		sem <- struct{}{}
		go func(i int, p cloudProvince) {
			defer wg.Done()
			defer func() { <-sem }()
			items, e := cloudTracksOfProvince(p)
			results[i] = result{items, p, e}
			time.Sleep(180 * time.Millisecond) // 批间留点空隙，别把云端打 503
		}(i, p)
	}
	wg.Wait()

	seen := map[string]int{}
	out := make([]cloudTrack, 0, 1000)
	failed := 0
	var lastErr error
	for _, r := range results {
		if r.err != nil {
			failed++
			lastErr = r.err
			out = append(out, oldByRegion[r.prov.Name]...)
			continue
		}
		for _, t := range r.items {
			if t.ContentID == "" {
				continue
			}
			if idx, ok := seen[t.ContentID]; ok {
				// 同一台可能在省表和国家表里各出现一次，缺的地址互补一下
				if out[idx].PlayURLMulti == "" {
					out[idx].PlayURLMulti = t.PlayURLMulti
				}
				if out[idx].MP3High == "" {
					out[idx].MP3High = t.MP3High
				}
				continue
			}
			seen[t.ContentID] = len(out)
			out = append(out, t)
		}
	}
	if failed > 0 {
		appLog("cloud.log", fmt.Sprintf("有 %d 个省的台表抓取失败（已用旧目录回填）: %v", failed, lastErr))
	}
	return out, nil
}

func refreshCatalogAsync() {
	catalog.mu.Lock()
	if catalog.busy {
		catalog.mu.Unlock()
		return
	}
	catalog.busy = true
	old := catalog.items
	catalog.mu.Unlock()

	go func() {
		start := time.Now()
		items, err := buildCloudCatalog(old)
		catalog.mu.Lock()
		catalog.busy = false
		if err != nil {
			catalog.lastErr = err
			appLog("cloud.log", "目录重建失败: "+err.Error())
			if catalog.done != nil {
				close(catalog.done)
				catalog.done = nil
			}
			catalog.mu.Unlock()
			return
		}
		catalog.items = items
		catalog.at = time.Now()
		if catalog.done != nil {
			close(catalog.done)
			catalog.done = nil
		}
		catalog.mu.Unlock()
		saveCatalogCache(items, time.Now())
		appLog("cloud.log", fmt.Sprintf("云听全量目录已更新：%d 个台（%d 个省，%.1fs）", len(items), len(cloudProvincesNames(items)), time.Since(start).Seconds()))
	}()
}

// cloudProvincesNames 数一下目录里实际有多少个地区（只用于日志）。
func cloudProvincesNames(items []cloudTrack) []string {
	m := map[string]bool{}
	for _, t := range items {
		if t.Region != "" {
			m[t.Region] = true
		}
	}
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// cloudCatalogItems 拿目录：本地有就先用本地的（过期了后台重建），没有就等一次抓取。
func cloudCatalogItems(wait time.Duration) []cloudTrack {
	loadCatalogCache()
	catalog.mu.Lock()
	items, at, done := catalog.items, catalog.at, catalog.done
	catalog.mu.Unlock()

	if len(items) > 0 {
		if time.Since(at) > 12*time.Hour {
			refreshCatalogAsync()
		}
		return items
	}

	// 一次缓存都没有：第一次启动，等后台抓完（最多等 wait）
	catalog.mu.Lock()
	if catalog.done == nil {
		catalog.done = make(chan struct{})
	}
	done = catalog.done
	catalog.mu.Unlock()
	refreshCatalogAsync()
	if done == nil {
		return nil
	}
	select {
	case <-done:
	case <-time.After(wait):
		appLog("cloud.log", "首次抓全量目录超时，先给空列表")
	}
	catalog.mu.Lock()
	items = catalog.items
	catalog.mu.Unlock()
	return items
}

// CloudStations 给电台页用的云听台列表。失败就返回空，别把整页拖挂。
func (a *App) CloudStations() []Station {
	tracks := cloudCatalogItems(25 * time.Second)
	if len(tracks) == 0 {
		return nil
	}
	out := make([]Station, 0, len(tracks))
	for _, t := range tracks {
		desc := strings.TrimSpace(t.Subtitle)
		if desc == "" {
			desc = "云听 · " + t.Region
		} else {
			desc = "云听 · " + desc
		}
		region := t.Region
		if region == "" {
			region = "中国"
		}
		out = append(out, Station{
			ID:     "cloud:" + t.ContentID,
			Name:   t.Title,
			Desc:   desc,
			Region: region,
			Logo:   t.Image,
		})
	}
	return out
}

// cloudStreamURL 按 contentId 现取一条带签名的地址（key/time 每次都不一样）。
func cloudStreamURL(contentID string, high bool) (string, error) {
	tracks := cloudCatalogItems(25 * time.Second)
	for _, t := range tracks {
		if t.ContentID != contentID {
			continue
		}
		cands := []string{t.PlayURLMulti, t.MP3High, t.PlayURLLow, t.MP3Low}
		if !high {
			cands = []string{t.MP3Low, t.PlayURLLow, t.PlayURLMulti, t.MP3High}
		}
		for _, c := range cands {
			if c != "" {
				return c, nil
			}
		}
	}
	return "", fmt.Errorf("这个央广电台没有可用的直播地址")
}

// WarmCloudCatalog 启动时后台预热一次目录：先读本地缓存，过期才重建。
func WarmCloudCatalog() {
	loadCatalogCache()
	catalog.mu.Lock()
	at, n := catalog.at, len(catalog.items)
	catalog.mu.Unlock()
	if n == 0 || time.Since(at) > 12*time.Hour {
		refreshCatalogAsync()
	}
}

// RefreshCloudStations 手动重建目录（设置页/电台页的「刷新台表」用）。
func (a *App) RefreshCloudStations() []Station {
	refreshCatalogAsync()
	return a.CloudStations()
}

// CloudCatalogCount 给前端显示「共 N 个台」。
func (a *App) CloudCatalogCount() int {
	catalog.mu.Lock()
	defer catalog.mu.Unlock()
	return len(catalog.items)
}
