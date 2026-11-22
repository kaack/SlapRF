//go:build linux && !android && !nobluetooth

package bluetooth

import (
	"os"
	"path/filepath"
	"testing"
)

func TestPickBlueZAdapterName(t *testing.T) {
	tests := []struct {
		name       string
		candidates []bluezAdapterCandidate
		want       string
	}{
		{
			name:       "empty",
			candidates: nil,
			want:       "",
		},
		{
			name: "single hci1",
			candidates: []bluezAdapterCandidate{
				{name: "hci1", powered: true},
			},
			want: "hci1",
		},
		{
			name: "prefers powered over lower unpowered index",
			candidates: []bluezAdapterCandidate{
				{name: "hci0", powered: false},
				{name: "hci1", powered: true},
			},
			want: "hci1",
		},
		{
			name: "natural numeric order across hci2 and hci10",
			candidates: []bluezAdapterCandidate{
				{name: "hci10", powered: true},
				{name: "hci2", powered: true},
			},
			want: "hci2",
		},
		{
			name: "falls back to lowest index when none powered",
			candidates: []bluezAdapterCandidate{
				{name: "hci2", powered: false},
				{name: "hci1", powered: false},
			},
			want: "hci1",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := pickBlueZAdapterName(tc.candidates); got != tc.want {
				t.Fatalf("pickBlueZAdapterName(%+v) = %q, want %q", tc.candidates, got, tc.want)
			}
		})
	}
}

func TestListBlueZAdaptersSysfs(t *testing.T) {
	dir := t.TempDir()
	for _, entry := range []string{"hci2", "hci10", "hci1", "not-hci"} {
		if err := os.Mkdir(filepath.Join(dir, entry), 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", entry, err)
		}
	}
	got := pickBlueZAdapterName(listBlueZAdaptersSysfs(dir))
	if got != "hci1" {
		t.Fatalf("sysfs pick = %q, want %q", got, "hci1")
	}
}
