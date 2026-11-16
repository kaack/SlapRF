package rotorhazard

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
)

const (
	DefaultPort          = 5000
	DefaultAdminUsername = "admin"
	DefaultAdminPassword = "rotorhazard"

	// Engine.IO v4 packet type prefixes
	EIOPacketOpen    byte = '0'
	EIOPacketClose   byte = '1'
	EIOPacketPing    byte = '2'
	EIOPacketPong    byte = '3'
	EIOPacketMessage byte = '4'
	EIOPacketUpgrade byte = '5'
	EIOPacketNoop    byte = '6'

	// Engine.IO v4 HTTP long-polling multi-packet separator
	EIORecordSeparator = "\x1e"

	// Socket.IO v4 packet type prefixes (inside EIO '4' message)
	SIOPacketConnect      byte = '0'
	SIOPacketDisconnect   byte = '1'
	SIOPacketEvent        byte = '2'
	SIOPacketAck          byte = '3'
	SIOPacketConnectError byte = '4'
)

// EIOOpenPayload is the JSON handshake body returned inside an Engine.IO `0{...}` packet.
type EIOOpenPayload struct {
	SID          string   `json:"sid"`
	Upgrades     []string `json:"upgrades"`
	PingInterval int      `json:"pingInterval"`
	PingTimeout  int      `json:"pingTimeout"`
	MaxPayload   int      `json:"maxPayload,omitempty"`
}

// SplitEIOPayload splits an Engine.IO HTTP polling body (supporting both EIO v4 `\x1e`-delimited
// packets and legacy EIO v3 `<charLen>:<packet>` payloads) or single WebSocket frame into individual EIO packets.
func SplitEIOPayload(raw string) []string {
	if raw == "" {
		return nil
	}
	if strings.Contains(raw, EIORecordSeparator) {
		parts := strings.Split(raw, EIORecordSeparator)
		out := make([]string, 0, len(parts))
		for _, p := range parts {
			if p != "" {
				out = append(out, p)
			}
		}
		return out
	}
	// Check for Engine.IO v3 `<len>:<packet>` framing (e.g. `96:0{"sid":...}`)
	if colon := strings.IndexByte(raw, ':'); colon > 0 && colon <= 8 {
		if _, err := strconv.Atoi(raw[:colon]); err == nil {
			var out []string
			runes := []rune(raw)
			i := 0
			for i < len(runes) {
				cIdx := -1
				for j := i; j < len(runes) && j-i <= 8; j++ {
					if runes[j] == ':' {
						cIdx = j
						break
					}
				}
				if cIdx <= i {
					break
				}
				pktLen, lErr := strconv.Atoi(string(runes[i:cIdx]))
				if lErr != nil || pktLen < 0 || cIdx+1+pktLen > len(runes) {
					return []string{raw}
				}
				if pktLen > 0 {
					out = append(out, string(runes[cIdx+1:cIdx+1+pktLen]))
				}
				i = cIdx + 1 + pktLen
			}
			if len(out) > 0 {
				return out
			}
		}
	}
	return []string{raw}
}

// JoinEIOPayload encodes one or more Engine.IO v4 packets for an HTTP polling POST/GET body.
func JoinEIOPayload(packets ...string) string {
	filtered := make([]string, 0, len(packets))
	for _, p := range packets {
		if p != "" {
			filtered = append(filtered, p)
		}
	}
	return strings.Join(filtered, EIORecordSeparator)
}

// DecodeEIOOpen parses an Engine.IO `0{...}` open packet.
func DecodeEIOOpen(pkt string) (EIOOpenPayload, error) {
	var out EIOOpenPayload
	if len(pkt) < 2 || pkt[0] != EIOPacketOpen {
		return out, errors.New("not an Engine.IO open packet")
	}
	if err := json.Unmarshal([]byte(pkt[1:]), &out); err != nil {
		return out, err
	}
	if out.SID == "" {
		return out, errors.New("missing sid in Engine.IO open packet")
	}
	return out, nil
}

// EncodeSIOEvent formats a Socket.IO v4 event as an Engine.IO message frame (`42["event"]` or `42["event",payload]`).
// Passing `hasArg == false` omits the second array element — required for zero-arg Python Flask-SocketIO handlers
// such as `on_discard_laps(**kwargs)` and `on_stop_race(*args)`.
func EncodeSIOEvent(event string, payload any, hasArg bool) (string, error) {
	if strings.TrimSpace(event) == "" {
		return "", errors.New("empty Socket.IO event name")
	}
	var buf bytes.Buffer
	buf.WriteByte(EIOPacketMessage)
	buf.WriteByte(SIOPacketEvent)
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if hasArg {
		if err := enc.Encode([]any{event, payload}); err != nil {
			return "", err
		}
	} else {
		if err := enc.Encode([]any{event}); err != nil {
			return "", err
		}
	}
	// json.Encoder appends a trailing '\n'
	s := strings.TrimRight(buf.String(), "\r\n")
	return s, nil
}

// DecodedSIOEvent represents a parsed Socket.IO event frame (`42["name", data]`).
type DecodedSIOEvent struct {
	Name    string
	RawArg  json.RawMessage
	HasArg  bool
	AckID   string
}

// DecodeSIOEvent extracts the event name and optional first JSON argument from a `42...` frame
// (or a bare `2...` Socket.IO frame after stripping the `4` EIO prefix).
func DecodeSIOEvent(frame string) (DecodedSIOEvent, error) {
	var out DecodedSIOEvent
	s := strings.TrimSpace(frame)
	if len(s) == 0 {
		return out, errors.New("empty frame")
	}
	if s[0] == EIOPacketMessage {
		s = s[1:]
	}
	if len(s) == 0 || s[0] != SIOPacketEvent {
		return out, fmt.Errorf("not a Socket.IO event packet: %q", frame)
	}
	s = s[1:]
	// Skip optional namespace `/foo,`
	if strings.HasPrefix(s, "/") {
		if comma := strings.IndexByte(s, ','); comma >= 0 {
			s = s[comma+1:]
		}
	}
	// Skip optional numeric ack ID before '['
	bracket := strings.IndexByte(s, '[')
	if bracket < 0 {
		return out, errors.New("missing JSON array in Socket.IO event")
	}
	if bracket > 0 {
		out.AckID = s[:bracket]
		s = s[bracket:]
	}
	var elems []json.RawMessage
	if err := json.Unmarshal([]byte(s), &elems); err != nil {
		return out, err
	}
	if len(elems) == 0 {
		return out, errors.New("Socket.IO event array is empty")
	}
	if err := json.Unmarshal(elems[0], &out.Name); err != nil {
		return out, err
	}
	if len(elems) > 1 {
		out.RawArg = elems[1]
		out.HasArg = true
	}
	return out, nil
}
