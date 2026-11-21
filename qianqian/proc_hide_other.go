//go:build !windows

package qianqian

import "os/exec"

func hideConsole(cmd *exec.Cmd) {}
