import { makeMp4 } from "./mp4-fixture";
export function wav(seconds: number, sample: (i: number) => number = () => 0) {
  const samples = Math.round(seconds * 16000);
  const b = Buffer.alloc(44 + samples * 2);
  b.write("RIFF", 0); b.writeUInt32LE(b.length - 8, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36); b.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) b.writeInt16LE(sample(i), 44 + i * 2);
  return b;
}
export function fakePresenter(options: { pending?: boolean; short?: boolean; reject?: boolean; failed?: boolean; timeout?: boolean; badDownload?: boolean; reportedDuration?: number } = {}) {
  const calls: { url: string; body?: Record<string, unknown>; headers?: HeadersInit }[] = [];
  let seconds = 3;
  let posts = 0;
  const transport: typeof fetch = async (input, init) => {
    const url = String(input); const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body, headers: init?.headers });
    if (url.endsWith("/avatar_videos")) {
      posts++;
      if (options.timeout) throw Object.assign(new Error("secret-avatar-key data:audio/wav;base64,PRIVATE"), { name: "TimeoutError" });
      if (options.reject) return Response.json({ code: "quota_exceeded", message: "secret-avatar-key " + body.speech.audio }, { status: 429, headers: { "request-id": "req-rejected" } });
      const audio = Buffer.from(body.speech.audio.split(",")[1], "base64"); seconds = (audio.length - 44) / 32000;
      return Response.json({ id: `avatar_${posts}` }, { headers: { "request-id": `req-avatar-${posts}` } });
    }
    if (url.includes("/tasks/")) return Response.json({ id: url.split("/").pop(), status: options.pending ? "RUNNING" : options.failed ? "FAILED" : "SUCCEEDED",
      duration: options.reportedDuration, cost: { credits: Math.ceil(seconds / 3) }, output: ["https://cdn.runwayml.com/avatar.mp4"] });
    if (url === "https://cdn.runwayml.com/avatar.mp4") return new Response(options.badDownload ? "bad" : Buffer.from(makeMp4(options.short ? 0.2 : seconds)));
    throw new Error("Unexpected network request in fake presenter");
  };
  return { transport, calls, options, get posts() { return posts; } };
}
