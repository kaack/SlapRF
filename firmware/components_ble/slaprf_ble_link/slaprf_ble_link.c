/**
 * slaprf_ble_link: NimBLE peripheral + byte-stream transport for the SlapRF Bluetooth Hub image.
 * See include/slaprf_ble_link.h and docs/ble-hub-protocol.md.
 */
#include "slaprf_ble_link.h"

#include <math.h>
#include <stdio.h>
#include <string.h>

#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/stream_buffer.h"
#include "freertos/task.h"
#include "host/ble_hs.h"
#include "host/util/util.h"
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "services/gap/ble_svc_gap.h"
#include "services/gatt/ble_svc_gatt.h"

static const char *TAG = "slaprf_ble";

#define TX_BUFFER_BYTES   6144
#define RX_BUFFER_BYTES   512
#define MAX_NOTIFY_BYTES  244 // ATT MTU 247 - 3
#define MIN_NOTIFY_BYTES  20  // Default ATT MTU 23 - 3
#define PHASE_SAMPLES     48
#define SYNC_EVAL_CALLS   5   // Evaluate the phase every 5 superframes (100 ms at 20 ms)

/* Preferred connection intervals in 1.25 ms units: 10 ms, then 20 ms, then 30 ms. Every one is a
 * multiple of the 10 ms sweep period, so connection events can be parked in the gap between sweeps. */
static const uint16_t k_itvl_pref[] = {8, 16, 24};

/* 5d1a0001-5a7e-4c0b-9e5f-534c41505246 (little-endian byte order for NimBLE). */
static const ble_uuid128_t s_svc_uuid = BLE_UUID128_INIT(0x46, 0x52, 0x50, 0x41, 0x4c, 0x53, 0x5f, 0x9e, 0x0b, 0x4c,
                                                         0x7e, 0x5a, 0x01, 0x00, 0x1a, 0x5d);
static const ble_uuid128_t s_rx_uuid = BLE_UUID128_INIT(0x46, 0x52, 0x50, 0x41, 0x4c, 0x53, 0x5f, 0x9e, 0x0b, 0x4c,
                                                        0x7e, 0x5a, 0x02, 0x00, 0x1a, 0x5d);
static const ble_uuid128_t s_tx_uuid = BLE_UUID128_INIT(0x46, 0x52, 0x50, 0x41, 0x4c, 0x53, 0x5f, 0x9e, 0x0b, 0x4c,
                                                        0x7e, 0x5a, 0x03, 0x00, 0x1a, 0x5d);

static uint16_t s_tx_handle;
static uint8_t s_own_addr_type;
static volatile uint16_t s_conn = BLE_HS_CONN_HANDLE_NONE;
static volatile int64_t s_conn_since_us;
static volatile bool s_subscribed;
static volatile uint16_t s_mtu = 23;
static volatile uint8_t s_phy = 1;
static volatile uint32_t s_itvl_us;
static volatile int8_t s_rssi;
static uint8_t s_itvl_try; // Index into k_itvl_pref of the last request
static int64_t s_itvl_req_us;

static StreamBufferHandle_t s_tx_sb;
static StreamBufferHandle_t s_rx_sb;
static SemaphoreHandle_t s_tx_mutex;
static slaprf_ble_rx_cb_t s_on_rx;
static slaprf_ble_event_cb_t s_on_event;

static char s_name[30];
static uint8_t s_mfg[13];
static volatile bool s_adv_paired;
static volatile bool s_synced;

static volatile uint32_t s_tx_notifies, s_tx_bytes, s_tx_drops, s_rx_writes, s_connects;

/* ---- Connection-event phase estimation --------------------------------------------------------- */

static portMUX_TYPE s_ph_mux = portMUX_INITIALIZER_UNLOCKED;
static int64_t s_nocp_ring[32];
static volatile uint8_t s_nocp_head, s_nocp_tail;
static volatile uint32_t s_nocp_events;
static volatile int64_t s_last_nocp_us;
static volatile int64_t s_reacquire_until_us;
static int32_t s_phase_buf[PHASE_SAMPLES];
static int s_phase_n;
static int s_sync_calls;
static volatile bool s_sync_enabled = true;
static volatile bool s_sync_locked;
static volatile int32_t s_phase_us = -1;

