//go:build !unix && !linux && !darwin && !android

package gguf

import (
	"fmt"
	"os"
)

type mappedFile struct {
	data []byte
}

func openMappedFile(path string) (*mappedFile, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if len(data) == 0 {
		return nil, fmt.Errorf("gguf file %q is empty", path)
	}
	return &mappedFile{data: data}, nil
}

func (m *mappedFile) Bytes() []byte {
	if m == nil {
		return nil
	}
	return m.data
}

func (m *mappedFile) Close() error {
	if m != nil {
		m.data = nil
	}
	return nil
}
