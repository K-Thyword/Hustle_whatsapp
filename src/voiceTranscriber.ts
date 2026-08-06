// Transcribes WhatsApp voice notes so a customer can place an order (or
// answer any question mid-flow) by speaking instead of typing. WhatsApp
// only gives us a media ID for an inbound voice note — this module
// resolves that to a temporary download URL, downloads the raw audio, and
// sends it to OpenAI's Whisper transcription API.
//
// The resulting text is handed back to server.ts as a plain string and
// from that point on is handled completely normally by the rest of the
// app: nothing downstream (extractBookingDetails, stage logic, non-answer
// detection, agent commands...) needs to know or care that a message
// originated as speech rather than typed text. That's what keeps this a
// small, bolt-on addition rather than a parallel voice-specific
// conversation path — the deletion test for this module is "does deleting
// it spread complexity elsewhere," and the answer is no: every caller just
// gets back a string, same as if the customer had typed it.
//
// Requires OPENAI_API_KEY (separate from ANTHROPIC_API_KEY, which is
// text-only and has no transcription capability). Gracefully returns
// undefined if the key isn't set, the WhatsApp media download fails, or
// the transcription call fails — callers fall back to asking the sender
// to retry or type instead, same conservative-fallback pattern used by
// detailExtractor.ts.

const hasOpenAiKey = Boolean(process.env.OPENAI_API_KEY);

// WhatsApp media downloads are a two-step dance: resolve the media ID to a
// short-lived signed URL, then fetch the actual bytes from that URL — both
// requests need the same permanent access token used everywhere else in
// server.ts, just against a different Graph endpoint.
async function downloadWhatsAppMedia(
  mediaId: string
): Promise<{ buffer: ArrayBuffer; mimeType: string } | undefined> {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!token || token === "from-meta-business-manager") return undefined;

  try {
    const metaRes = await fetch(`https://graph.facebook.com/v20.0/${mediaId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!metaRes.ok) {
      console.error("Failed to resolve WhatsApp media URL:", await metaRes.text());
      return undefined;
    }
    const meta = (await metaRes.json()) as { url?: string; mime_type?: string };
    if (!meta.url) return undefined;

    const fileRes = await fetch(meta.url, { headers: { Authorization: `Bearer ${token}` } });
    if (!fileRes.ok) {
      console.error("Failed to download WhatsApp media:", await fileRes.text());
      return undefined;
    }
    return { buffer: await fileRes.arrayBuffer(), mimeType: meta.mime_type ?? "audio/ogg" };
  } catch (err) {
    console.error("WhatsApp media download failed:", err);
    return undefined;
  }
}

export async function transcribeVoiceNote(mediaId: string): Promise<string | undefined> {
  if (!hasOpenAiKey) return undefined;

  const downloaded = await downloadWhatsAppMedia(mediaId);
  if (!downloaded) return undefined;

  try {
    const ext = downloaded.mimeType.includes("ogg") ? "ogg" : "m4a";
    const form = new FormData();
    form.append("file", new Blob([downloaded.buffer], { type: downloaded.mimeType }), `voice-note.${ext}`);
    form.append("model", "whisper-1");

    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: form,
    });

    if (!res.ok) {
      console.error("Whisper transcription failed:", await res.text());
      return undefined;
    }
    const data = (await res.json()) as { text?: string };
    const text = data.text?.trim();
    return text && text.length > 0 ? text : undefined;
  } catch (err) {
    console.error("Voice transcription error:", err);
    return undefined;
  }
}
