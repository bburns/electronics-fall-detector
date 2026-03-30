# Fall Detector — Open Source Wearable

Wearable fall detector for elderly family members.
ESP32-S3 + MPU-6050 → Node.js alert server → SMS, push, email, Telegram.

## Hardware

| Part | ~Cost |
|---|---|
| ESP32-S3 dev board | $5 |
| MPU-6050 (accel + gyro breakout) | $1.50 |
| LiPo 500mAh | $4 |
| TP4056 USB-C charger module (w/ protection) | $1 |
| Passive buzzer | $0.50 |
| Push button (momentary, normally open) | $0.25 |

**Total: ~$12**

### Wiring

```
ESP32-S3        MPU-6050
─────────       ────────
3.3V        →   VCC
GND         →   GND
GPIO 21     →   SDA
GPIO 22     →   SCL

GPIO 9      →   Buzzer (+)
GPIO 8      →   Cancel button (other pin to GND, uses internal pullup)
GPIO 7      →   LED anode (220Ω resistor in series to GND)
```

## Server Setup

```bash
npm install
cp .env.example .env
# fill in your credentials
npm start
```

### Alert channels

| Channel | Cost | Setup |
|---|---|---|
| **SMS** via Twilio | ~$0.01/msg | twilio.com — free trial credit |
| **Push** via ntfy.sh | Free | Install ntfy app, subscribe to topic |
| **Email** via SMTP | Free | Gmail App Password recommended |
| **Telegram** | Free | @BotFather → create bot, get token |

You only need to configure the ones you want — each channel is optional.

### ntfy.sh Setup (recommended — instant push, no cost)

1. Install [ntfy app](https://ntfy.sh) on each caregiver's phone (iOS/Android)
2. Subscribe to your topic: `my-family-fall-alerts-abc123`
3. Set `NTFY_TOPIC=my-family-fall-alerts-abc123` in `.env`
4. Done. Alerts arrive as push notifications instantly.

### Exposing to the internet (for remote family members)

If the device leaves home, or you want SMS/alerts to reach caregivers remotely:

Option 1 — Cloudflare Tunnel (zero config):
```bash
cloudflared tunnel --url http://localhost:3000
```

Option 2 — Tailscale (already in your setup):
Point `SERVER_URL` in the firmware to your Tailscale IP.

## Firmware

Open `firmware/fall_detector.ino` in Arduino IDE.

**Required libraries** (install via Library Manager):
- `Adafruit MPU6050`
- `Adafruit Unified Sensor`
- `ArduinoJson`

Set your WiFi credentials and server IP in the `Config` section at the top.

## Detection Algorithm

Five-stage state machine:

```
IDLE → FREEFALL → POST_IMPACT → [FALL CONFIRMED] → ALERTING
         │                            │
         └── timeout → IDLE           └── cancel button → IDLE
```

1. **Free-fall**: SMV drops below 0.5g (brief weightlessness)
2. **Impact**: SMV spikes above 2.5g within 600ms
3. **Stillness**: SMV stays low for 2+ seconds (person lying still)
4. **Orientation**: pitch/roll changed >45° from pre-fall position
5. **Alert**: 30-second cancel window, then all channels fire

False alarm cancel: press the button on the device within 30 seconds.
A "false alarm" notification is then sent to all channels.

## Neomem Integration

In `server/index.js`, the `logEvent()` function appends to `recentEvents[]`.
Pipe this to MongoDB or your Neomem namespace by replacing the TODO comment:

```js
function logEvent(type, event) {
  const entry = { type, ...event, loggedAt: new Date().toISOString() }
  await neomem.put(`/health/fall-events/${entry.loggedAt}`, entry)
}
```

## Tuning the Thresholds

The defaults are conservative (favors catching falls over avoiding false alarms).
Adjust in `fall_detector.ino`:

| Constant | Default | Effect of raising |
|---|---|---|
| `SMV_FREEFALL_THRESHOLD` | 0.5g | Fewer freefall detections |
| `SMV_IMPACT_THRESHOLD` | 2.5g | Fewer impact detections |
| `ORIENTATION_THRESHOLD` | 45° | Requires more dramatic tilt |
| `STILL_DURATION_MS` | 2000ms | Requires longer stillness |

For someone who moves slowly, lowering `SMV_IMPACT_THRESHOLD` to 2.0g may help.
For someone very active, raise `ORIENTATION_THRESHOLD` to 60°.
