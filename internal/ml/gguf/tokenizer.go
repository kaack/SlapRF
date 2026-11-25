package gguf

import (
	"fmt"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"
)

type mergePair struct {
	a string
	b string
}

// Tokenizer implements GPT-2 / Qwen2 byte-level BPE encoding from GGUF metadata.
type Tokenizer struct {
	Tokens      []string
	vocabToID   map[string]int
	mergesRank  map[mergePair]int
	specials    []string
	specialToID map[string]int
	byteToRune  [256]rune
	EOSTokenID  int
}

// NewTokenizer builds a Qwen2/GPT-2 byte-level BPE tokenizer from parsed GGUF `Metadata`.
func NewTokenizer(meta map[string]any) (*Tokenizer, error) {
	tokens := metaStringSlice(meta, "tokenizer.ggml.tokens")
	if len(tokens) == 0 {
		return nil, fmt.Errorf("missing tokenizer.ggml.tokens in GGUF metadata")
	}
	merges := metaStringSlice(meta, "tokenizer.ggml.merges")
	var tokenTypes []int32
	if tt, ok := meta["tokenizer.ggml.token_type"].([]int32); ok {
		tokenTypes = tt
	}

	vocab := make(map[string]int, len(tokens))
	specialToID := make(map[string]int)
	var specials []string
	for id, tok := range tokens {
		if _, exists := vocab[tok]; !exists {
			vocab[tok] = id
		}
		isSpecial := false
		if id < len(tokenTypes) && (tokenTypes[id] == 3 || tokenTypes[id] == 4) {
			isSpecial = true
		} else if strings.HasPrefix(tok, "<|") && strings.HasSuffix(tok, "|>") {
			isSpecial = true
		} else if tok == "<think>" || tok == "</think>" {
			isSpecial = true
		}
		if isSpecial && len(tok) >= 3 {
			specialToID[tok] = id
			specials = append(specials, tok)
		}
	}
	// Match longer special tokens first (e.g. `<|im_start|>` before prefixes).
	sort.Slice(specials, func(i, j int) bool {
		return len(specials[i]) > len(specials[j])
	})

	ranks := make(map[mergePair]int, len(merges))
	for rank, line := range merges {
		sp := strings.IndexByte(line, ' ')
		if sp <= 0 || sp+1 >= len(line) {
			continue
		}
		p := mergePair{a: line[:sp], b: line[sp+1:]}
		if _, exists := ranks[p]; !exists {
			ranks[p] = rank
		}
	}

	eos := 0
	if v, ok := metaUint64(meta, "tokenizer.ggml.eos_token_id"); ok {
		eos = int(v)
	}

	t := &Tokenizer{
		Tokens:      tokens,
		vocabToID:   vocab,
		mergesRank:  ranks,
		specials:    specials,
		specialToID: specialToID,
		EOSTokenID:  eos,
	}
	t.initByteTable()
	return t, nil
}

func (t *Tokenizer) initByteTable() {
	var used [256]bool
	for b := 33; b <= 126; b++ {
		t.byteToRune[b] = rune(b)
		used[b] = true
	}
	for b := 161; b <= 172; b++ {
		t.byteToRune[b] = rune(b)
		used[b] = true
	}
	for b := 174; b <= 255; b++ {
		t.byteToRune[b] = rune(b)
		used[b] = true
	}
	extra := 0
	for b := 0; b < 256; b++ {
		if !used[b] {
			t.byteToRune[b] = rune(256 + extra)
			extra++
		}
	}
}

// TokenID looks up the exact vocabulary ID for a raw GGUF token string (e.g. `"Ġcrossing"`).
func (t *Tokenizer) TokenID(rawToken string) (int, bool) {
	id, ok := t.vocabToID[rawToken]
	return id, ok
}

// Encode converts UTF-8 `text` (including special tags like `<|im_start|>`, `<think>`, `</think>`) into token IDs.
func (t *Tokenizer) Encode(text string) []int {
	if text == "" {
		return nil
	}
	var out []int
	rem := text
	for len(rem) > 0 {
		bestIdx := -1
		bestSpec := ""
		bestID := 0
		for _, sp := range t.specials {
			idx := strings.Index(rem, sp)
			if idx >= 0 && (bestIdx < 0 || idx < bestIdx) {
				bestIdx = idx
				bestSpec = sp
				bestID = t.specialToID[sp]
				if idx == 0 {
					break
				}
			}
		}
		if bestIdx < 0 {
			out = t.encodePlainInto(out, rem)
			break
		}
		if bestIdx > 0 {
			out = t.encodePlainInto(out, rem[:bestIdx])
		}
		out = append(out, bestID)
		rem = rem[bestIdx+len(bestSpec):]
	}
	return out
}

