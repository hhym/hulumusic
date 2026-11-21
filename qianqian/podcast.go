package qianqian

/* 听书 / 播客：和插件同一条链路 ——
   Apple 播客目录搜索（country=cn，同时覆盖小宇宙和喜马拉雅的节目）
   → 拿到节目 RSS(feedUrl) → 解析单集 enclosure 直链播放。 */

import (
	"encoding/json"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

type Show struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Author  string `json:"author"`
	Cover   string `json:"cover"`
	FeedURL string `json:"feedUrl"`
	Count   int    `json:"count"`
	Desc    string `json:"desc"`
}

type itunesResultT = struct {
	CollectionID   int64  `json:"collectionId"`
	CollectionName string `json:"collectionName"`
	ArtistName     string `json:"artistName"`
	ArtworkURL600  string `json:"artworkUrl600"`
	ArtworkURL100  string `json:"artworkUrl100"`
	FeedURL        string `json:"feedUrl"`
	TrackCount     int    `json:"trackCount"`
	Genre          string `json:"primaryGenreName"`
}

type itunesResp struct {
	ResultCount int             `json:"resultCount"`
	Results     []itunesResultT `json:"results"`
}

const applePodcastAPI = "https://itunes.apple.com/search"

// PodcastSearch 用 Apple 播客目录搜节目（走 cn 区，中文节目优先）
func (a *App) PodcastSearch(term string) ([]Show, string) {
	if strings.TrimSpace(term) == "" {
		return []Show{}, ""
	}
	// cn 区的中文节目收录不全（「有声书」「相声」这种泛词经常只回个位数），
	// 空了就再用美国区搜一次，两边合起来去重
	var res []itunesResultT
	firstErr := ""
	for _, country := range []string{"cn", "us"} {
		u := applePodcastAPI + "?" + url.Values{
			"term":    {term},
			"entity":  {"podcast"},
			"limit":   {"20"},
			"country": {country},
		}.Encode()
		txt, err := getText(u, map[string]string{"User-Agent": uaDesktop})
		if err != nil {
			if firstErr == "" {
				firstErr = "连不上 Apple 播客目录：" + err.Error()
			}
			continue
		}
		var j itunesResp
		if json.Unmarshal([]byte(txt), &j) != nil {
			continue
		}
		res = append(res, j.Results...)
		if country == "cn" && len(res) >= 12 {
			break // 中文区已经够多了，不必再混英文区的同名节目
		}
	}
	if len(res) == 0 && firstErr != "" {
		return []Show{}, firstErr
	}
	out := make([]Show, 0, len(res))
	seen := map[string]bool{}
	for _, x := range res {
		if seen[x.FeedURL] {
			continue
		}
		seen[x.FeedURL] = true
		if x.FeedURL == "" {
			continue
		}
		cover := x.ArtworkURL600
		if cover == "" {
			cover = x.ArtworkURL100
		}
		desc := x.Genre
		if desc == "" {
			desc = "by " + x.ArtistName
		}
		out = append(out, Show{
			ID:      "pod:" + strconv.FormatInt(x.CollectionID, 10),
			Name:    x.CollectionName,
			Author:  x.ArtistName,
			Cover:   cover,
			FeedURL: x.FeedURL,
			Count:   x.TrackCount,
			Desc:    desc,
		})
	}
	if len(out) == 0 {
		return out, "没搜到这个节目，换个关键词试试"
	}
	return out, ""
}

/* ---------- RSS 解析 ---------- */

type rssEnclosure struct {
	URL    string `xml:"url,attr"`
	Type   string `xml:"type,attr"`
	Length string `xml:"length,attr"`
}

type rssImage struct {
	Href string `xml:"href,attr"`
}

type rssItem struct {
	Title       string       `xml:"title"`
	GUID        string       `xml:"guid"`
	PubDate     string       `xml:"pubDate"`
	Description string       `xml:"description"`
	Enclosure   rssEnclosure `xml:"enclosure"`
	Duration    string       `xml:"http://www.itunes.com/dtds/podcast-1.0.dtd duration"`
	Author      string       `xml:"http://www.itunes.com/dtds/podcast-1.0.dtd author"`
	Image       rssImage     `xml:"http://www.itunes.com/dtds/podcast-1.0.dtd image"`
}

type rssDoc struct {
	Channel struct {
		Title string    `xml:"title"`
		Image rssImage  `xml:"http://www.itunes.com/dtds/podcast-1.0.dtd image"`
		Items []rssItem `xml:"item"`
	} `xml:"channel"`
}

// podcastDuration 解析 itunes:duration，可能写 "01:32:46" 也可能纯秒数
func podcastDuration(s string) int {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0
	}
	if n, err := strconv.Atoi(s); err == nil {
		return n * 1000
	}
	parts := strings.Split(s, ":")
	total := 0
	for _, p := range parts {
		n, _ := strconv.Atoi(strings.TrimSpace(p))
		total = total*60 + n
	}
	return total * 1000
}

// PodcastEpisodes 拉某个节目的单集列表。RSS 可能有几 MB，用流式解码。
func (a *App) PodcastEpisodes(feedURL string) ([]Track, string) {
	if feedURL == "" {
		return []Track{}, "缺少 RSS 地址"
	}
	req, err := newGetRequest(feedURL)
	if err != nil {
		return []Track{}, err.Error()
	}
	res, err := httpClient.Do(req)
	if err != nil {
		return []Track{}, "拉取 RSS 失败：" + err.Error()
	}
	defer res.Body.Close()
	if res.StatusCode >= 400 {
		return []Track{}, fmt.Sprintf("RSS 返回 %d", res.StatusCode)
	}

	dec := xml.NewDecoder(io.LimitReader(res.Body, 20<<20))
	var doc rssDoc
	if err := dec.Decode(&doc); err != nil {
		return []Track{}, "RSS 解析失败：" + err.Error()
	}

	chImg := doc.Channel.Image.Href
	out := make([]Track, 0, len(doc.Channel.Items))
	for _, it := range doc.Channel.Items {
		audio := it.Enclosure.URL
		if audio == "" {
			continue
		}
		cover := chImg
		if cover == "" {
			cover = it.Image.Href
		}
		title := strings.TrimSpace(it.Title)
		title = strings.Join(strings.Fields(title), " ")
		if title == "" {
			title = "未命名单集"
		}
		artist := it.Author
		if artist == "" {
			artist = doc.Channel.Title
		}
		out = append(out, Track{
			ID:       "pode:" + encodeTarget(audio),
			Name:     title,
			Artist:   artist,
			Album:    doc.Channel.Title,
			Cover:    cover,
			Duration: podcastDuration(it.Duration),
			Source:   "pod",
		})
	}
	if len(out) == 0 {
		return out, "这个节目没有可播放的单集"
	}
	return out, ""
}

func newGetRequest(rawURL string) (*http.Request, error) {
	req, err := http.NewRequest("GET", rawURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", uaDesktop)
	req.Header.Set("Accept", "application/rss+xml, application/xml, text/xml, */*")
	return req, nil
}
