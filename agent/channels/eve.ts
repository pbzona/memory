import { eveChannel } from "eve/channels/eve";
import { localDev, none } from "eve/channels/auth";

export default eveChannel({
  auth: [
    // Local dev servers only. Keeps the self-modification subagent available,
    // since eve offers it only to localDev() sessions.
    localDev(),
    // Public single-user showcase: anyone can chat. Add rate limiting or an
    // API key before exposing this broadly.
    none(),
  ],
});
