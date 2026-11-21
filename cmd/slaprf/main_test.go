package main

import (
	"reflect"
	"testing"
)

func TestIsHeadlessLinuxEnv(t *testing.T) {
	tests := []struct {
		name           string
		goos           string
		display        string
		waylandDisplay string
		want           bool
	}{
		{name: "headless linux ssh", goos: "linux", display: "", waylandDisplay: "", want: true},
		{name: "desktop x11", goos: "linux", display: ":0", waylandDisplay: "", want: false},
		{name: "desktop wayland", goos: "linux", display: "", waylandDisplay: "wayland-0", want: false},
		{name: "macos empty env", goos: "darwin", display: "", waylandDisplay: "", want: false},
		{name: "windows empty env", goos: "windows", display: "", waylandDisplay: "", want: false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := isHeadlessLinuxEnv(tc.goos, tc.display, tc.waylandDisplay); got != tc.want {
				t.Fatalf("isHeadlessLinuxEnv(%q, %q, %q) = %v, want %v", tc.goos, tc.display, tc.waylandDisplay, got, tc.want)
			}
		})
	}
}

func TestFormatLANURLs(t *testing.T) {
	got := formatLANURLs("raspberrypi.local", []string{"10.0.0.59"}, "8090")
	want := []string{"http://raspberrypi.local:8090", "http://10.0.0.59:8090"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("formatLANURLs = %v, want %v", got, want)
	}
}
