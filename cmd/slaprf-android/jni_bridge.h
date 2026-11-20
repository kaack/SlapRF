#ifndef SLAPRF_JNI_BRIDGE_H
#define SLAPRF_JNI_BRIDGE_H

#include <jni.h>
#include <stdint.h>

// Initializes cached class/method references when libslaprf.so is loaded.
JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM *vm, void *reserved);

// Reusable global byte[] buffer helpers (one pair per open serial port).
uintptr_t slaprf_jni_alloc_buf(int size);
void slaprf_jni_free_buf(uintptr_t global_ref);

// Calls into app.slaprf.SlapRFUsbShim static methods.
// Returned char* strings are heap-allocated via malloc/strdup and must be freed by Go (C.free).
char* slaprf_usb_list_ports_json(void);
int slaprf_usb_open_port(const char *port_name, int baud_rate, char **err_out);
int slaprf_usb_read_port(int handle, uintptr_t rx_buf_ref, void *out_ptr, int max_len, int timeout_ms);
int slaprf_usb_write_port(int handle, uintptr_t tx_buf_ref, const void *data_ptr, int len);
int slaprf_usb_set_dtr_rts(int handle, int dtr, int rts);
void slaprf_usb_close_port(int handle);

// Calls into app.slaprf.SlapRFBleShim static methods (Bluetooth Hub link, `ble:<FP>` ports).
int slaprf_ble_available(void);
char* slaprf_ble_list_ports_json(void);
int slaprf_ble_open_port(const char *port_name, int baud_rate, char **err_out);
int slaprf_ble_read_port(int handle, uintptr_t rx_buf_ref, void *out_ptr, int max_len, int timeout_ms);
int slaprf_ble_write_port(int handle, uintptr_t tx_buf_ref, const void *data_ptr, int len);
void slaprf_ble_close_port(int handle);

static inline const char* slaprf_jstr_get(JNIEnv *env, jstring s) {
    if (!env || !s) return NULL;
    return (*env)->GetStringUTFChars(env, s, NULL);
}

static inline void slaprf_jstr_rel(JNIEnv *env, jstring s, const char *c) {
    if (env && s && c) (*env)->ReleaseStringUTFChars(env, s, c);
}

static inline jstring slaprf_jstr_new(JNIEnv *env, const char *c) {
    if (!env) return NULL;
    return (*env)->NewStringUTF(env, c ? c : "");
}

#endif // SLAPRF_JNI_BRIDGE_H