static void reset_phase_window(int64_t reacquire_for_us) {
    const int64_t now = esp_timer_get_time();
    portENTER_CRITICAL_SAFE(&s_ph_mux);
    s_nocp_head = 0;
    s_nocp_tail = 0;
    s_last_nocp_us = now;
    portEXIT_CRITICAL_SAFE(&s_ph_mux);
    s_phase_n = 0;
    s_sync_calls = 0;
    s_sync_locked = false;
    if (reacquire_for_us > 0) {
        s_reacquire_until_us = now + reacquire_for_us;
    }
}

/**
 * Every HCI event the controller hands to the NimBLE host passes through here (linker --wrap).
 * "Number Of Completed Packets" (0x13) is reported right after the connection event in which our
 * notification was acknowledged, so its timestamp marks the end of a connection event.
 */
int __real_ble_transport_to_hs_evt_impl(void *buf);
int __wrap_ble_transport_to_hs_evt_impl(void *buf) {
    const uint8_t *ev = (const uint8_t *)buf;
    if (ev != NULL && ev[0] == 0x13) {
        const int64_t now = esp_timer_get_time();
        portENTER_CRITICAL_SAFE(&s_ph_mux);
        const uint8_t next = (uint8_t)((s_nocp_head + 1) % 32);
        if (next != s_nocp_tail) {
            s_nocp_ring[s_nocp_head] = now;
            s_nocp_head = next;
        }
        s_last_nocp_us = now;
        s_nocp_events++;
        portEXIT_CRITICAL_SAFE(&s_ph_mux);
    }
    return __real_ble_transport_to_hs_evt_impl(buf);
}

bool slaprf_ble_needs_radio_free(void) {
    if (!slaprf_ble_connected() || !s_sync_enabled) {
        return false;
    }
    if (!slaprf_ble_ready()) {
        // Keep 2.4 GHz uninterrupted during GATT service discovery, MTU exchange, and CCCD subscribe.
        return slaprf_ble_connected_us() < 2500000LL;
    }
    const int64_t now = esp_timer_get_time();
    if (!s_sync_locked && now < s_reacquire_until_us) {
        return true;
    }
    // Self-healing escape: if notifications are queued/sent but >180 ms passes without a single
    // completed packet, our connection anchor drifted or updated onto the sweep window; briefly
    // yield 2.4 GHz so fresh NOCP timestamps arrive and jump the schedule back into the gap.
    const int64_t last_nocp = s_last_nocp_us;
    if (last_nocp > 0 && now - last_nocp > 180000) {
        reset_phase_window(450000);
        return true;
    }
    return false;
}

static int32_t wrap_signed(int32_t v, int32_t period) {
    v %= period;
    if (v > period / 2) v -= period;
    if (v < -period / 2) v += period;
    return v;
}

static int cmp_i32(const void *a, const void *b) {
    const int32_t x = *(const int32_t *)a, y = *(const int32_t *)b;
    return (x > y) - (x < y);
}

