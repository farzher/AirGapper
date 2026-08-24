// Thin decode-worker wrapper that exposes the exact lifetime of a transferred
// camera VideoFrame. The normal worker owns the frame and closes it immediately
// after copyTo(); this private stage message lets the page release copy-stage
// backpressure and switch from a short camera-buffer deadline to the normal
// decoder deadline without treating it as a decode completion.
let activeJobId;
const nativePostMessage = self.postMessage.bind(self);

if (typeof VideoFrame === "function" && typeof VideoFrame.prototype.copyTo === "function") {
  const nativeCopyTo = VideoFrame.prototype.copyTo;
  try {
    VideoFrame.prototype.copyTo = function(destination, options) {
      const jobId = activeJobId;
      const copied = nativeCopyTo.call(this, destination, options);
      return Promise.resolve(copied).then((planes) => {
        if (jobId !== undefined) {
          nativePostMessage({ __airgapperCameraCopyComplete: true, id: jobId });
        }
        return planes;
      });
    };
  } catch {}
}

const query = self.location.search || "";
await import(`./worker-rvfc.js${query}`);
const baseOnMessage = self.onmessage;
self.onmessage = (event) => {
  const id = event?.data?.id;
  activeJobId = id;
  const result = baseOnMessage?.call(self, event);
  Promise.resolve(result).finally(() => {
    if (activeJobId === id) activeJobId = undefined;
  });
  return result;
};
