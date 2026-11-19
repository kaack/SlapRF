//go:build android

#include "jni_bridge.h"
#include <stdlib.h>
#include <string.h>

static JavaVM *g_jvm = NULL;
static jclass g_usb_shim_cls = NULL;

static jmethodID g_mid_list_ports = NULL;
static jmethodID g_mid_open_port = NULL;
static jmethodID g_mid_last_open_err = NULL;
static jmethodID g_mid_read_port = NULL;
static jmethodID g_mid_write_port = NULL;
static jmethodID g_mid_set_dtr_rts = NULL;
static jmethodID g_mid_close_port = NULL;

static JNIEnv* get_env(void) {
    if (g_jvm == NULL) {
        return NULL;
    }
    JNIEnv *env = NULL;
    jint rc = (*g_jvm)->GetEnv(g_jvm, (void**)&env, JNI_VERSION_1_6);
    if (rc == JNI_OK) {
        return env;
    }
    if (rc == JNI_EDETACHED) {
        if ((*g_jvm)->AttachCurrentThreadAsDaemon(g_jvm, &env, NULL) == JNI_OK) {
            return env;
        }
    }
    return NULL;
}

static int clear_exception_if_any(JNIEnv *env) {
    if ((*env)->ExceptionCheck(env)) {
        (*env)->ExceptionClear(env);
        return 1;
    }
    return 0;
}

static char* jstring_to_cstr(JNIEnv *env, jstring jstr) {
    if (jstr == NULL) {
        return NULL;
    }
    const char *utf = (*env)->GetStringUTFChars(env, jstr, NULL);
    if (utf == NULL) {
        clear_exception_if_any(env);
        return NULL;
    }
    char *copy = strdup(utf);
    (*env)->ReleaseStringUTFChars(env, jstr, utf);
    return copy;
}

JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM *vm, void *reserved) {
    (void)reserved;
    g_jvm = vm;
    JNIEnv *env = NULL;
    if ((*vm)->GetEnv(vm, (void**)&env, JNI_VERSION_1_6) != JNI_OK || env == NULL) {
        return JNI_ERR;
    }

    jclass local_cls = (*env)->FindClass(env, "app/slaprf/SlapRFUsbShim");
    if (local_cls == NULL || clear_exception_if_any(env)) {
        return JNI_ERR;
    }
    g_usb_shim_cls = (jclass)(*env)->NewGlobalRef(env, local_cls);
    (*env)->DeleteLocalRef(env, local_cls);
    if (g_usb_shim_cls == NULL) {
        return JNI_ERR;
    }

    g_mid_list_ports    = (*env)->GetStaticMethodID(env, g_usb_shim_cls, "listPortsJson", "()Ljava/lang/String;");
    g_mid_open_port     = (*env)->GetStaticMethodID(env, g_usb_shim_cls, "openPort", "(Ljava/lang/String;I)I");
    g_mid_last_open_err = (*env)->GetStaticMethodID(env, g_usb_shim_cls, "getLastOpenError", "()Ljava/lang/String;");
    g_mid_read_port     = (*env)->GetStaticMethodID(env, g_usb_shim_cls, "readPort", "(I[BII)I");
    g_mid_write_port    = (*env)->GetStaticMethodID(env, g_usb_shim_cls, "writePort", "(I[BI)I");
    g_mid_set_dtr_rts   = (*env)->GetStaticMethodID(env, g_usb_shim_cls, "setDtrRts", "(IZZ)I");
    g_mid_close_port    = (*env)->GetStaticMethodID(env, g_usb_shim_cls, "closePort", "(I)V");

    if (clear_exception_if_any(env) ||
        !g_mid_list_ports || !g_mid_open_port || !g_mid_last_open_err ||
        !g_mid_read_port || !g_mid_write_port || !g_mid_set_dtr_rts || !g_mid_close_port) {
        return JNI_ERR;
    }

    return JNI_VERSION_1_6;
}

uintptr_t slaprf_jni_alloc_buf(int size) {
    JNIEnv *env = get_env();
    if (!env || size <= 0) {
        return 0;
    }
    jbyteArray local_arr = (*env)->NewByteArray(env, (jsize)size);
    if (local_arr == NULL || clear_exception_if_any(env)) {
        return 0;
    }
    jobject global_ref = (*env)->NewGlobalRef(env, local_arr);
    (*env)->DeleteLocalRef(env, local_arr);
    return (uintptr_t)global_ref;
}

void slaprf_jni_free_buf(uintptr_t global_ref) {
    if (global_ref == 0) {
        return;
    }
    JNIEnv *env = get_env();
    if (!env) {
        return;
    }
    (*env)->DeleteGlobalRef(env, (jobject)global_ref);
}

