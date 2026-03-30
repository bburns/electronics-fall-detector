// alerts.js — multi-channel alert dispatcher
import nodemailer from 'nodemailer'
import 'dotenv/config'

const {
  TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM,
  CAREGIVER_PHONES,           // comma-separated list
  NTFY_TOPIC, NTFY_SERVER,
  SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS,
  CAREGIVER_EMAILS,           // comma-separated list
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_IDS,          // comma-separated list
  DEVICE_NAME,
} = process.env

const name = DEVICE_NAME || 'Family Member'
const phones = (CAREGIVER_PHONES || '').split(',').map(s => s.trim()).filter(Boolean)
const emails = (CAREGIVER_EMAILS || '').split(',').map(s => s.trim()).filter(Boolean)
const chatIds = (TELEGRAM_CHAT_IDS || '').split(',').map(s => s.trim()).filter(Boolean)

// ── SMS via Twilio ────────────────────────────────────────────────────────────
async function sendSMS(message) {
  if (!TWILIO_SID || !phones.length) return
  const { default: twilio } = await import('twilio')
  const client = twilio(TWILIO_SID, TWILIO_TOKEN)
  await Promise.all(phones.map(to =>
    client.messages.create({ body: message, from: TWILIO_FROM, to })
  ))
  console.log(`[SMS] Sent to ${phones.join(', ')}`)
}

// ── Push via ntfy.sh (free, self-hostable) ────────────────────────────────────
async function sendPush(title, message) {
  if (!NTFY_TOPIC) return
  const server = NTFY_SERVER || 'https://ntfy.sh'
  await fetch(`${server}/${NTFY_TOPIC}`, {
    method: 'POST',
    headers: {
      'Title': title,
      'Priority': 'urgent',
      'Tags': 'warning,rotating_light',
      'Content-Type': 'text/plain',
    },
    body: message,
  })
  console.log(`[Push] Sent to ntfy topic: ${NTFY_TOPIC}`)
}

// ── Email via SMTP ────────────────────────────────────────────────────────────
async function sendEmail(subject, htmlBody) {
  if (!SMTP_HOST || !emails.length) return
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT) || 587,
    secure: false,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  })
  await transporter.sendMail({
    from: SMTP_USER,
    to: emails.join(', '),
    subject,
    html: htmlBody,
  })
  console.log(`[Email] Sent to ${emails.join(', ')}`)
}

// ── Telegram ──────────────────────────────────────────────────────────────────
async function sendTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN || !chatIds.length) return
  await Promise.all(chatIds.map(chat_id =>
    fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id, text: message, parse_mode: 'Markdown' }),
    })
  ))
  console.log(`[Telegram] Sent to ${chatIds.join(', ')}`)
}

// ── Main dispatcher ───────────────────────────────────────────────────────────
export async function dispatchFallAlert(event) {
  const time = new Date(event.timestamp).toLocaleTimeString()
  const smsMsg = `⚠️ FALL DETECTED — ${name} may need help! Detected at ${time}. Peak impact: ${event.smvPeak?.toFixed(2)}g`
  const emailHtml = `
    <h2 style="color:#c0392b">⚠️ Fall Detected</h2>
    <p><strong>${name}</strong> may have fallen.</p>
    <table>
      <tr><td><strong>Time:</strong></td><td>${new Date(event.timestamp).toLocaleString()}</td></tr>
      <tr><td><strong>Device:</strong></td><td>${event.deviceId}</td></tr>
      <tr><td><strong>Peak impact:</strong></td><td>${event.smvPeak?.toFixed(2)}g</td></tr>
    </table>
    <p>If this was a false alarm, ignore this message.</p>
  `

  const results = await Promise.allSettled([
    sendSMS(smsMsg),
    sendPush(`⚠️ Fall Detected — ${name}`, smsMsg),
    sendEmail(`⚠️ Fall Detected — ${name} at ${time}`, emailHtml),
    sendTelegram(`🚨 *Fall Detected*\n*${name}* may need help\\!\nTime: ${time}\nImpact: ${event.smvPeak?.toFixed(2)}g`),
  ])

  for (const r of results) {
    if (r.status === 'rejected') console.error('[Alert error]', r.reason?.message)
  }
}

export async function dispatchCancelAlert(event) {
  const time = new Date(event.timestamp).toLocaleTimeString()
  const msg = `✅ False alarm cancelled — ${name} is OK (${time})`
  await Promise.allSettled([
    sendSMS(msg),
    sendPush(`✅ False alarm — ${name} is OK`, msg),
    sendEmail(`✅ False alarm cancelled — ${name}`, `<p>${msg}</p>`),
    sendTelegram(`✅ *False alarm* — ${name} pressed cancel at ${time}`),
  ])
}
