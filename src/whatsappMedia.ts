// Downloads WhatsApp media (voice notes, images, ...) by media ID. WhatsApp
// only ever gives us an ID in the webhook payload — this resolves it to a
// short-lived signed URL via Meta's Graph API, then downloads the raw
// bytes. Both requests use the same permanent access token used everywhere
// else in server.ts, just against the media-specific Graph endpoint.
//
// Pulled out of voiceTranscriber.ts (which originally had this inline) so
// imageAnalyzer.ts can reuse the exact same trusted download path instead
// of duplicating the two-step dance and its token handling. Deletion test:
// yes, deleting this would mean re-copying the same logic into every media
// consumer — it earns its keep as a shared module.
//
// Trust note: the media ID here always comes from a message WhatsApp says
// was actually sent TO our bot — never from a customer-supplied URL — so
// this doesn't introduce the kind of arbitrary-fetch (SSRF) surface that
// postLinkResolver.ts is careful to avoid. We're always asking Meta's own
// Graph API to resolve an ID it issued us, not fetching some external
// address a customer chose.

export async function downloadWhatsAppMedia(
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
    return { buffer: await fileRes.arrayBuffer(), mimeType: meta.mime_type ?? "application/octet-stream" };
  } catch (err) {
    console.error("WhatsApp media download failed:", err);
    return undefined;
  }
}