int32_t slaprf_ble_sync_adjust_us(int64_t superframe_start_us, uint32_t sweep_interval_us, uint32_t target_phase_us) {
    const int32_t period = (int32_t)sweep_interval_us;
    // Move new completed-packet timestamps into phase samples relative to this superframe's grid.
    for (;;) {
        int64_t t;
        portENTER_CRITICAL(&s_ph_mux);
        if (s_nocp_tail == s_nocp_head) {
            portEXIT_CRITICAL(&s_ph_mux);
            break;
        }
        t = s_nocp_ring[s_nocp_tail];
        s_nocp_tail = (uint8_t)((s_nocp_tail + 1) % 32);
        portEXIT_CRITICAL(&s_ph_mux);
        int64_t r = (t - superframe_start_us) % period;
        if (r < 0) r += period;
        if (s_phase_n < PHASE_SAMPLES) {
            s_phase_buf[s_phase_n++] = (int32_t)r;
        }
    }

    if (++s_sync_calls < SYNC_EVAL_CALLS) {
        return 0;
    }
    s_sync_calls = 0;

    const uint32_t itvl = s_itvl_us;
    // Any multiple of 10 ms (10, 20, 30 ms) aligns every event; 15 ms aligns every 2nd event (30 ms).
    const bool aligned_itvl = itvl != 0 && ((itvl % sweep_interval_us) == 0 || itvl == 15000U);
    if (s_conn == BLE_HS_CONN_HANDLE_NONE || !aligned_itvl || s_phase_n < 4) {
        if (s_conn == BLE_HS_CONN_HANDLE_NONE || !aligned_itvl) {
            s_phase_n = 0;
            s_sync_locked = false;
            if (s_conn == BLE_HS_CONN_HANDLE_NONE) s_phase_us = -1;
        }
        return 0;
    }

    // Circular mean of the samples, then the low envelope (10th percentile) around it: completed
    // packet events can only arrive late (host scheduling), never early.
    float sx = 0, sy = 0;
    for (int i = 0; i < s_phase_n; i++) {
        const float a = 2.0f * (float)M_PI * (float)s_phase_buf[i] / (float)period;
        sx += cosf(a);
        sy += sinf(a);
    }
    float mean_a = atan2f(sy, sx);
    if (mean_a < 0) mean_a += 2.0f * (float)M_PI;
    const int32_t mean = (int32_t)(mean_a * (float)period / (2.0f * (float)M_PI));
    for (int i = 0; i < s_phase_n; i++) {
        s_phase_buf[i] = wrap_signed(s_phase_buf[i] - mean, period);
    }
    qsort(s_phase_buf, (size_t)s_phase_n, sizeof(int32_t), cmp_i32);
    const int32_t lo = s_phase_buf[s_phase_n / 10];
    int32_t phase = (mean + lo) % period;
    if (phase < 0) phase += period;
    s_phase_us = phase;
    s_phase_n = 0;

    if (!s_sync_enabled) {
        s_sync_locked = false;
        return 0;
    }
    // Positive error: the connection event ends later than the target, so start sweeps later.
    const int32_t err = wrap_signed(phase - (int32_t)target_phase_us, period);
    if (err >= -450 && err <= 450) {
        s_sync_locked = true;
        s_reacquire_until_us = 0;
        return err / 3;
    }
    if (!s_sync_locked) {
        // Unlocked: jump the entire phase offset in a single superframe so the very next cycle is
        // parked cleanly inside the gap.
        if (err >= -900 && err <= 900) {
            s_sync_locked = true;
            s_reacquire_until_us = 0;
        }
        return err;
    }
    // Already locked, small drift beyond 450 us: nudge smoothly without unlocking unless far off.
    if (err > 1200 || err < -1200) {
        s_sync_locked = false;
        return err;
    }
    return err / 2;
}

void slaprf_ble_set_sync_enabled(bool on) {
    s_sync_enabled = on;
    if (!on) s_sync_locked = false;
}

void slaprf_ble_trigger_reacquire(int64_t duration_us) {
    reset_phase_window(duration_us);
}

/* ---- GATT ------------------------------------------------------------------------------------- */

static int chr_access(uint16_t conn_handle, uint16_t attr_handle, struct ble_gatt_access_ctxt *ctxt, void *arg) {
    (void)conn_handle;
    (void)attr_handle;
    (void)arg;
    if (ctxt->op != BLE_GATT_ACCESS_OP_WRITE_CHR) {
        return BLE_ATT_ERR_UNLIKELY;
    }
    uint8_t buf[MAX_NOTIFY_BYTES + 8];
    uint16_t len = 0;
    const uint16_t om_len = OS_MBUF_PKTLEN(ctxt->om);
    if (om_len > sizeof(buf) || ble_hs_mbuf_to_flat(ctxt->om, buf, sizeof(buf), &len) != 0) {
        return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    }
    s_rx_writes++;
    if (len > 0 && s_rx_sb != NULL) {
        xStreamBufferSend(s_rx_sb, buf, len, 0); // Never block the NimBLE host task
    }
    return 0;
}

static const struct ble_gatt_svc_def s_svcs[] = {
    {
        .type = BLE_GATT_SVC_TYPE_PRIMARY,
        .uuid = &s_svc_uuid.u,
        .characteristics =
            (struct ble_gatt_chr_def[]){
                {
                    .uuid = &s_rx_uuid.u,
                    .access_cb = chr_access,
                    .flags = BLE_GATT_CHR_F_WRITE | BLE_GATT_CHR_F_WRITE_NO_RSP,
                },
                {
                    .uuid = &s_tx_uuid.u,
                    .access_cb = chr_access,
                    .val_handle = &s_tx_handle,
                    .flags = BLE_GATT_CHR_F_NOTIFY,
                },
                {0},
            },
    },
    {0},
};

/* ---- GAP -------------------------------------------------------------------------------------- */

static int gap_event(struct ble_gap_event *event, void *arg);