char* slaprf_usb_list_ports_json(void) {
    JNIEnv *env = get_env();
    if (!env || !g_usb_shim_cls || !g_mid_list_ports) {
        return strdup("[]");
    }
    jstring jres = (jstring)(*env)->CallStaticObjectMethod(env, g_usb_shim_cls, g_mid_list_ports);
    if (clear_exception_if_any(env) || jres == NULL) {
        return strdup("[]");
    }
    char *out = jstring_to_cstr(env, jres);
    (*env)->DeleteLocalRef(env, jres);
    return out ? out : strdup("[]");
}

int slaprf_usb_open_port(const char *port_name, int baud_rate, char **err_out) {
    if (err_out) {
        *err_out = NULL;
    }
    JNIEnv *env = get_env();
    if (!env || !g_usb_shim_cls || !g_mid_open_port) {
        if (err_out) *err_out = strdup("Android USB JNI bridge not initialized");
        return -1;
    }
    jstring jname = (*env)->NewStringUTF(env, port_name ? port_name : "");
    if (jname == NULL || clear_exception_if_any(env)) {
        if (err_out) *err_out = strdup("failed to allocate JNI port name");
        return -1;
    }
    jint handle = (*env)->CallStaticIntMethod(env, g_usb_shim_cls, g_mid_open_port, jname, (jint)baud_rate);
    (*env)->DeleteLocalRef(env, jname);
    if (clear_exception_if_any(env)) {
        if (err_out) *err_out = strdup("exception in SlapRFUsbShim.openPort");
        return -1;
    }
    if (handle <= 0 && err_out && g_mid_last_open_err) {
        jstring jerr = (jstring)(*env)->CallStaticObjectMethod(env, g_usb_shim_cls, g_mid_last_open_err);
        if (!clear_exception_if_any(env) && jerr != NULL) {
            *err_out = jstring_to_cstr(env, jerr);
            (*env)->DeleteLocalRef(env, jerr);
        }
    }
    return (int)handle;
}

int slaprf_usb_read_port(int handle, uintptr_t rx_buf_ref, void *out_ptr, int max_len, int timeout_ms) {
    if (handle <= 0 || rx_buf_ref == 0 || out_ptr == NULL || max_len <= 0) {
        return -1;
    }
    JNIEnv *env = get_env();
    if (!env || !g_usb_shim_cls || !g_mid_read_port) {
        return -1;
    }
    jbyteArray jbuf = (jbyteArray)rx_buf_ref;
    jint n = (*env)->CallStaticIntMethod(env, g_usb_shim_cls, g_mid_read_port, (jint)handle, jbuf, (jint)max_len, (jint)timeout_ms);
    if (clear_exception_if_any(env)) {
        return -1;
    }
    if (n > 0) {
        if (n > max_len) {
            n = max_len;
        }
        (*env)->GetByteArrayRegion(env, jbuf, 0, n, (jbyte*)out_ptr);
        if (clear_exception_if_any(env)) {
            return -1;
        }
    }
    return (int)n;
}

int slaprf_usb_write_port(int handle, uintptr_t tx_buf_ref, const void *data_ptr, int len) {
    if (handle <= 0 || tx_buf_ref == 0 || data_ptr == NULL || len <= 0) {
        return -1;
    }
    JNIEnv *env = get_env();
    if (!env || !g_usb_shim_cls || !g_mid_write_port) {
        return -1;
    }
    jbyteArray jbuf = (jbyteArray)tx_buf_ref;
    (*env)->SetByteArrayRegion(env, jbuf, 0, (jsize)len, (const jbyte*)data_ptr);
    if (clear_exception_if_any(env)) {
        return -1;
    }
    jint written = (*env)->CallStaticIntMethod(env, g_usb_shim_cls, g_mid_write_port, (jint)handle, jbuf, (jint)len);
    if (clear_exception_if_any(env)) {
        return -1;
    }
    return (int)written;
}

int slaprf_usb_set_dtr_rts(int handle, int dtr, int rts) {
    if (handle <= 0) {
        return -1;
    }
    JNIEnv *env = get_env();
    if (!env || !g_usb_shim_cls || !g_mid_set_dtr_rts) {
        return -1;
    }
    jint rc = (*env)->CallStaticIntMethod(
        env,
        g_usb_shim_cls,
        g_mid_set_dtr_rts,
        (jint)handle,
        dtr ? JNI_TRUE : JNI_FALSE,
        rts ? JNI_TRUE : JNI_FALSE
    );
    if (clear_exception_if_any(env)) {
        return -1;
    }
    return (int)rc;
}

void slaprf_usb_close_port(int handle) {
    if (handle <= 0) {
        return;
    }
    JNIEnv *env = get_env();
    if (!env || !g_usb_shim_cls || !g_mid_close_port) {
        return;
    }
    (*env)->CallStaticVoidMethod(env, g_usb_shim_cls, g_mid_close_port, (jint)handle);
    clear_exception_if_any(env);
}
