//go:build android

package applog

/*
#cgo android LDFLAGS: -llog
#include <android/log.h>
#include <stdlib.h>

static void slaprf_android_log(int prio, const char *msg) {
    __android_log_write(prio, "SlapRFGo", msg);
}
*/
import "C"
import "unsafe"

const platformUsesNativeSink = true

func writePlatformSink(level Level, line string) {
	prio := C.int(C.ANDROID_LOG_INFO)
	switch level {
	case LevelTrace:
		prio = C.ANDROID_LOG_VERBOSE
	case LevelDebug:
		prio = C.ANDROID_LOG_DEBUG
	case LevelInfo:
		prio = C.ANDROID_LOG_INFO
	case LevelWarn:
		prio = C.ANDROID_LOG_WARN
	case LevelError:
		prio = C.ANDROID_LOG_ERROR
	}
	cs := C.CString(line)
	C.slaprf_android_log(prio, cs)
	C.free(unsafe.Pointer(cs))
}