static void update_scan_rsp(void) {
    s_mfg[12] = s_adv_paired ? 0x01U : 0x00U;
    struct ble_hs_adv_fields rsp;
    memset(&rsp, 0, sizeof(rsp));
    rsp.name = (const uint8_t *)s_name;
    rsp.name_len = (uint8_t)strlen(s_name);
    rsp.name_is_complete = 1;
    rsp.mfg_data = s_mfg;
    rsp.mfg_data_len = sizeof(s_mfg);
    int rc = ble_gap_adv_rsp_set_fields(&rsp);
    if (rc != 0) {
        ESP_LOGW(TAG, "scan rsp rc=%d", rc);
    }
}

static void advertise(void) {
    struct ble_hs_adv_fields f;
    memset(&f, 0, sizeof(f));
    f.flags = BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP;
    f.uuids128 = &s_svc_uuid;
    f.num_uuids128 = 1;
    f.uuids128_is_complete = 1;
    int rc = ble_gap_adv_set_fields(&f);
    if (rc != 0) {
        ESP_LOGW(TAG, "adv fields rc=%d", rc);
        return;
    }

    update_scan_rsp();

    struct ble_gap_adv_params p;
    memset(&p, 0, sizeof(p));
    p.conn_mode = BLE_GAP_CONN_MODE_UND;
    p.disc_mode = BLE_GAP_DISC_MODE_GEN;
    p.itvl_min = BLE_GAP_ADV_ITVL_MS(100);
    p.itvl_max = BLE_GAP_ADV_ITVL_MS(150);
    rc = ble_gap_adv_start(s_own_addr_type, NULL, BLE_HS_FOREVER, &p, gap_event, NULL);
    if (rc != 0 && rc != BLE_HS_EALREADY) {
        ESP_LOGW(TAG, "adv start rc=%d", rc);
    }
}

static void request_interval(uint16_t conn, uint8_t idx) {
    if (idx >= sizeof(k_itvl_pref) / sizeof(k_itvl_pref[0])) return;
    struct ble_gap_upd_params up = {
        .itvl_min = k_itvl_pref[idx],
        .itvl_max = k_itvl_pref[idx],
        .latency = 0,
        .supervision_timeout = 400, // 4 s
        .min_ce_len = 0,
        .max_ce_len = 0,
    };
    s_itvl_try = idx;
    s_itvl_req_us = esp_timer_get_time();
    const int rc = ble_gap_update_params(conn, &up);
    if (rc != 0) {
        ESP_LOGW(TAG, "conn param update (%u x 1.25 ms) rc=%d", k_itvl_pref[idx], rc);
    }
}

static void refresh_conn_desc(uint16_t conn) {
    struct ble_gap_conn_desc d;
    if (ble_gap_conn_find(conn, &d) == 0) {
        s_itvl_us = (uint32_t)d.conn_itvl * 1250U;
    }
}