func (t *Tokenizer) encodePlainInto(dst []int, s string) []int {
	chunks := pretokenizeQwen2(s)
	for _, ch := range chunks {
		dst = t.encodeChunkBPE(dst, ch)
	}
	return dst
}

// pretokenizeQwen2 splits text into GPT-2/Qwen2 pre-tokens: single digits (`0-9`), optional-space + letters,
// optional-space + punctuation, and newline/whitespace runs.
func pretokenizeQwen2(s string) []string {
	var chunks []string
	i := 0
	for i < len(s) {
		r, w := utf8.DecodeRuneInString(s[i:])
		// Single ASCII or Unicode digit is always isolated in Qwen2/Qwen3
		if unicode.IsNumber(r) {
			chunks = append(chunks, s[i:i+w])
			i += w
			continue
		}
		// Newline sequence `\r?\n+`
		if r == '\r' || r == '\n' {
			start := i
			for i < len(s) {
				rn, wn := utf8.DecodeRuneInString(s[i:])
				if rn != '\r' && rn != '\n' {
					break
				}
				i += wn
			}
			chunks = append(chunks, s[start:i])
			continue
		}
		// Optional single leading space attached to letters or punctuation
		if r == ' ' && i+1 < len(s) {
			rNext, wNext := utf8.DecodeRuneInString(s[i+1:])
			if unicode.IsLetter(rNext) {
				start := i
				i += 1 + wNext
				for i < len(s) {
					rn, wn := utf8.DecodeRuneInString(s[i:])
					if !unicode.IsLetter(rn) {
						break
					}
					i += wn
				}
				chunks = append(chunks, s[start:i])
				continue
			}
			if !unicode.IsSpace(rNext) && !unicode.IsNumber(rNext) {
				start := i
				i += 1 + wNext
				for i < len(s) {
					rn, wn := utf8.DecodeRuneInString(s[i:])
					if unicode.IsSpace(rn) || unicode.IsLetter(rn) || unicode.IsNumber(rn) {
						break
					}
					i += wn
				}
				chunks = append(chunks, s[start:i])
				continue
			}
		}
		if unicode.IsLetter(r) {
			start := i
			i += w
			for i < len(s) {
				rn, wn := utf8.DecodeRuneInString(s[i:])
				if !unicode.IsLetter(rn) {
					break
				}
				i += wn
			}
			chunks = append(chunks, s[start:i])
			continue
		}
		if unicode.IsSpace(r) {
			start := i
			i += w
			for i < len(s) {
				rn, wn := utf8.DecodeRuneInString(s[i:])
				if !unicode.IsSpace(rn) || rn == '\r' || rn == '\n' {
					break
				}
				// Stop before the last space if followed by a letter/punct so ` word` attaches cleanly
				if rn == ' ' && i+1 < len(s) {
					r2, _ := utf8.DecodeRuneInString(s[i+1:])
					if !unicode.IsSpace(r2) && !unicode.IsNumber(r2) {
						break
					}
				}
				i += wn
			}
			chunks = append(chunks, s[start:i])
			continue
		}
		// Punctuation / symbols run
		start := i
		i += w
		for i < len(s) {
			rn, wn := utf8.DecodeRuneInString(s[i:])
			if unicode.IsSpace(rn) || unicode.IsLetter(rn) || unicode.IsNumber(rn) {
				break
			}
			i += wn
		}
		chunks = append(chunks, s[start:i])
	}
	return chunks
}

func (t *Tokenizer) encodeChunkBPE(dst []int, chunk string) []int {
	if len(chunk) == 0 {
		return dst
	}
	var sb strings.Builder
	sb.Grow(len(chunk) * 2)
	for i := 0; i < len(chunk); i++ {
		sb.WriteRune(t.byteToRune[chunk[i]])
	}
	mapped := sb.String()
	if id, ok := t.vocabToID[mapped]; ok {
		return append(dst, id)
	}

	parts := make([]string, 0, len(chunk))
	for _, r := range mapped {
		parts = append(parts, string(r))
	}

	for len(parts) > 1 && len(t.mergesRank) > 0 {
		bestRank := int(^uint(0) >> 1)
		bestIdx := -1
		for i := 0; i < len(parts)-1; i++ {
			if rank, ok := t.mergesRank[mergePair{a: parts[i], b: parts[i+1]}]; ok && rank < bestRank {
				bestRank = rank
				bestIdx = i
			}
		}
		if bestIdx < 0 {
			break
		}
		parts[bestIdx] = parts[bestIdx] + parts[bestIdx+1]
		parts = append(parts[:bestIdx+1], parts[bestIdx+2:]...)
	}

	for _, p := range parts {
		if id, ok := t.vocabToID[p]; ok {
			dst = append(dst, id)
		}
	}
	return dst
}
