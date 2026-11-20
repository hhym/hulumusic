package qianqian

/* LATM(LOAS) → ADTS。

   少数地方台在 PMT 里声明 stream_type 0x11（AAC over LATM），PES 里是 LOAS 封装：
   每个元素以 0x56E? 开头 + 13 位长度，随后才是 AudioMuxElement。首个元素带
   StreamMuxConfig（内含 AudioSpecificConfig），之后的元素 useSameStreamMux=1，
   只跟一段 PayloadLengthInfo。

   两个坑必须按实际编码器的写法处理，否则解出来全是坏帧：

   1. 载荷不按字节对齐。ffmpeg latmenc 里有一行明确注释 "The LATM payload is written
      unaligned"，编码器把 AAC 原始帧直接按位塞进去，所以取出来要重新排到字节边界，
      再做 ADTS。
   2. 长度按 255 分块：读 8 位，等于 255 就再读一段累加，直到不足 255。

   拿到长度后，ADTS 头里的 profile / 采样率索引 / 声道数都来自配置帧的 ASC。 */

import "fmt"

type bitR struct {
	b []byte
	p int
}

func (r *bitR) bit() int {
	if r.p >= len(r.b)*8 {
		r.p++
		return 0
	}
	v := (r.b[r.p>>3] >> (7 - (uint(r.p) & 7))) & 1
	r.p++
	return int(v)
}

func (r *bitR) bits(n int) int {
	v := 0
	for i := 0; i < n; i++ {
		v = v<<1 | r.bit()
	}
	return v
}

type latmConv struct {
	buf      []byte
	ready    bool
	profile  int // ADTS 的 profile 字段 = ASC 的 object type - 1
	sfi      int // 采样率索引
	cc       int // 声道配置
	subframes int
	in       int
	skipped  int
	bad      int
}

// feed 吃一段 PES 里的 LATM 数据，吐出可以直接落到 ADTS 流里的字节。
func (c *latmConv) feed(data []byte) []byte {
	c.in += len(data)
	c.buf = append(c.buf, data...)
	var out []byte
	pos := 0
	for {
		for pos+2 < len(c.buf) && !(c.buf[pos] == 0x56 && c.buf[pos+1]&0xE0 == 0xE0) {
			pos++
		}
		if pos+3 > len(c.buf) {
			break
		}
		l := int(c.buf[pos+1]&0x1F)<<8 | int(c.buf[pos+2])
		if l < 3 {
			pos += 3
			continue
		}
		if pos+3+l > len(c.buf) {
			break // 元素还没收全，等下一个 TS 包
		}
		out = append(out, c.element(c.buf[pos+3:pos+3+l])...)
		pos += 3 + l
	}
	if pos > 0 {
		c.buf = c.buf[pos:]
	}
	if len(c.buf) > 64<<10 {
		c.buf = c.buf[len(c.buf)-8192:]
	}
	return out
}

func (c *latmConv) element(el []byte) []byte {
	r := &bitR{b: el}
	useSame := r.bit()
	amv := 0
	nSub := c.subframes

	if useSame == 0 {
		amv = r.bit()
		if amv == 1 {
			// audioMuxVersion=1 的配置多一层 latmGetValue，极少见，直接跳过别放坏帧
			c.skipped++
			return nil
		}
		if r.bit() == 0 { // allStreamsSameTimeFraming：0 表示各层参数不同，不支持
			c.skipped++
			return nil
		}
		nSub = r.bits(6) + 1
		if r.bits(4)+1 != 1 || r.bits(3)+1 != 1 { // numProgram / numLayer
			c.skipped++
			return nil
		}
		aot := r.bits(5)
		if aot == 31 {
			aot = 32 + r.bits(6)
		}
		sfi := r.bits(4)
		if sfi == 15 {
			c.skipped++ // 显式 24 位采样率，ADTS 表达不了
			return nil
		}
		cc := r.bits(4)
		r.bits(3) // GASpecificConfig: frameLengthFlag / dependsOnCoreCoder / extensionFlag
		flt := r.bits(3)
		switch flt {
		case 0:
			r.bits(8) // latmBufferFullness
		case 1, 3, 4, 5:
			// 固定帧长 / CELP 类，不是我们要的 1024 点 AAC 帧
			c.skipped++
			return nil
		case 6, 7:
			r.bits(1)
		}
		if r.bit() == 1 { // otherDataPresent
			bits := r.bits(8)
			if amv == 1 {
				bits = r.bits(32)
			}
			if bits > 4096 {
				c.skipped++
				return nil
			}
			for i := 0; i < bits; i++ {
				r.bit()
			}
		}
		if r.bit() == 1 { // crcCheckPresent
			r.bits(8)
		}
		c.profile = aot - 1
		c.sfi = sfi
		c.cc = cc
		c.subframes = nSub
		c.ready = true
	}

	if !c.ready {
		c.skipped++
		return nil
	}

	var out []byte
	for i := 0; i < nSub; i++ {
		total := 0
		for {
			v := r.bits(8)
			total += v
			if v != 255 {
				break
			}
			if total > 8192 {
				break
			}
		}
		if total <= 16 || total > 4096 {
			c.bad++
			break
		}
		pay, ok := repackBits(r, total*8)
		if !ok {
			c.bad++
			break
		}
		out = append(out, adtsHeader(c.profile, c.sfi, c.cc, total+7)...)
		out = append(out, pay...)
	}
	return out
}

// repackBits 从位读取器里连续取 n 位，排成字节（不足补 0）。
func repackBits(r *bitR, n int) ([]byte, bool) {
	if r.p+n > len(r.b)*8 {
		return nil, false
	}
	out := make([]byte, (n+7)/8)
	for i := 0; i < n; i++ {
		if r.bit() == 1 {
			out[i>>3] |= 1 << (7 - (uint(i) & 7))
		}
	}
	return out, true
}

// adtsHeader 拼一个 7 字节 ADTS 头（无 CRC）。
func adtsHeader(profile, sfi, cc, flen int) []byte {
	return []byte{
		0xFF, 0xF1,
		byte((profile&3)<<6) | byte((sfi&0x0F)<<2) | byte((cc>>2)&1),
		byte((cc&3)<<6) | byte((flen>>11)&3),
		byte((flen >> 3) & 0xFF),
		byte((flen&7)<<5) | 0x1F,
		0xFC,
	}
}

// latmInfo 给日志用：解了几帧、跳了几帧。
func (c *latmConv) info() string {
	return fmt.Sprintf("LATM: 喂入=%d 字节 profile=%d sfi=%d cc=%d 跳过=%d 坏帧=%d", c.in, c.profile, c.sfi, c.cc, c.skipped, c.bad)
}
