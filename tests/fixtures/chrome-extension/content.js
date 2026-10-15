document.documentElement.dataset.reaExtensionFixture = "loaded";
chrome.runtime.sendMessage({ kind: "rea-fixture-ping" });
