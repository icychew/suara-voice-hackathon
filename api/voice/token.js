import { createVercelVoiceHandler } from "../../server/vercel-voice.mjs";

export default { fetch: createVercelVoiceHandler({ route: "/api/voice/token" }) };
