//go:build unix || linux || darwin || android

package gguf

import (
	"fmt"
	"os"
	"syscall"
)

type mappedFile struct {
	file *os.File
	data []byte
}

func openMappedFile(path string) (*mappedFile, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	info, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return nil, err
	}
	sz := info.Size()
	if sz <= 0 {
		_ = f.Close()
		return nil, fmt.Errorf("gguf file %q is empty", path)
	}
	if int64(int(sz)) != sz {
		_ = f.Close()
		return nil, fmt.Errorf("gguf file %q (%d bytes) exceeds addressable memory", path, sz)
	}
	data, err := syscall.Mmap(int(f.Fd()), 0, int(sz), syscall.PROT_READ, syscall.MAP_SHARED)
	if err != nil {
		_ = f.Close()
		return nil, fmt.Errorf("mmap %q: %w", path, err)
	}
	return &mappedFile{file: f, data: data}, nil
}

func (m *mappedFile) Bytes() []byte {
	if m == nil {
		return nil
	}
	return m.data
}

func (m *mappedFile) Close() error {
	if m == nil {
		return nil
	}
	var firstErr error
	if m.data != nil {
		if err := syscall.Munmap(m.data); err != nil && firstErr == nil {
			firstErr = err
		}
		m.data = nil
	}
	if m.file != nil {
		if err := m.file.Close(); err != nil && firstErr == nil {
			firstErr = err
		}
		m.file = nil
	}
	return firstErr
}
