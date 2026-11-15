//go:build !windows

package main

import "log"

func showMessage(title, text string, isErr bool) { log.Printf("%s: %s", title, text) }
