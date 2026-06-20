const skip =
    process.env.WAVETERM_SKIP_APP_DEPS === "1" || process.env.CF_PAGES === "1" || process.env.CF_PAGES === "true";

try {
    require("child_process").execSync("npx patch-package", { stdio: "inherit" });
} catch (e) {
    console.warn("postinstall: patch-package failed (non-fatal)");
}

if (skip) {
    console.log("postinstall: skipping electron-builder install-app-deps");
    process.exit(0);
}

import("child_process").then(({ execSync }) => {
    execSync("electron-builder install-app-deps", { stdio: "inherit" });
});
