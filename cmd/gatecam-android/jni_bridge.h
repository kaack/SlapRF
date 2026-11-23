#ifndef GATECAM_JNI_BRIDGE_H
#define GATECAM_JNI_BRIDGE_H

#include <jni.h>
#include <stdint.h>

JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM *vm, void *reserved);

int64_t gatecam_current_sensor_clock_ns(void);
char* gatecam_status_json(void);
char* gatecam_configure_json(const char *cfg_json);
char* gatecam_trigger_focus_lock(double norm_x, double norm_y);
uint8_t* gatecam_latest_preview_jpeg(int *out_len);
char* gatecam_extract_and_analyze_json(const char *req_json);
uint8_t* gatecam_get_burst_jpeg(int burst_id, int frame_idx, int is_mask, int *out_len);
void gatecam_release_burst(int burst_id);

static inline const char* gatecam_jstr_get(JNIEnv *env, jstring s) {
    if (!env || !s) return NULL;
    return (*env)->GetStringUTFChars(env, s, NULL);
}

static inline void gatecam_jstr_rel(JNIEnv *env, jstring s, const char *c) {
    if (env && s && c) (*env)->ReleaseStringUTFChars(env, s, c);
}

static inline jstring gatecam_jstr_new(JNIEnv *env, const char *c) {
    if (!env) return NULL;
    return (*env)->NewStringUTF(env, c ? c : "");
}

#endif // GATECAM_JNI_BRIDGE_H
