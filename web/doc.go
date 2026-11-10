// Package webassets is the browser app's source tree (index.html, styles/, src/, wasm/,
// firmware/). It contains no Go code; it exists so the directory stays an importable package
// for tests that reference it. The app is built by cmd/build-web and served in development
// by cmd/devserver.
package webassets
