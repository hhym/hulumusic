package qianqian

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

/* 常驻子进程（插件里的辅助程序）。

   有些插件（比如汽水音乐那版）不是「跑一次拿 stdout」，而是开一个辅助程序，
   然后用「一行一条 JSON」跟它长期对话：写一条 spec、读一条结果。原来的
   RunProcess 是一次性的，满足不了这种协议，所以这里单独做一套：

     StartPluginProcess(bin,args) → id
     PluginProcWrite(id, data)    → 往里写一行
     PluginProcReadLine(id, ms)   → 读一行（阻塞到有数据或超时）
     PluginProcKill(id) / PluginProcWait(id) / PluginProcStderr(id)

   安全约束沿用 RunProcess 那套，并且更严：程序必须真的在插件自己的目录里
   （不接受 ../ 或绝对路径跑到别处），而且得有一个启用中的插件在 plugin.json
   的 permissions.process 里声明过（支持 bin/xxx-* 这种通配），最后还要用户
   在设置里打开「允许插件运行本机程序」。 */

type childProc struct {
	cmd   *exec.Cmd
	stdin io.WriteCloser
	out   *bufio.Reader
	lines chan string
	errb  bytes.Buffer

	done chan struct{}
	code int
}

var procHub = struct {
	sync.Mutex
	m    map[string]*childProc
	next int
}{m: map[string]*childProc{}}

// 把插件给的相对路径解析到插件目录，并保证跑不出 plugins 目录。
func pluginExecPath(bin string) (string, string) {
	p := strings.TrimSpace(bin)
	if p == "" {
		return "", "没有指定要运行的程序"
	}
	if !filepath.IsAbs(p) {
		p = filepath.Join(pluginsDir(), p)
	}
	p = filepath.Clean(p)
	root, err := filepath.Abs(pluginsDir())
	if err != nil {
		return "", "插件目录不可用"
	}
	abs, err := filepath.Abs(p)
	if err != nil {
		return "", "路径无效"
	}
	rel, err := filepath.Rel(root, abs)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", "插件只能运行自己目录里的程序：" + filepath.Base(abs)
	}
	st, err := os.Stat(abs)
	if err != nil || st.IsDir() {
		return "", "找不到插件目录里的程序：" + filepath.Base(abs)
	}
	return abs, ""
}

// 启用中的插件声明过的 process 通配（已归一化成 basename 上的模式）。
func declaredProcessPatterns() map[string]bool {
	out := map[string]bool{}
	dir := pluginsDir()
	entries, err := os.ReadDir(dir)
	if err != nil {
		return out
	}
	state := loadPluginState()
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		id := e.Name()
		if v, ok := state[id]; ok && !v {
			continue
		}
		b, err := os.ReadFile(filepath.Join(dir, id, "plugin.json"))
		if err != nil {
			continue
		}
		var m struct {
			Permissions struct {
				Process []string `json:"process"`
			} `json:"permissions"`
		}
		if json.Unmarshal(b, &m) != nil {
			continue
		}
		for _, p := range m.Permissions.Process {
			if p = strings.TrimSpace(p); p == "" {
				continue
			}
			out[strings.ToLower(filepath.Base(filepath.ToSlash(p)))] = true
		}
	}
	return out
}

func processDeclared(base string) bool {
	base = strings.ToLower(base)
	if processAllowList[base] {
		return true
	}
	for pat := range declaredProcessPatterns() {
		if ok, err := filepath.Match(pat, base); err == nil && ok {
			return true
		}
	}
	return false
}

// StartPluginProcess 起一个可对话的子进程，返回句柄 id。
func (a *App) StartPluginProcess(bin string, args []string) (string, string) {
	procLog("[" + time.Now().Format("15:04:05") + "] start bin=" + bin + " args=" + strings.Join(args, ",") + "\n")
	path, errMsg := pluginExecPath(bin)
	if errMsg != "" {
		procLog("[start-failed] " + errMsg + "\n")
		return "", errMsg
	}
	base := strings.ToLower(filepath.Base(path))
	if !processDeclared(base) {
		procLog("[start-failed] 没有插件声明过 " + filepath.Base(path) + " 权限\n")
		return "", "没有启用的插件声明过 " + filepath.Base(path) + " 权限"
	}
	if base != "ffmpeg" && base != "ffmpeg.exe" {
		if !a.loadSettings().AllowPluginProcess {
			return "", "插件要运行 " + filepath.Base(path) +
				"，但设置里的「允许插件运行本机程序」还没打开（设置 → 插件权限）"
		}
	}

	cmd := exec.Command(path, args...)
	cmd.Env = append(os.Environ(), "LC_ALL=C")
	// helper 是控制台程序，不隐藏就会在桌面弹一堆黑窗口
	hideConsole(cmd)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return "", "启动失败：" + err.Error()
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return "", "启动失败：" + err.Error()
	}
	cp := &childProc{
		cmd:   cmd,
		stdin: stdin,
		out:   bufio.NewReaderSize(stdout, 64*1024),
		lines: make(chan string, 64),
		done:  make(chan struct{}),
	}
	cmd.Stderr = &cp.errb
	if err := cmd.Start(); err != nil {
		return "", "启动失败：" + err.Error()
	}

	go func() {
		for {
			line, err := cp.out.ReadString('\n')
			line = strings.TrimRight(line, "\r\n")
			if line != "" {
				select {
				case cp.lines <- line:
				}
			}
			if err != nil {
				break
			}
		}
	}()

	go func() {
		err := cmd.Wait()
		if err != nil {
			cp.code = -1
			if cmd.ProcessState != nil {
				cp.code = cmd.ProcessState.ExitCode()
			}
		}
		// helper 只把错误归类成 frame.error（response/setup/...），真正原因在 stderr，
		// 用户看不到。这里把 stderr 和退出码追加到数据目录，排查时直接看文件。
		procLog("[" + time.Now().Format("2006-01-02 15:04:05") + "] " + filepath.Base(path) + " exit=" + strconv.Itoa(cp.code) + " stderr=" + cp.errb.String() + "\n")
		close(cp.lines)
		close(cp.done)
	}()

	procHub.Lock()
	procHub.next++
	id := strconv.Itoa(procHub.next)
	procHub.m[id] = cp
	procHub.Unlock()
	return id, ""
}

