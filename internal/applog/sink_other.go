//go:build !android

package applog

const platformUsesNativeSink = false

func writePlatformSink(_ Level, _ string) {}
