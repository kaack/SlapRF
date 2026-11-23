//go:build android

#include "jni_bridge.h"
#include <stdlib.h>
#include <string.h>

static JavaVM *g_jvm = NULL;
static jclass g_shim_cls = NULL;

static jmethodID g_mid_clock_ns = NULL;
static jmethodID g_mid_status = NULL;
static jmethodID g_mid_configure = NULL;
static jmethodID g_mid_focus = NULL;
static jmethodID g_mid_preview_jpg = NULL;
static jmethodID g_mid_analyze = NULL;
static jmethodID g_mid_burst_jpg = NULL;
static jmethodID g_mid_release_burst = NULL;

static JNIEnv* get_env(void) {
    if (!g_jvm) return NULL;
    JNIEnv *env = NULL;
    jint rc = (*g_jvm)->GetEnv(g_jvm, (void**)&env, JNI_VERSION_1_6);
    if (rc == JNI_OK) return env;
    if (rc == JNI_EDETACHED) {
        if ((*g_jvm)->AttachCurrentThreadAsDaemon(g_jvm, &env, NULL) == JNI_OK) {
            return env;
        }
    }
    return NULL;
}

static int clear_exc(JNIEnv *env) {
    if ((*env)->ExceptionCheck(env)) {
        (*env)->ExceptionClear(env);
        return 1;
    }
    return 0;
}

static char* jstr_dup(JNIEnv *env, jstring s) {
    if (!s) return NULL;
    const char *utf = (*env)->GetStringUTFChars(env, s, NULL);
    if (!utf) {
        clear_exc(env);
        (*env)->DeleteLocalRef(env, s);
        return NULL;
    }
    char *cp = strdup(utf);
    (*env)->ReleaseStringUTFChars(env, s, utf);
    (*env)->DeleteLocalRef(env, s);
    return cp;
}

static uint8_t* jbytes_dup(JNIEnv *env, jbyteArray arr, int *out_len) {
    if (out_len) *out_len = 0;
    if (!arr) return NULL;
    jsize n = (*env)->GetArrayLength(env, arr);
    if (n <= 0) {
        (*env)->DeleteLocalRef(env, arr);
        return NULL;
    }
    uint8_t *buf = (uint8_t*)malloc((size_t)n);
    if (!buf) {
        (*env)->DeleteLocalRef(env, arr);
        return NULL;
    }
    (*env)->GetByteArrayRegion(env, arr, 0, n, (jbyte*)buf);
    clear_exc(env);
    (*env)->DeleteLocalRef(env, arr);
    if (out_len) *out_len = (int)n;
    return buf;
}

JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM *vm, void *reserved) {
    (void)reserved;
    g_jvm = vm;
    JNIEnv *env = NULL;
    if ((*vm)->GetEnv(vm, (void**)&env, JNI_VERSION_1_6) != JNI_OK || !env) {
        return JNI_ERR;
    }
    jclass local = (*env)->FindClass(env, "app/slaprf/gatecam/GateCamShim");
    if (!local || clear_exc(env)) return JNI_ERR;
    g_shim_cls = (jclass)(*env)->NewGlobalRef(env, local);
    (*env)->DeleteLocalRef(env, local);
    if (!g_shim_cls) return JNI_ERR;

    g_mid_clock_ns      = (*env)->GetStaticMethodID(env, g_shim_cls, "currentSensorClockNs", "()J");
    g_mid_status        = (*env)->GetStaticMethodID(env, g_shim_cls, "statusJson", "()Ljava/lang/String;");
    g_mid_configure     = (*env)->GetStaticMethodID(env, g_shim_cls, "configureJson", "(Ljava/lang/String;)Ljava/lang/String;");
    g_mid_focus         = (*env)->GetStaticMethodID(env, g_shim_cls, "triggerFocusLock", "(DD)Ljava/lang/String;");
    g_mid_preview_jpg   = (*env)->GetStaticMethodID(env, g_shim_cls, "latestPreviewJpeg", "()[B");
    g_mid_analyze       = (*env)->GetStaticMethodID(env, g_shim_cls, "extractAndAnalyzeJson", "(Ljava/lang/String;)Ljava/lang/String;");
    g_mid_burst_jpg     = (*env)->GetStaticMethodID(env, g_shim_cls, "getBurstFrameJpeg", "(IIZ)[B");
    g_mid_release_burst = (*env)->GetStaticMethodID(env, g_shim_cls, "releaseBurst", "(I)V");

    if (clear_exc(env) || !g_mid_clock_ns || !g_mid_status || !g_mid_configure ||
        !g_mid_focus || !g_mid_preview_jpg || !g_mid_analyze || !g_mid_burst_jpg || !g_mid_release_burst) {
        return JNI_ERR;
    }
    return JNI_VERSION_1_6;
}

