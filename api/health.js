import { createVercelHealthHandler } from "../server/vercel-health.mjs";

export default { fetch: createVercelHealthHandler() };
