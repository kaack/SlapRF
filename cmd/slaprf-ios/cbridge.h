#ifndef SLAPRF_IOS_CBRIDGE_H
#define SLAPRF_IOS_CBRIDGE_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef int (*slaprf_ios_ble_available_fn)(void);
typedef char* (*slaprf_ios_ble_list_ports_json_fn)(void);
typedef int (*slaprf_ios_ble_open_port_fn)(const char *port_name, int baud_rate, char **err_out);
typedef int (*slaprf_ios_ble_read_port_fn)(int handle, void *out_ptr, int max_len, int timeout_ms);
typedef int (*slaprf_ios_ble_write_port_fn)(int handle, const void *data_ptr, int len);
typedef void (*slaprf_ios_ble_close_port_fn)(int handle);

// Called once by Swift (SlapRFBleShim.registerWithGoBridge) before starting the Go server.
void slaprf_ios_register_ble_callbacks(
    slaprf_ios_ble_available_fn available_fn,
    slaprf_ios_ble_list_ports_json_fn list_ports_fn,
    slaprf_ios_ble_open_port_fn open_port_fn,
    slaprf_ios_ble_read_port_fn read_port_fn,
    slaprf_ios_ble_write_port_fn write_port_fn,
    slaprf_ios_ble_close_port_fn close_port_fn
);

// Invoked from Go (cmd/slaprf-ios/ble_cbridge.go).
int slaprf_ios_ble_available(void);
char* slaprf_ios_ble_list_ports_json(void);
int slaprf_ios_ble_open_port(const char *port_name, int baud_rate, char **err_out);
int slaprf_ios_ble_read_port(int handle, void *out_ptr, int max_len, int timeout_ms);
int slaprf_ios_ble_write_port(int handle, const void *data_ptr, int len);
void slaprf_ios_ble_close_port(int handle);

#ifdef __cplusplus
}
#endif

#endif // SLAPRF_IOS_CBRIDGE_H
