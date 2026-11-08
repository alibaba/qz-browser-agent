// Windows has no cooperative child.kill('SIGINT'). Deliver through qz's own handler.
let pending = false;
const deliver = () => {
  if (!pending || process.listenerCount("SIGINT") === 0) return;
  pending = false;
  process.emit("SIGINT");
};
const cancel = () => { pending = true; deliver(); };
process.on("message", message => { if (message?.type === "qz.cancel") cancel(); });
process.on("disconnect", cancel);
process.on("newListener", name => { if (name === "SIGINT") queueMicrotask(deliver); });
process.channel?.unref();
