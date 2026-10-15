chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message.kind === "rea-fixture-ping") reply({ kind: "rea-fixture-pong" });
});
