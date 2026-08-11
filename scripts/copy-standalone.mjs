import { copyFileSync, mkdirSync } from "node:fs";
mkdirSync("dist-standalone", { recursive: true });
copyFileSync("index.html", "dist-standalone/airgapper.html");
console.log("dist-standalone/airgapper.html matches the checked-in application");