func procOf(id string) (*childProc, string) {
	procHub.Lock()
	cp := procHub.m[id]
	procHub.Unlock()
	if cp == nil {
		return nil, "辅助进程已经结束，请重试"
	}
	return cp, ""
}

func (a *App) PluginProcWrite(id, data string) string {
	procLog("[" + time.Now().Format("15:04:05") + "] call write id=" + id + " len=" + strconv.Itoa(len(data)) + "\n")
	cp, errMsg := procOf(id)
	if errMsg != "" {
		return errMsg
	}
	if cp.stdin == nil {
		return "stdin 已经关闭"
	}
	short := data
	if len(short) > 600 {
		short = short[:600] + "…"
	}
	procLog("[" + time.Now().Format("15:04:05") + "] stdin " + strings.ReplaceAll(short, "\n", " ↵ ") + "\n")
	if _, err := cp.stdin.Write([]byte(data)); err != nil {
		return "写入失败：" + err.Error()
	}
	return ""
}

func (a *App) PluginProcReadLine(id string, timeoutMs int) (string, string) {
	procLog("[" + time.Now().Format("15:04:05") + "] call readline timeout=" + strconv.Itoa(timeoutMs) + "\n")
	cp, errMsg := procOf(id)
	if errMsg != "" {
		return "", errMsg
	}
	if timeoutMs <= 0 || timeoutMs > 300000 {
		timeoutMs = 25000
	}
	select {
	case line, ok := <-cp.lines:
		if !ok {
			return "", "辅助进程已退出"
		}
		show := line
		if len(show) > 800 {
			show = show[:800] + "…"
		}
		procLog("[" + time.Now().Format("15:04:05") + "] stdout " + show + "\n")
		if strings.Contains(line, "\"error\"") {
			// 错误帧当场落盘，并带上此刻的 stderr：helper 是常驻的，等它退出再记就太晚了。
			procLog("[" + time.Now().Format("15:04:05") + "] frame " + line + " | stderr=" + cp.errb.String() + "\n")
		}
		return line, ""
	case <-time.After(time.Duration(timeoutMs) * time.Millisecond):
		return "", "辅助进程响应超时"
	}
}

// PluginProcCloseStdin 只关掉 stdin，让 helper 读到 EOF 后自己退出。
func (a *App) PluginProcCloseStdin(id string) string {
	procLog("[" + time.Now().Format("15:04:05") + "] call closeStdin\n")
	cp, errMsg := procOf(id)
	if errMsg != "" {
		return errMsg
	}
	if cp.stdin != nil {
		if err := cp.stdin.Close(); err != nil {
			return "关闭写入失败：" + err.Error()
		}
		cp.stdin = nil
	}
	return ""
}

func (a *App) PluginProcStderr(id string) (string, string) {
	cp, errMsg := procOf(id)
	if errMsg != "" {
		return "", errMsg
	}
	return tailString(cp.errb.String(), 4096), ""
}

func (a *App) PluginProcKill(id string) string {
	procLog("[" + time.Now().Format("15:04:05") + "] call kill\n")
	cp, errMsg := procOf(id)
	if errMsg != "" {
		return errMsg
	}
	if cp.stdin != nil {
		_ = cp.stdin.Close()
	}
	if cp.cmd.Process != nil {
		_ = cp.cmd.Process.Kill()
	}
	return ""
}

func (a *App) PluginProcWait(id string, timeoutSec int) (int, string) {
	cp, errMsg := procOf(id)
	if errMsg != "" {
		return -1, errMsg
	}
	if timeoutSec <= 0 || timeoutSec > 600 {
		timeoutSec = 180
	}
	select {
	case <-cp.done:
		return cp.code, ""
	case <-time.After(time.Duration(timeoutSec) * time.Second):
		return -1, fmt.Sprintf("等待超时（%d 秒）", timeoutSec)
	}
}

// procLog 把插件辅助进程的诊断信息追加到数据目录，方便用户回贴。
func procLog(line string) {
	p := filepath.Join(dataDir(), "plugin-proc.log")
	f, err := os.OpenFile(p, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	if st, err := f.Stat(); err == nil && st.Size() > 2<<20 {
		_ = os.Truncate(p, 0)
	}
	_, _ = f.WriteString(line)
}

// ProcTrace 让前端把关键步骤写进同一份 plugin-proc.log，便于定位「点了没反应」。
func (a *App) ProcTrace(note string) string {
	procLog("[" + time.Now().Format("15:04:05") + "] ui " + note + "\n")
	return ""
}