static int gap_event(struct ble_gap_event *event, void *arg) {
    (void)arg;
    switch (event->type) {
    case BLE_GAP_EVENT_CONNECT:
        if (event->connect.status == 0) {
            s_conn = event->connect.conn_handle;
            s_conn_since_us = esp_timer_get_time();
            s_subscribed = false;
            s_mtu = 23;
            s_phy = 1;
            s_connects++;
            s_phase_us = -1;
            reset_phase_window(1200000);
            refresh_conn_desc(s_conn);
            ble_gap_set_data_len(s_conn, 251, 2120);
#if CONFIG_BT_NIMBLE_50_FEATURE_SUPPORT
            ble_gap_set_prefered_le_phy(s_conn, BLE_GAP_LE_PHY_2M_MASK, BLE_GAP_LE_PHY_2M_MASK, BLE_GAP_LE_PHY_CODED_ANY);
#endif
            s_itvl_try = 0;
            s_itvl_req_us = 0;
        } else {
            advertise();
        }
        return 0;
    case BLE_GAP_EVENT_DISCONNECT: {
        s_conn = BLE_HS_CONN_HANDLE_NONE;
        s_conn_since_us = 0;
        s_subscribed = false;
        s_itvl_us = 0;
        s_sync_locked = false;
        s_reacquire_until_us = 0;
        s_phase_us = -1;
        if (s_on_event) s_on_event(false);
        advertise();
        return 0;
    }
    case BLE_GAP_EVENT_SUBSCRIBE:
        if (event->subscribe.attr_handle == s_tx_handle) {
            const bool now = event->subscribe.cur_notify != 0;
            const bool was = s_subscribed;
            s_subscribed = now;
            if (now) {
                reset_phase_window(900000);
                // Request our 10 ms-aligned interval AFTER GATT service discovery & CCCD subscribe
                // complete so Android does not overwrite or ignore it during discovery.
                if (s_itvl_us == 0 || (s_itvl_us % 10000U) != 0) {
                    request_interval(s_conn, 0);
                }
            }
            if (now != was && s_on_event) s_on_event(now);
        }
        return 0;
    case BLE_GAP_EVENT_MTU:
        s_mtu = event->mtu.value;
        return 0;
    case BLE_GAP_EVENT_CONN_UPDATE:
        refresh_conn_desc(event->conn_update.conn_handle);
        if (event->conn_update.status == 0) {
            // Connection interval / anchor just moved: discard stale phase samples and re-lock immediately.
            reset_phase_window(800000);
        } else if (s_itvl_try + 1 < (uint8_t)(sizeof(k_itvl_pref) / sizeof(k_itvl_pref[0]))) {
            // Central rejected this interval (e.g. Windows rejecting 10 ms): immediately ask for 20 ms.
            request_interval(event->conn_update.conn_handle, (uint8_t)(s_itvl_try + 1));
        }
        return 0;
    case BLE_GAP_EVENT_CONN_UPDATE_REQ:
        return 0; // Accept the central's parameters; the watchdog below asks again if they don't fit
#if CONFIG_BT_NIMBLE_50_FEATURE_SUPPORT
    case BLE_GAP_EVENT_PHY_UPDATE_COMPLETE:
        if (event->phy_updated.status == 0) s_phy = event->phy_updated.tx_phy;
        return 0;
#endif
    case BLE_GAP_EVENT_ADV_COMPLETE:
        advertise();
        return 0;
    default:
        return 0;
    }
}

static void on_sync(void) {
    int rc = ble_hs_util_ensure_addr(0);
    if (rc == 0) rc = ble_hs_id_infer_auto(0, &s_own_addr_type);
    if (rc != 0) {
        ESP_LOGE(TAG, "no BLE address (rc=%d)", rc);
        return;
    }
    s_synced = true;
    advertise();
}

static void on_reset(int reason) {
    s_synced = false;
    ESP_LOGW(TAG, "NimBLE host reset, reason=%d", reason);
}

static void host_task(void *param) {
    (void)param;
    nimble_port_run();
    nimble_port_freertos_deinit();
}

/* ---- Byte-stream tasks ------------------------------------------------------------------------ */

bool slaprf_ble_connected(void) {
    return s_conn != BLE_HS_CONN_HANDLE_NONE;
}

int64_t slaprf_ble_connected_us(void) {
    if (s_conn == BLE_HS_CONN_HANDLE_NONE || s_conn_since_us <= 0) {
        return 0;
    }
    const int64_t diff = esp_timer_get_time() - s_conn_since_us;
    return diff > 0 ? diff : 0;
}

bool slaprf_ble_ready(void) {
    return s_conn != BLE_HS_CONN_HANDLE_NONE && s_subscribed;
}

void slaprf_ble_disconnect(void) {
    const uint16_t conn = s_conn;
    if (conn != BLE_HS_CONN_HANDLE_NONE) {
        ble_gap_terminate(conn, BLE_ERR_REM_USER_CONN_TERM);
    }
}

void slaprf_ble_set_paired_flag(bool paired) {
    s_adv_paired = paired;
    if (s_synced && s_conn == BLE_HS_CONN_HANDLE_NONE) {
        ble_gap_adv_stop();
        advertise();
    }
}

