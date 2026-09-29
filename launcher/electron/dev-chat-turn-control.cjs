const { randomUUID } = require("node:crypto");
const net = require("node:net");

function cancelDevChatTurn(socketPath, traceId, reason) {
  if (typeof socketPath !== "string" || socketPath.trim().length === 0) {
    return Promise.reject(new Error("DEV chat turn broker endpoint is unavailable"));
  }
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(traceId || "")) {
    return Promise.reject(new Error("DEV browser turn trace id is invalid"));
  }
  if (reason !== "account_security") {
    return Promise.reject(new Error("DEV browser turn cancellation reason is invalid"));
  }

  return new Promise((resolve, reject) => {
    const id = `request_${randomUUID().replaceAll("-", "")}`;
    const socket = net.createConnection(socketPath);
    let buffer = "";
    let settled = false;
    const timer = setTimeout(() => finish(new Error("DEV browser turn cancellation timed out")), 10_000);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };

    socket.setEncoding("utf8");
    socket.once("error", error => finish(new Error(`DEV browser turn cancellation failed: ${error.message}`)));
    socket.once("close", () => {
      if (!settled) finish(new Error("DEV browser turn broker closed without confirming cancellation"));
    });
    socket.once("connect", () => socket.write(`${JSON.stringify({
      id,
      method: "cancel_trace",
      traceId,
      reason,
    })}\n`));
    socket.on("data", chunk => {
      if (settled) return;
      buffer += chunk;
      if (buffer.length > 1_000_000) {
        finish(new Error("DEV browser turn broker response exceeded the size limit"));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      let response;
      try { response = JSON.parse(buffer.slice(0, newline)); }
      catch { finish(new Error("DEV browser turn broker returned invalid JSON")); return; }
      if (!response || response.id !== id || (("result" in response) === ("error" in response))) {
        finish(new Error("DEV browser turn broker returned an invalid response frame"));
        return;
      }
      if (typeof response.error === "string") {
        finish(new Error(`DEV browser turn cancellation failed: ${response.error}`));
        return;
      }
      const result = response.result;
      if (!result || !Number.isSafeInteger(result.cancelled_responses) || result.cancelled_responses < 0
        || !Number.isSafeInteger(result.revoked_turns) || result.revoked_turns < 0) {
        finish(new Error("DEV browser turn broker returned an incomplete cancellation receipt"));
        return;
      }
      finish(undefined, result);
    });
  });
}

module.exports = { cancelDevChatTurn };
