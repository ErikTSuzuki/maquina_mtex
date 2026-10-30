#include "telemetry.h"

#include <inttypes.h>
#include <stdio.h>
#include <string.h>
#include "esp_random.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"

typedef struct {
  uint32_t boot, seq, ms, dropped;
  uint32_t detected[4], diverted[3];
  uint32_t step, step_ms, phase_started;
  uint8_t belt[7];
  uint8_t inputs, pulses;
  bool motor;
  const char *event;
} TelemetryFrame;

// Only the control task mutates state. The writer receives value copies.
static TelemetryFrame state;
static QueueHandle_t frames;
static int64_t last_snapshot;
static const char *const input_names[] = {
    "sp", "sm", "sg", "Smet", "fBp", "fBm", "fBg", "botao"};
static const char *const pulse_names[] = {"iBp", "iBm", "iBg", "iBgV"};

static void publish(const char *event) {
  if (frames == NULL) return;
  state.seq++;
  state.ms = (uint32_t)(esp_timer_get_time() / 1000);
  state.event = event;
  // Never wait for the browser, USB, or serial output in the control loop.
  if (xQueueSend(frames, &state, 0) != pdTRUE) state.dropped++;
}

static void writer_task(void *arg) {
  (void)arg;
  TelemetryFrame frame;
  for (;;) {
    if (xQueueReceive(frames, &frame, portMAX_DELAY) != pdTRUE) continue;
    // One complete line per call, distinguishable from the supervisor's logs.
    printf("@XC241 {\"v\":1,\"boot\":%" PRIu32 ",\"seq\":%" PRIu32
           ",\"ms\":%" PRIu32 ",\"motor\":%u,\"inputs\":%u,\"pulses\":%u,"
           "\"detected\":[%" PRIu32 ",%" PRIu32 ",%" PRIu32 ",%" PRIu32 "],"
           "\"diverted\":[%" PRIu32 ",%" PRIu32 ",%" PRIu32 "],"
           "\"dropped\":%" PRIu32 ",\"event\":\"%s\","
           "\"belt\":[%u,%u,%u,%u,%u,%u,%u],\"step\":%" PRIu32
           ",\"step_ms\":%" PRIu32 ",\"phase_ms\":%" PRIu32 "}\n",
           frame.boot, frame.seq, frame.ms, (unsigned)frame.motor,
           (unsigned)frame.inputs, (unsigned)frame.pulses,
           frame.detected[0], frame.detected[1], frame.detected[2], frame.detected[3],
           frame.diverted[0], frame.diverted[1], frame.diverted[2],
           frame.dropped, frame.event,
           (unsigned)frame.belt[0], (unsigned)frame.belt[1],
           (unsigned)frame.belt[2], (unsigned)frame.belt[3],
           (unsigned)frame.belt[4], (unsigned)frame.belt[5],
           (unsigned)frame.belt[6], frame.step, frame.step_ms,
           frame.ms - frame.phase_started);
  }
}

void telemetry_init(void) {
  state.boot = esp_random();
  frames = xQueueCreate(64, sizeof(TelemetryFrame));
  if (frames == NULL) return; // Telemetry failure never stops machine control.
  if (xTaskCreate(writer_task, "xc241_telemetry", 4096, NULL, tskIDLE_PRIORITY,
                  NULL) != pdPASS) {
    vQueueDelete(frames);
    frames = NULL;
    return;
  }
  publish("boot");
}

void telemetry_input(unsigned index, bool active) {
  if (index >= 8) return;
  uint8_t bit = (uint8_t)(1U << index);
  if (!!(state.inputs & bit) == active) return;
  if (active && !(state.inputs & bit) && index < 4) state.detected[index]++;
  state.inputs = active ? state.inputs | bit : state.inputs & (uint8_t)~bit;
  publish(input_names[index]);
}

void telemetry_motor(bool active) {
  state.motor = active;
  state.phase_started = (uint32_t)(esp_timer_get_time() / 1000);
  publish(active ? "ie" : "fe");
}

void telemetry_pulse(unsigned index, bool active) {
  if (index >= 4) return;
  uint8_t bit = (uint8_t)(1U << index);
  if (active && index < 3) state.diverted[index]++;
  state.pulses = active ? state.pulses | bit : state.pulses & (uint8_t)~bit;
  publish(active ? pulse_names[index] : "pulse_end");
}

void telemetry_belt(const uint8_t slots[7], uint32_t step, uint32_t step_ms) {
  memcpy(state.belt, slots, sizeof(state.belt));
  state.step = step;
  state.step_ms = step_ms;
  publish("belt");
}

void telemetry_tick(void) {
  int64_t now = esp_timer_get_time();
  if (now - last_snapshot >= 100000) {
    last_snapshot = now;
    publish("state");
  }
}
