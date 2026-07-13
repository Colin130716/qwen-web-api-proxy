(function () {
  console.log("[QwenProxy] Page script injected");
  var apiPath = "/api/v2/chat/completions";

  // ── Intercept fetch ──
  var origFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var url = typeof input === "string" ? input : (input && input.url) || "";
    if (url.indexOf(apiPath) !== -1) {
      console.log("[QwenProxy] Intercepted fetch:", url);
      var respPromise = origFetch(input, init);
      respPromise
        .then(function (resp) {
          if (!resp.ok || !resp.body) {
            console.warn("[QwenProxy] Response not OK:", resp.status);
            return;
          }
          var reader = resp.clone().body.getReader();
          var decoder = new TextDecoder();
          (async function () {
            while (true) {
              var result = await reader.read();
              if (result.done) {
                window.postMessage(
                  { source: "__qwen_proxy", type: "end" },
                  "*",
                );
                return;
              }
              var text = decoder.decode(result.value, { stream: true });
              window.postMessage(
                { source: "__qwen_proxy", type: "chunk", text: text },
                "*",
              );
            }
})();
        })
        .catch(function (err) {
          console.error("[QwenProxy] Fetch error:", err);
        });
    }
    return origFetch(input, init);
  };

  // ── Intercept XMLHttpRequest ──
  var OrigXHR = window.XMLHttpRequest;
  window.XMLHttpRequest = function () {
    var xhr = new OrigXHR();
    var origOpen = xhr.open.bind(xhr);
    var origSend = xhr.send.bind(xhr);
    var interceptedUrl = null;

    xhr.open = function (method, url) {
      interceptedUrl = typeof url === "string" ? url : "";
      return origOpen(method, url);
    };

    xhr.send = function (body) {
      if (interceptedUrl.indexOf(apiPath) !== -1) {
        console.log("[QwenProxy] Intercepted XHR:", interceptedUrl);
        var lastLen = 0;
        xhr.addEventListener("readystatechange", function () {
          if (xhr.readyState >= 3) {
            var newText = xhr.responseText.substring(lastLen);
            lastLen = xhr.responseText.length;
            if (newText)
              window.postMessage(
                { source: "__qwen_proxy", type: "chunk", text: newText },
                "*",
              );
          }
          if (xhr.readyState === 4) {
            window.postMessage(
              { source: "__qwen_proxy", type: "end" },
              "*",
            );
          }
        });
      }
      return origSend(body);
    };
    return xhr;
  };
})();
