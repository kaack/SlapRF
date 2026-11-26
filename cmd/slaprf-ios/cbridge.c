//go:build ios

#include "cbridge.h"
#include <stddef.h>

static slaprf_ios_ble_available_fn g_ble_available = NULL;
static slaprf_ios_ble_list_ports_json_fn g_ble_list_ports = NULL;
static slaprf_ios_ble_open_port_fn g_ble_open_port = NULL;
static slaprf_ios_ble_read_port_fn g_ble_read_port = NULL;
static slaprf_ios_ble_write_port_fn g_ble_write_port = NULL;
static slaprf_ios_ble_close_port_fn g_ble_close_port = NULL;

void slaprf_ios_register_ble_callbacks(
    slaprf_ios_ble_available_fn available_fn,
    slaprf_ios_ble_list_ports_json_fn list_ports_fn,
    slaprf_ios_ble_open_port_fn open_port_fn,
    slaprf_ios_ble_read_port_fn read_port_fn,
    slaprf_ios_ble_write_port_fn write_port_fn,
    slaprf_ios_ble_close_port_fn close_port_fn
) {
    g_ble_available = available_fn;
    g_ble_list_ports = list_ports_fn;
    g_ble_open_port = open_port_fn;
    g_ble_read_port = read_port_fn;
    g_ble_write_port = write_port_fn;
    g_ble_close_port = close_port_fn;
}

int slaprf_ios_ble_available(void) {
    return g_ble_available ? g_ble_available() : 0;
}

char* slaprf_ios_ble_list_ports_json(void) {
    return g_ble_list_ports ? g_ble_list_ports() : NULL;
}

int slaprf_ios_ble_open_port(const char *port_name, int baud_rate, char **err_out) {
    if (!g_ble_open_port) {
        if (err_out) *err_out = NULL;
        return -1;
    }
    return g_ble_open_port(port_name, baud_rate, err_out);
}

int slaprf_ios_ble_read_port(int handle, void *out_ptr, int max_len, int timeout_ms) {
    if (!g_ble_read_port) return -1;
    return g_ble_read_port(handle, out_ptr, max_len, timeout_ms);
}

int slaprf_ios_ble_write_port(int handle, const void *data_ptr, int len) {
    if (!g_ble_write_port) return -1;
    return g_ble_write_port(handle, data_ptr, len);
}

void slaprf_ios_ble_close_port(int handle) {
    if (g_ble_close_port) {
        g_ble_close_port(handle);
    }
}
