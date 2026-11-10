function escape(value: string) {
  return value.replace(
    /[&<>"']/g,
    (c) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[c]!,
  );
}

export function packEmailMessage(personName: string, eventName: string, url: string) {
  const person = escape(personName),
    event = escape(eventName),
    link = escape(url);
  return {
    subject: `Your rundowns for ${eventName.replace(/[\r\n]+/g, ' ')}`,
    text: `Hi ${personName},\n\nYour rundowns for ${eventName} are ready. Your current session pack is attached as one PDF, ready to save or print.\n\nView your digital rundowns: ${url}\n\nThe digital view shows the latest saved updates. The attached PDF is a snapshot from when this email was prepared.\n\nSent with Rundown`,
    html: `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Your rundowns are ready</title></head>
<body style="margin:0;padding:0;background:#F5F6F8;color:#16181D;font-family:Inter,Arial,Helvetica,sans-serif;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">Your session pack is attached, with a digital link for the latest updates.</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#F5F6F8;"><tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;"><tr><td style="padding:0 8px 20px;color:#2457D6;font-size:20px;font-weight:700;">Rundown</td></tr>
<tr><td style="padding:32px 28px;background:#FFFFFF;border:1px solid #E2E5EA;border-radius:12px;">
<h1 style="margin:0 0 12px;font-size:28px;line-height:1.2;letter-spacing:-0.5px;">Your rundowns are ready.</h1>
<p style="margin:0 0 28px;color:#3D4350;font-size:18px;line-height:1.5;overflow-wrap:anywhere;">${event}</p>
<p style="margin:0 0 12px;font-size:16px;line-height:1.6;overflow-wrap:anywhere;">Hi ${person},</p>
<p style="margin:0 0 24px;color:#3D4350;font-size:16px;line-height:1.6;">Your current session pack is attached as one PDF, ready to save or print. Open your digital rundowns for a view that stays up to date.</p>
<table role="presentation" cellspacing="0" cellpadding="0"><tr><td bgcolor="#2457D6" style="border-radius:8px;mso-padding-alt:14px 20px;"><a href="${link}" style="display:inline-block;padding:14px 20px;color:#FFFFFF;font-size:16px;line-height:1.4;font-weight:600;text-decoration:none;">View digital rundowns</a></td></tr></table>
<p style="margin:24px 0 0;padding-top:24px;border-top:1px solid #EEF0F3;color:#5B6270;font-size:14px;line-height:1.6;">The digital view shows the latest saved updates. The attached PDF is a snapshot from when this email was prepared.</p>
</td></tr><tr><td style="padding:20px 8px;color:#5B6270;font-size:12px;line-height:1.6;">Sent with Rundown. Keep this email handy for your sessions.<br>If the button doesn’t open, copy this link into your browser:<br><a href="${link}" style="color:#2457D6;word-break:break-all;">${link}</a></td></tr>
</table></td></tr></table></body></html>`,
  };
}
