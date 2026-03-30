// fall_detector.ino
// ESP32-S3 + MPU-6050 Fall Detector
// Deps: Adafruit_MPU6050, Adafruit_Sensor, ArduinoJson, WiFi (built-in)

#include <WiFi.h>
#include <HTTPClient.h>
#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>
#include <ArduinoJson.h>

// ── Config ────────────────────────────────────────────────────────────────────
const char* WIFI_SSID     = "YourWiFiSSID";
const char* WIFI_PASS     = "YourWiFiPassword";
const char* SERVER_URL    = "http://192.168.1.100:3000";   // your Node server IP
const char* DEVICE_ID     = "grandma-wristband-01";

const int PIN_BUZZER      = 9;
const int PIN_CANCEL_BTN  = 8;
const int PIN_LED         = 7;

// ── Fall detection thresholds ─────────────────────────────────────────────────
// All in g-force units (1g = 9.81 m/s²)
const float SMV_FREEFALL_THRESHOLD  = 0.5;   // below this = free-fall phase
const float SMV_IMPACT_THRESHOLD    = 2.5;   // above this = impact phase
const float SMV_STILL_THRESHOLD     = 0.15;  // variance below this = lying still
const int   IMPACT_WINDOW_MS        = 600;   // max ms between freefall and impact
const int   STILL_DURATION_MS       = 2000;  // must be still for this long after impact
const int   ORIENTATION_THRESHOLD   = 45;    // degrees of pitch/roll change

Adafruit_MPU6050 mpu;

// ── State machine ─────────────────────────────────────────────────────────────
enum State { IDLE, FREEFALL, IMPACT_WAIT, POST_IMPACT, ALERTING };
State state = IDLE;

unsigned long freefallStart  = 0;
unsigned long impactTime     = 0;
unsigned long stillStart     = 0;
float smvPeak                = 0;
float smvFreefall            = 0;
float rollAtImpact           = 0;
float pitchAtImpact          = 0;
bool  alertActive            = false;
unsigned long alertTimestamp = 0;

// ── Helpers ───────────────────────────────────────────────────────────────────
float smv(float ax, float ay, float az) {
  return sqrt(ax*ax + ay*ay + az*az) / 9.81;  // normalize to g-force
}

float smvVariance(float* window, int len) {
  float mean = 0;
  for (int i = 0; i < len; i++) mean += window[i];
  mean /= len;
  float var = 0;
  for (int i = 0; i < len; i++) var += pow(window[i] - mean, 2);
  return var / len;
}

void postToServer(const char* endpoint, JsonDocument& doc) {
  if (WiFi.status() != WL_CONNECTED) return;
  HTTPClient http;
  String url = String(SERVER_URL) + endpoint;
  http.begin(url);
  http.addHeader("Content-Type", "application/json");
  String body;
  serializeJson(doc, body);
  http.POST(body);
  http.end();
}

void triggerLocalAlarm() {
  digitalWrite(PIN_LED, HIGH);
  // 3 short beeps
  for (int i = 0; i < 3; i++) {
    tone(PIN_BUZZER, 2000, 200);
    delay(300);
  }
  alertActive = true;
}

void cancelAlarm() {
  digitalWrite(PIN_LED, LOW);
  noTone(PIN_BUZZER);
  alertActive = false;

  JsonDocument doc;
  doc["deviceId"]  = DEVICE_ID;
  doc["timestamp"] = alertTimestamp;
  postToServer("/cancel", doc);

  state = IDLE;
}

// ── Setup ─────────────────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  pinMode(PIN_BUZZER, OUTPUT);
  pinMode(PIN_CANCEL_BTN, INPUT_PULLUP);
  pinMode(PIN_LED, OUTPUT);

  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("Connecting to WiFi");
  while (WiFi.status() != WL_CONNECTED) { delay(500); Serial.print("."); }
  Serial.println(" connected");

  if (!mpu.begin()) {
    Serial.println("MPU-6050 not found!");
    while (1) delay(10);
  }
  mpu.setAccelerometerRange(MPU6050_RANGE_16_G);
  mpu.setGyroRange(MPU6050_RANGE_500_DEG);
  mpu.setFilterBandwidth(MPU6050_BAND_21_HZ);

  Serial.println("Fall detector ready");
}