size_t slaprf_ble_write(const void *data, size_t len, uint32_t timeout_ms) {
    if (!slaprf_ble_ready() || s_tx_sb == NULL || data == NULL || len == 0 || len > TX_BUFFER_BYTES) {
        return 0;
    }
    const TickType_t deadline = xTaskGetTickCount() + pdMS_TO_TICKS(timeout_ms);
    if (xSemaphoreTake(s_tx_mutex, pdMS_TO_TICKS(timeout_ms)) != pdTRUE) {
        s_tx_drops += (uint32_t)len;
        return 0;
    }
    // Never write a partial frame or partial JSON line into the stream buffer: wait (up to
    // timeout_ms) for full room, or drop the entire record atomically so framing stays intact.
    while (slaprf_ble_ready() && xStreamBufferSpacesAvailable(s_tx_sb) < len) {
        if (timeout_ms == 0 || (int32_t)(deadline - xTaskGetTickCount()) <= 0) {
            xSemaphoreGive(s_tx_mutex);
            s_tx_drops += (uint32_t)len;
            return 0;
        }
        xSemaphoreGive(s_tx_mutex);
        vTaskDelay(pdMS_TO_TICKS(4));
        const int32_t rem = (int32_t)(deadline - xTaskGetTickCount());
        if (rem <= 0 || xSemaphoreTake(s_tx_mutex, (TickType_t)rem) != pdTRUE) {
            s_tx_drops += (uint32_t)len;
            return 0;
        }
    }
    if (!slaprf_ble_ready()) {
        xSemaphoreGive(s_tx_mutex);
        return 0;
    }
    const size_t n = xStreamBufferSend(s_tx_sb, data, len, 0);
    xSemaphoreGive(s_tx_mutex);
    if (n < len) {
        s_tx_drops += (uint32_t)(len - n);
    }
    return n;
}

/** Drains the TX buffer into notifications of up to ATT_MTU - 3 bytes. */
static void tx_task(void *arg) {
    (void)arg;
    static uint8_t buf[MAX_NOTIFY_BYTES];
    int64_t next_maint_us = 0;
    for (;;) {
        const int64_t now = esp_timer_get_time();
        if (now >= next_maint_us) {
            next_maint_us = now + 250000;
            const uint16_t conn = s_conn;
            if (conn != BLE_HS_CONN_HANDLE_NONE) {
                int8_t rssi = 0;
                if (ble_gap_conn_rssi(conn, &rssi) == 0) s_rssi = rssi;
                refresh_conn_desc(conn);
                // Not a multiple of the 10 ms sweep period after 700 ms post-subscribe: try 20 ms, then 30 ms.
                const uint32_t itvl = s_itvl_us;
                if (s_subscribed && itvl != 0 && (itvl % 10000U) != 0 && now - s_itvl_req_us > 700000 &&
                    s_itvl_try + 1 < (uint8_t)(sizeof(k_itvl_pref) / sizeof(k_itvl_pref[0]))) {
                    request_interval(conn, (uint8_t)(s_itvl_try + 1));
                }
            }
        }

        if (!slaprf_ble_ready()) {
            // Discard anything left from a previous connection.
            while (xStreamBufferReceive(s_tx_sb, buf, sizeof(buf), 0) > 0) {
            }
            vTaskDelay(pdMS_TO_TICKS(20));
            continue;
        }
        size_t cap = s_mtu > 3 ? (size_t)(s_mtu - 3) : MIN_NOTIFY_BYTES;
        if (cap > MAX_NOTIFY_BYTES) cap = MAX_NOTIFY_BYTES;
        if (cap < MIN_NOTIFY_BYTES) cap = MIN_NOTIFY_BYTES;
        size_t n = xStreamBufferReceive(s_tx_sb, buf, cap, pdMS_TO_TICKS(100));
        if (n == 0) {
            continue;
        }
        if (n < cap) {
            // A burst (e.g. a status line written in pieces) may still be arriving this tick.
            n += xStreamBufferReceive(s_tx_sb, buf + n, cap - n, 0);
        }
        // Pace multi-packet bursts (such as ~980-byte STATUS? replies on a 20-30 ms connection
        // interval) when NimBLE's ACL TX queue or MSYS_1 pool is temporarily full instead of
        // dropping middle chunks of a JSON line.
        bool sent = false;
        for (int attempt = 0; attempt < 35 && slaprf_ble_ready(); attempt++) {
            struct os_mbuf *om = ble_hs_mbuf_from_flat(buf, (uint16_t)n);
            if (om == NULL) {
                vTaskDelay(pdMS_TO_TICKS(4));
                continue;
            }
            const int rc = ble_gatts_notify_custom(s_conn, s_tx_handle, om);
            if (rc == 0) {
                s_tx_notifies++;
                s_tx_bytes += (uint32_t)n;
                sent = true;
                break;
            }
            if (rc != BLE_HS_ENOMEM && rc != BLE_HS_EBUSY) {
                break;
            }
            vTaskDelay(pdMS_TO_TICKS(4));
        }
        if (!sent) {
            s_tx_drops += (uint32_t)n;
        }
    }
}

