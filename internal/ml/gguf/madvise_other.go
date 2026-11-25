//go:build (unix || darwin) && !linux && !android

package gguf

func madviseSequential(_ []byte) {}
