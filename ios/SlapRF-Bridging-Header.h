#ifndef SLAPRF_BRIDGING_HEADER_H
#define SLAPRF_BRIDGING_HEADER_H

#include "../cmd/slaprf-ios/cbridge.h"

#ifdef __cplusplus
extern "C" {
#endif

// Exported from cmd/slaprf-ios/main.go (libslaprf.a).
// Returned char* buffers are heap-allocated and must be freed via SlapRFFreeString().
extern char* SlapRFStartServer(char* cFilesDir, char* cVersion, int cLanEnabled);
extern void SlapRFStopServer(void);
extern char* SlapRFSetLanEnabled(int cEnabled);
extern char* SlapRFGetLanStatusJson(void);
extern void SlapRFFreeString(char* p);

#ifdef __cplusplus
}
#endif

#endif // SLAPRF_BRIDGING_HEADER_H
