// index.js — Fall Detector Alert Server
import Fastify from 'fastify'
import 'dotenv/config'
import { dispatchFallAlert, dispatchCancelAlert } from './alerts.js'

const app = Fastify({ logger: true })

// ── In-memory state ───────────────────────────────────────────────────────────
// Maps eventId → { event, timer, cancelled }
const pendingFalls = new Map()

const CONFIRM_DELAY_MS  = Number(process.env.CONFIRM_DELAY_MS)  || 30_000  // 30s cancel window
const REPEAT_ALERT_MS   = Number(process.env.REPEAT_ALERT_MS)   || 120_000 // re-alert if no cancel after 2min
const LOG_EVENTS        = process.env.LOG_EVENTS !== 'false'

// ── Routes ────────────────────────────────────────────────────────────────────

// ESP32 posts this immediately on fall detection
// Body: { deviceId, timestamp, smvPeak, smvFreefall, orientationDelta }
app.post('/fall', async (req, reply) => {
  const event = {
    deviceId:         req.body?.deviceId     || 'unknown',
    timestamp:        req.body?.timestamp    || Date.now(),
    smvPeak:          req.body?.smvPeak      || 0,
    smvFreefall:      req.body?.smvFreefall  || 0,
    orientationDelta: req.body?.orientationDelta || 0,
  }

  const eventId = `${event.deviceId}-${event.timestamp}`
  console.log(`[Fall] Received from ${event.deviceId}:`, event)

  if (LOG_EVENTS) logEvent('fall', event)

  // Start cancel window — if user presses button on device within 30s, suppress alerts
  const timer = setTimeout(async () => {
    const record = pendingFalls.get(eventId)
    if (record?.cancelled) {
      console.log(`[Fall] ${eventId} was cancelled, suppressing alerts`)
      pendingFalls.delete(eventId)
      return
    }
    console.log(`[Fall] Cancel window expired — dispatching all alerts`)
    await dispatchFallAlert(event)

    // Follow-up re-alert if still no response
    setTimeout(async () => {
      if (pendingFalls.has(eventId)) {
        console.log(`[Fall] Re-alerting — no response received`)
        await dispatchFallAlert({ ...event, isRepeat: true })
      }
    }, REPEAT_ALERT_MS)

  }, CONFIRM_DELAY_MS)

  pendingFalls.set(eventId, { event, timer, cancelled: false })

  reply.send({ status: 'received', eventId, cancelWindowMs: CONFIRM_DELAY_MS })
})

// ESP32 posts this when user presses the cancel button within the window
// Body: { deviceId, timestamp }
app.post('/cancel', async (req, reply) => {
  const deviceId  = req.body?.deviceId  || 'unknown'
  const timestamp = req.body?.timestamp || 0

  // Match against any pending fall from this device close in time
  let matched = null
  for (const [id, record] of pendingFalls) {
    if (record.event.deviceId === deviceId &&
        Math.abs(record.event.timestamp - timestamp) < 60_000) {
      matched = { id, record }
      break
    }
  }

  if (matched) {
    clearTimeout(matched.record.timer)
    matched.record.cancelled = true
    pendingFalls.delete(matched.id)
    console.log(`[Cancel] Fall ${matched.id} cancelled`)
    await dispatchCancelAlert(matched.record.event)
    if (LOG_EVENTS) logEvent('cancel', matched.record.event)
    reply.send({ status: 'cancelled' })
  } else {
    console.warn(`[Cancel] No matching pending fall for ${deviceId}`)
    reply.send({ status: 'no_match' })
  }
})

// Health check / dashboard endpoint
app.get('/status', async (req, reply) => {
  reply.send({
    uptime: process.uptime(),
    pendingFalls: pendingFalls.size,
    events: recentEvents.slice(-20),
  })
})

// ── Event log ─────────────────────────────────────────────────────────────────
const recentEvents = []
function logEvent(type, event) {
  const entry = { type, ...event, loggedAt: new Date().toISOString() }
  recentEvents.push(entry)
  if (recentEvents.length > 200) recentEvents.shift()
  // TODO: pipe into Neomem / MongoDB here
  console.log('[Log]', JSON.stringify(entry))
}

// ── Start ─────────────────────────────────────────────────────────────────────
const port = Number(process.env.PORT) || 3000
await app.listen({ port, host: '0.0.0.0' })
console.log(`Fall detector server listening on :${port}`)