// ── Loop ──────────────────────────────────────────────────────────────────────
void loop() {
  // Cancel button check (active LOW with pullup)
  if (digitalRead(PIN_CANCEL_BTN) == LOW && alertActive) {
    delay(50); // debounce
    if (digitalRead(PIN_CANCEL_BTN) == LOW) cancelAlarm();
  }

  sensors_event_t accel, gyro, temp;
  mpu.getEvent(&accel, &gyro, &temp);

  float ax = accel.acceleration.x;
  float ay = accel.acceleration.y;
  float az = accel.acceleration.z;
  float magnitude = smv(ax, ay, az);

  // Compute pitch and roll from accelerometer
  float pitch = atan2(ay, sqrt(ax*ax + az*az)) * 180 / PI;
  float roll  = atan2(ax, sqrt(ay*ay + az*az)) * 180 / PI;

  unsigned long now = millis();

  switch (state) {

    case IDLE:
      if (magnitude < SMV_FREEFALL_THRESHOLD) {
        state = FREEFALL;
        freefallStart = now;
        smvFreefall = magnitude;
        Serial.println("→ FREEFALL");
      }
      break;

    case FREEFALL:
      if (magnitude > SMV_IMPACT_THRESHOLD) {
        // Got impact within window
        state = POST_IMPACT;
        impactTime = now;
        smvPeak = magnitude;
        rollAtImpact = roll;
        pitchAtImpact = pitch;
        Serial.printf("→ IMPACT  peak=%.2fg\n", smvPeak);
      } else if (now - freefallStart > IMPACT_WINDOW_MS) {
        // Freefall without impact — not a fall
        state = IDLE;
      }
      break;

    case POST_IMPACT:
      // Track peak SMV during post-impact
      if (magnitude > smvPeak) smvPeak = magnitude;

      if (magnitude < SMV_FREEFALL_THRESHOLD + 0.5) {
        // Low activity — start timing stillness
        if (stillStart == 0) stillStart = now;
        if (now - stillStart >= STILL_DURATION_MS) {
          // Check orientation change
          float deltaPitch = abs(pitch - pitchAtImpact);
          float deltaRoll  = abs(roll - rollAtImpact);
          float orientationDelta = max(deltaPitch, deltaRoll);

          if (orientationDelta > ORIENTATION_THRESHOLD || smvPeak > 3.5) {
            // FALL CONFIRMED
            Serial.printf("→ FALL CONFIRMED  smvPeak=%.2f  orientDelta=%.1f°\n",
                          smvPeak, orientationDelta);

            alertTimestamp = (unsigned long long)now; // use epoch if RTC available
            state = ALERTING;
            triggerLocalAlarm();

            JsonDocument doc;
            doc["deviceId"]         = DEVICE_ID;
            doc["timestamp"]        = alertTimestamp;
            doc["smvPeak"]          = smvPeak;
            doc["smvFreefall"]      = smvFreefall;
            doc["orientationDelta"] = orientationDelta;
            postToServer("/fall", doc);
          } else {
            Serial.println("→ IDLE (orientation unchanged — not a fall)");
            state = IDLE;
            stillStart = 0;
          }
        }
      } else {
        // Person is moving again — reset stillness timer
        stillStart = 0;
        if (now - impactTime > 5000) {
          // Still active after 5s — probably not a fall
          state = IDLE;
          Serial.println("→ IDLE (active after impact)");
        }
      }
      break;

    case ALERTING:
      // Waiting for cancel button press or server timeout
      // Keep beeping every 10s until cancelled
      static unsigned long lastBeep = 0;
      if (now - lastBeep > 10000) {
        tone(PIN_BUZZER, 1500, 500);
        lastBeep = now;
      }
      break;
  }

  delay(10); // 100Hz sample rate
}
