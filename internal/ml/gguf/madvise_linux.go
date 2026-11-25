//go:build linux || android

package gguf

import "syscall"

func madviseSequential(data []byte) {
	if len(data) > 0 {
		_ = syscall.Madvise(data, syscall.MADV_SEQUENTIAL)
	}
}
