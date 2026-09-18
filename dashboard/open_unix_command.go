//go:build darwin || linux

package main

import (
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"strings"
)

// runOpenCommand is the test seam (open_command_test.go stubs it). Production
// callers pass only the fixed program names below; targets are validated before
// exec — a scanned job "URL" can never become an option, an arbitrary scheme,
// or a filesystem path handed to the OS opener.
var runOpenCommand = func(name string, args ...string) error {
	if err := validateOpenTarget(args...); err != nil {
		return err
	}
	switch name {
	case "open":
		return exec.Command("open", args...).Run()
	case "xdg-open":
		return exec.Command("xdg-open", args...).Run()
	}
	return fmt.Errorf("unsupported opener: %q", name)
}

func validateOpenTarget(args ...string) error {
	for _, a := range args {
		if strings.HasPrefix(a, "-") {
			return fmt.Errorf("refusing option-like open target: %q", a)
		}
		u, err := url.Parse(a)
		isWebURL := err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Host != ""
		if !isWebURL {
			// Non-URL targets must be existing local files (e.g. the generated
			// CV PDF path built in-process) — nothing else reaches exec.
			info, statErr := os.Stat(a)
			if statErr != nil || info.IsDir() {
				return fmt.Errorf("refusing to open non-http(s), non-file target: %q", a)
			}
		}
	}
	return nil
}
