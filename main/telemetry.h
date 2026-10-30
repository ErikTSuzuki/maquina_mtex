#ifndef XC241_TELEMETRY_H
#define XC241_TELEMETRY_H

#include <stdbool.h>
#include <stdint.h>

// Observation only. Called by the existing control task; never drives a GPIO.
void telemetry_init(void);
void telemetry_input(unsigned index, bool active);
void telemetry_motor(bool active);
void telemetry_pulse(unsigned index, bool active);
void telemetry_belt(const uint8_t slots[7], uint32_t step, uint32_t step_ms);
void telemetry_tick(void);

#endif