int64_t gatecam_current_sensor_clock_ns(void) {
    JNIEnv *env = get_env();
    if (!env || !g_shim_cls) return 0;
    jlong v = (*env)->CallStaticLongMethod(env, g_shim_cls, g_mid_clock_ns);
    clear_exc(env);
    return (int64_t)v;
}

char* gatecam_status_json(void) {
    JNIEnv *env = get_env();
    if (!env || !g_shim_cls) return NULL;
    jstring s = (jstring)(*env)->CallStaticObjectMethod(env, g_shim_cls, g_mid_status);
    if (clear_exc(env)) return NULL;
    return jstr_dup(env, s);
}

char* gatecam_configure_json(const char *cfg_json) {
    JNIEnv *env = get_env();
    if (!env || !g_shim_cls) return NULL;
    jstring arg = (*env)->NewStringUTF(env, cfg_json ? cfg_json : "{}");
    jstring s = (jstring)(*env)->CallStaticObjectMethod(env, g_shim_cls, g_mid_configure, arg);
    if (arg) (*env)->DeleteLocalRef(env, arg);
    if (clear_exc(env)) return NULL;
    return jstr_dup(env, s);
}

char* gatecam_trigger_focus_lock(double norm_x, double norm_y) {
    JNIEnv *env = get_env();
    if (!env || !g_shim_cls) return NULL;
    jstring s = (jstring)(*env)->CallStaticObjectMethod(env, g_shim_cls, g_mid_focus, (jdouble)norm_x, (jdouble)norm_y);
    if (clear_exc(env)) return NULL;
    return jstr_dup(env, s);
}

uint8_t* gatecam_latest_preview_jpeg(int *out_len) {
    JNIEnv *env = get_env();
    if (!env || !g_shim_cls) return NULL;
    jbyteArray arr = (jbyteArray)(*env)->CallStaticObjectMethod(env, g_shim_cls, g_mid_preview_jpg);
    if (clear_exc(env)) return NULL;
    return jbytes_dup(env, arr, out_len);
}

char* gatecam_extract_and_analyze_json(const char *req_json) {
    JNIEnv *env = get_env();
    if (!env || !g_shim_cls) return NULL;
    jstring arg = (*env)->NewStringUTF(env, req_json ? req_json : "{}");
    jstring s = (jstring)(*env)->CallStaticObjectMethod(env, g_shim_cls, g_mid_analyze, arg);
    if (arg) (*env)->DeleteLocalRef(env, arg);
    if (clear_exc(env)) return NULL;
    return jstr_dup(env, s);
}

uint8_t* gatecam_get_burst_jpeg(int burst_id, int frame_idx, int is_mask, int *out_len) {
    JNIEnv *env = get_env();
    if (!env || !g_shim_cls) return NULL;
    jbyteArray arr = (jbyteArray)(*env)->CallStaticObjectMethod(env, g_shim_cls, g_mid_burst_jpg,
        (jint)burst_id, (jint)frame_idx, is_mask ? JNI_TRUE : JNI_FALSE);
    if (clear_exc(env)) return NULL;
    return jbytes_dup(env, arr, out_len);
}

void gatecam_release_burst(int burst_id) {
    JNIEnv *env = get_env();
    if (!env || !g_shim_cls) return;
    (*env)->CallStaticVoidMethod(env, g_shim_cls, g_mid_release_burst, (jint)burst_id);
    clear_exc(env);
}
