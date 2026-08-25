// Live decode workers enter through the camera-aware wrapper. The heavy decoder
// implementation lives in worker-core.js so worker-rvfc.js can import it
// directly without a global Worker constructor rewrite.
const query = self.location.search || "";
await import(`./worker-camera.js${query}`);
