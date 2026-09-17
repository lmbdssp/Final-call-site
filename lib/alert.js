export async function sendAlert(subject, message) {
  const apiKey = process.env.RESEND_API_KEY;
  const alertEmail = process.env.ALERT_EMAIL;
  if (!apiKey || !alertEmail) {
    console.error('Alert skipped — RESEND_API_KEY or ALERT_EMAIL not set:', subject, message);
    return;
  }
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Final Call Alerts <alerts@finalcallpro.com>',
        to: alertEmail,
        subject: `[Final Call] ${subject}`,
        text: message,
      }),
    });
  } catch (err) {
    console.error('Failed to send alert email:', err);
  }
}
