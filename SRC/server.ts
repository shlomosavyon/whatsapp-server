// THIS IS THE ENDPOINT LOVABLE CALLS TO SEND MESSAGES
// Accepts: { message: string, group?: string }
// If group is provided (e.g. "Calendar" or "Tomer Table"), sends to that group
// If group is omitted, sends to the default group (Tomer Table)
app.post('/api/whatsapp/test', async (req, res) => {
  try {
    const whatsapp = getWhatsAppService();
    const { message, group } = req.body || {};
    const success = await whatsapp.sendMessage(message || "Test message from WhatsApp server", group || undefined);
    res.json({ success, message: `Message sent to ${group || 'default group'}` });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});