static void rx_task(void *arg) {
    (void)arg;
    uint8_t buf[128];
    for (;;) {
        const size_t n = xStreamBufferReceive(s_rx_sb, buf, sizeof(buf), portMAX_DELAY);
        if (n > 0 && s_on_rx) {
            s_on_rx(buf, n);
        }
    }
}

void slaprf_ble_get_stats(slaprf_ble_stats_t *out) {
    if (out == NULL) return;
    memset(out, 0, sizeof(*out));
    out->connected = slaprf_ble_ready();
    out->interval_us = s_conn != BLE_HS_CONN_HANDLE_NONE ? s_itvl_us : 0;
    out->mtu = s_mtu;
    out->phy = s_phy;
    out->tx_notifies = s_tx_notifies;
    out->tx_bytes = s_tx_bytes;
    out->tx_drops = s_tx_drops;
    out->rx_writes = s_rx_writes;
    out->nocp_events = s_nocp_events;
    out->sync_enabled = s_sync_enabled;
    out->sync_locked = s_sync_locked;
    out->phase_us = s_phase_us;
    out->connects = s_connects;
    out->rssi = s_conn != BLE_HS_CONN_HANDLE_NONE ? s_rssi : 0;
}

void slaprf_ble_link_start(const char *label, uint32_t fingerprint, uint8_t role, const uint8_t fw_version[3],
                           bool paired, slaprf_ble_rx_cb_t on_rx, slaprf_ble_event_cb_t on_event) {
    s_on_rx = on_rx;
    s_on_event = on_event;
    s_adv_paired = paired;
    s_tx_sb = xStreamBufferCreate(TX_BUFFER_BYTES, 1);
    s_rx_sb = xStreamBufferCreate(RX_BUFFER_BYTES, 1);
    s_tx_mutex = xSemaphoreCreateMutex();

    // Scan-response name "SlapRF <label>" (at most 14 characters so 16 + 15 <= 31-byte scan response).
    char clean[16] = {0};
    int ci = 0;
    for (int i = 0; label != NULL && label[i] && ci < 7; i++) {
        const char c = label[i];
        if (c >= 0x20 && c < 0x7F) clean[ci++] = c;
    }
    snprintf(s_name, sizeof(s_name), ci ? "SlapRF %s" : "SlapRF Hub", clean);
    s_name[14] = 0;

    // Manufacturer data: 0xFFFF (no company ID), 'S' 'R', fingerprint LE, role, fw version, flags.
    s_mfg[0] = 0xFF;
    s_mfg[1] = 0xFF;
    s_mfg[2] = 'S';
    s_mfg[3] = 'R';
    s_mfg[4] = (uint8_t)(fingerprint & 0xFF);
    s_mfg[5] = (uint8_t)((fingerprint >> 8) & 0xFF);
    s_mfg[6] = (uint8_t)((fingerprint >> 16) & 0xFF);
    s_mfg[7] = (uint8_t)((fingerprint >> 24) & 0xFF);
    s_mfg[8] = role;
    s_mfg[9] = fw_version ? fw_version[0] : 0;
    s_mfg[10] = fw_version ? fw_version[1] : 0;
    s_mfg[11] = fw_version ? fw_version[2] : 0;
    s_mfg[12] = paired ? 0x01U : 0x00U;

    if (nimble_port_init() != ESP_OK) {
        ESP_LOGE(TAG, "nimble_port_init failed");
        return;
    }
    ble_hs_cfg.sync_cb = on_sync;
    ble_hs_cfg.reset_cb = on_reset;
    ble_svc_gap_init();
    ble_svc_gatt_init();
    if (ble_gatts_count_cfg(s_svcs) != 0 || ble_gatts_add_svcs(s_svcs) != 0) {
        ESP_LOGE(TAG, "GATT service registration failed");
        return;
    }
    ble_svc_gap_device_name_set(s_name);
    ble_att_set_preferred_mtu(247);

    // Low priority (below the console reply path but above app_main's spin): the TX drain only
    // needs to keep up with ~3 KB/s of Hub frames plus occasional status lines.
    xTaskCreate(tx_task, "slaprf_ble_tx", 3072, NULL, 3, NULL);
    xTaskCreate(rx_task, "slaprf_ble_rx", 4096, NULL, 2, NULL);
    nimble_port_freertos_init(host_task);
}
