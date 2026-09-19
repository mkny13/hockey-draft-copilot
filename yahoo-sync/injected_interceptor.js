// Runs in the page's MAIN execution world to intercept live ESPN WebSocket draft messages
(function() {
  "use strict";

  console.log("[Draft Co-Pilot Interceptor] Initializing WebSocket hook in page context...");

  // Hook WebSocket to capture live draft socket messages
  const OriginalWebSocket = window.WebSocket;
  window.WebSocket = function(...args) {
    const ws = new OriginalWebSocket(...args);
    try {
      ws.addEventListener("message", function(event) {
        try {
          const raw = event.data;
          if (typeof raw === "string" && (raw.includes("draft") || raw.includes("pick") || raw.includes("select"))) {
            window.postMessage({ type: "COPILOT_RAW_MSG", payload: raw }, "*");
          }
        } catch (err) {}
      });
    } catch (e) {}
    return ws;
  };
  window.WebSocket.prototype = OriginalWebSocket.prototype;
})();
